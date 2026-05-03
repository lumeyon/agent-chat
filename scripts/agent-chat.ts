// agent-chat.ts — single-entry-point launcher for declaring this session's
// identity. Run from inside a Claude/Codex session as soon as the user says
// "you are <name>". Drops a per-session identity file the rest of the skill
// reads automatically; no env-var fiddling, no shell wrappers, no exports.
//
// Usage (run inside the session):
//   bun scripts/agent-chat.ts init <name> [<topology>] [--force] [--no-monitor]
//   bun scripts/agent-chat.ts exit                                (this session goes offline)
//   bun scripts/agent-chat.ts who                                 (list live agents on this host)
//   bun scripts/agent-chat.ts gc                                  (sweep dead session/presence files)
//   bun scripts/agent-chat.ts whoami                              (print my identity)
//   bun scripts/agent-chat.ts resolve [--json]                    (full edge listing — same as resolve.ts)
//
// The session is keyed by $CLAUDE_SESSION_ID (or $CLAUDE_CODE_SESSION_ID),
// falling back to the parent shell's pid. That's stable for the lifetime of
// one terminal/session and unique per terminal on a single host, which is
// exactly what we need to support N sessions sharing one cwd.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as child_process from "node:child_process";
import {
  loadTopology, listSessions, readSessionRecord, writeSessionRecord,
  deleteSessionRecord, currentSessionKey, sessionFile, presenceFile,
  ensureControlDirs, findLivePresence, findResumableSession, resumeKey,
  pidIsAlive, pidStarttime, processIsOriginal, stableSessionPid, processTag,
  utcStamp, edgesOf, neighborsOf, ensureEdgeFiles, lockTag, parseLockFile,
  readTurn, writeTurnAtomic, resolveIdentity, loadUsers,
  exclusiveWriteOrFail, writeFileAtomic, safeUnlink,
  SKILL_ROOT, SESSIONS_DIR, PRESENCE_DIR,
  LOGS_DIR, SOCKETS_DIR, logPathFor, socketPathFor, pidFilePath,
  CURRENT_SPEAKER_FILE_SUFFIX, currentSpeakerPath, readCurrentSpeaker,
  writeCurrentSpeaker, resolveDefaultSpeaker,
  type SessionRecord, type CurrentSpeaker, type DefaultSpeakerResolution,
} from "./lib.ts";
import { sidecarRequest } from "./sidecar-client.ts";

function die(msg: string, code = 2): never { console.error(msg); process.exit(code); }

function detectTty(): string | undefined {
  // Best-effort across platforms. process.stdout.isTTY tells us we're on a
  // terminal; the actual device path comes from $TTY (zsh/bash sets it) or
  // /proc/self/fd/0 readlink (Linux). Windows: undefined is fine — resume
  // keys still work via cwd alone.
  if (process.env.TTY) return process.env.TTY;
  try {
    const link = fs.readlinkSync("/proc/self/fd/0");
    if (link && link !== "pipe:" && !link.startsWith("/proc")) return link;
  } catch {}
  return undefined;
}

// Optional NFSv3 probe at init time: if /proc/self/mountinfo shows the
// CONVERSATIONS_DIR sits on an NFSv3 mount, warn the user. The wx-EXCL
// semantics this skill depends on are historically lossy on NFSv2/v3
// (server may report success when another client already holds the file).
// Sentinel S-MED-5 + pulsar's Q3 conclusion: "single-host filesystem only"
// is an explicit non-goal; this is the observability hook that catches
// users who accidentally cross that line.
function nfsv3ProbeWarn(): void {
  if (process.platform !== "linux") return;
  let mountinfo = "";
  try { mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return; }
  // Find the longest mount-point prefix matching CONVERSATIONS_DIR's resolved path.
  const target = (() => { try { return fs.realpathSync(SKILL_ROOT); } catch { return SKILL_ROOT; } })();
  let bestPrefix = "";
  let bestLine = "";
  for (const line of mountinfo.split("\n")) {
    // Format: <id> <parent> <maj:min> <root> <mount-point> <opts> ... - <fstype> <source> ...
    const fields = line.split(/\s+/);
    const mp = fields[4];
    if (!mp) continue;
    if (target === mp || target.startsWith(mp.endsWith("/") ? mp : mp + "/")) {
      if (mp.length > bestPrefix.length) { bestPrefix = mp; bestLine = line; }
    }
  }
  if (!bestLine) return;
  const dashIdx = bestLine.indexOf(" - ");
  if (dashIdx < 0) return;
  const tail = bestLine.slice(dashIdx + 3).split(/\s+/);
  const fstype = tail[0];
  if (fstype === "nfs" || fstype === "nfs3") {
    console.error(`[agent-chat] WARNING: ${SKILL_ROOT} is on an NFS mount (${fstype}). This skill is single-host-only; multi-host use can corrupt locks and cause gc to delete other hosts' state.`);
  } else if (fstype === "nfs4") {
    // NFSv4 has working O_EXCL — informational only.
    console.error(`[agent-chat] note: ${SKILL_ROOT} is on an NFSv4 mount. Single-host-only is supported; multi-host is still untested.`);
  }
}

function pickTopologyDefault(): string | null {
  // If exactly one topology is currently in use by other live sessions on
  // this host, use that. Saves the user typing it for sessions 2..N.
  const live = listSessions().filter((r) => processIsOriginal(r.pid, r.pid_starttime));
  const topos = new Set(live.map((r) => r.topology));
  if (topos.size === 1) return [...topos][0];
  return null;
}

function startMonitor(rec: SessionRecord): { pid: number; starttime: number | null } | undefined {
  // Background-launch the per-session monitor. It inherits the session-file
  // identity via $CLAUDE_SESSION_ID/PPID, so no env override needed. Stdout
  // redirected to a per-agent log so notifications don't disappear.
  // LOGS_DIR roots on CONVERSATIONS_DIR so AGENT_CHAT_CONVERSATIONS_DIR
  // overrides redirect log writes (carina/cadence P1 — pre-fix this used
  // path.join(SKILL_ROOT, "conversations", ".logs") and silently wrote into
  // the source tree even when the env-var-aware harness expected hermeticity).
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = logPathFor(rec.agent, "monitor");
  try {
    const out = fs.openSync(logPath, "a");
    // bun executable comes from the same runtime that's running this script.
    const runtime = process.execPath;
    // Pass the session key explicitly so the monitor's `resolveIdentity`
    // call hits the same record even when run as a child with a different
    // PPID. We use $CLAUDE_SESSION_ID to carry it.
    const env = {
      ...process.env,
      CLAUDE_SESSION_ID: rec.claude_session_id ?? rec.session_key,
    };
    const child = child_process.spawn(runtime, [path.join(SKILL_ROOT, "scripts", "monitor.ts")], {
      detached: true,
      stdio: ["ignore", out, out],
      env,
      cwd: SKILL_ROOT,
    });
    child.unref();
    fs.closeSync(out);
    if (!child.pid) return undefined;
    // Capture the kernel start_time of the spawned monitor so a later `exit`
    // / `gc` can confirm the recorded pid still belongs to OUR monitor and
    // hasn't been recycled to an unrelated process. Done synchronously here
    // so the call is in the parent's window before any pid-recycle could
    // happen.
    const starttime = pidStarttime(child.pid);
    return { pid: child.pid, starttime };
  } catch (err) {
    console.error(`[agent-chat] could not auto-launch monitor: ${(err as Error).message}`);
    return undefined;
  }
}

function stopMonitor(pid: number | undefined, starttime: number | null | undefined): void {
  // processIsOriginal returns false when the pid was recycled to a different
  // process. Without this check, `exit` could SIGTERM an unrelated process
  // that happens to have the recycled pid (cadence Q2).
  if (!pid || !processIsOriginal(pid, starttime)) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
}

// Background-launch the per-agent sidecar daemon. Mirrors startMonitor but
// spawns scripts/sidecar.ts. The sidecar opens a UDS for fast-path queries
// and (in slice 3+) runs the inotify-driven watcher. Co-exists with monitor.ts
// — both can run simultaneously without deadlock or double-emit (the monitor
// owns chat-notification stdout; the sidecar owns IPC + log).
function startSidecar(rec: SessionRecord): { pid: number; starttime: number | null } | undefined {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  const logPath = logPathFor(rec.agent, "sidecar");
  try {
    const out = fs.openSync(logPath, "a");
    const runtime = process.execPath;
    const env = {
      ...process.env,
      CLAUDE_SESSION_ID: rec.claude_session_id ?? rec.session_key,
    };
    const child = child_process.spawn(runtime, [path.join(SKILL_ROOT, "scripts", "sidecar.ts")], {
      detached: true,
      stdio: ["ignore", out, out],
      env,
      cwd: SKILL_ROOT,
    });
    child.unref();
    fs.closeSync(out);
    if (!child.pid) return undefined;
    const starttime = pidStarttime(child.pid);
    return { pid: child.pid, starttime };
  } catch (err) {
    console.error(`[agent-chat] could not auto-launch sidecar: ${(err as Error).message}`);
    return undefined;
  }
}

// Graceful sidecar shutdown via UDS, falling back to SIGTERM. The sidecar's
// `shutdown` method replies first, then exits — but if the UDS is wedged
// we still want to land a signal so the daemon doesn't outlive its session.
async function stopSidecar(rec: SessionRecord): Promise<void> {
  const pid = rec.sidecar_pid;
  const starttime = rec.sidecar_pid_starttime;
  if (!pid || !processIsOriginal(pid, starttime)) return;
  // Try graceful shutdown first.
  try {
    const r = await Promise.race([
      sidecarRequest(rec.agent, "shutdown", {}, { timeoutMs: 500 }),
      new Promise<{ ok: false; error: { code: string; message: string } }>((res) =>
        setTimeout(() => res({ ok: false, error: { code: "E_TIMEOUT", message: "graceful timeout" } }), 500),
      ),
    ]);
    if (r.ok) {
      // Give the sidecar a moment to actually exit after responding.
      await new Promise((res) => setTimeout(res, 150));
    }
  } catch {}
  // Final SIGTERM if it's still alive.
  if (processIsOriginal(pid, starttime)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

// ----- subcommands ---------------------------------------------------------

function cmdInit(args: string[]): void {
  nfsv3ProbeWarn();
  const positional: string[] = [];
  let force = false;
  let noMonitor = false;
  // Sidecar defaults ON (slice 5 cutover). Pass --no-sidecar to disable —
  // useful for CI / debug or if a platform's fs.watch turns out to misbehave.
  // --with-sidecar is accepted as a no-op for backwards compat with slice-1
  // callers that explicitly opted in.
  let noSidecar = false;
  for (const a of args) {
    if (a === "--force") force = true;
    else if (a === "--no-monitor") noMonitor = true;
    else if (a === "--with-sidecar") { /* default-on; accept as a no-op */ }
    else if (a === "--no-sidecar") noSidecar = true;
    else positional.push(a);
  }
  const [name, topologyArg] = positional;
  if (!name) die("usage: agent-chat.ts init <name> [<topology>] [--force] [--no-monitor] [--no-sidecar]");

  // Resume offer: same cwd + same tty + dead prior pid → propose reusing
  // last identity rather than declaring a new one.
  const cwd = process.cwd();
  const tty = detectTty();
  const rk = resumeKey(cwd, tty);
  const resumable = findResumableSession(rk);

  // Determine topology.
  let topology = topologyArg;
  if (!topology && resumable && resumable.agent === name) {
    topology = resumable.topology;
    console.error(`[agent-chat] resume: reusing topology "${topology}" from prior session in this terminal.`);
  }
  if (!topology) {
    topology = pickTopologyDefault() ?? "";
    if (topology) console.error(`[agent-chat] inferring topology="${topology}" (only one live topology on this host).`);
  }
  if (!topology) {
    die(`topology required — pick one from agents.*.yaml in ${SKILL_ROOT}, e.g. \`agent-chat init ${name} petersen\`.`);
  }

  // Validate name is in topology.
  const topo = loadTopology(topology);
  if (!topo.agents.includes(name)) {
    die(`agent "${name}" is not declared in topology "${topology}". Known agents: ${topo.agents.join(", ")}`);
  }

  // Slice-2 refactor: resolve default speaker EARLY — before any state writes.
  // cadence slice-2-refactor recommendation: place the resolve-or-fail check
  // immediately after agent-name validation so a bad $AGENT_CHAT_USER fails
  // BEFORE writeSessionRecord/startSidecar/startMonitor; failure path then
  // needs zero cleanup. The resolved name (if non-null) is written by splice
  // point #4 below, AFTER spawn, via exclusiveWriteOrFail (pulsar's wx-on-
  // destination single-syscall CAS so an explicit `agent-chat speaker <name>`
  // landing inside the auto-resolve window is preserved as the "explicit
  // wins" invariant requires).
  const speakerResolution: DefaultSpeakerResolution = resolveDefaultSpeaker();
  if (speakerResolution.error) {
    die(`[agent-chat] ${speakerResolution.error}`, 65);
  }

  // Collision check.
  const existing = findLivePresence(name);
  const sessionKey = currentSessionKey();
  if (existing && existing.session_key !== sessionKey && !force) {
    die(
      `agent "${name}" is already live as ${existing.agent}@${existing.host}:${existing.pid} ` +
      `(session ${existing.session_key}, started ${existing.started_at}). ` +
      `Pick a different name, or pass --force if you're sure that session is dead.`,
    );
  }

  // If resumable matches the requested name, offer informational context.
  // Also wipe any stale current_speaker from the prior session on the same
  // terminal: speaker is conversational state (cadence slice-2 round —
  // "speaker is conversational state, not durable identity"), and a re-init
  // implies the human picked up a new session. Live in the resume-prompt
  // path explicitly so the wipe doesn't fire on first-init-no-resumable.
  if (resumable && resumable.agent === name && resumable.topology === topology) {
    console.error(`[agent-chat] resume: prior session for ${name}@${topology} in this terminal is gone — taking over identity.`);
    safeUnlink(currentSpeakerPath(resumable.session_key));
  } else if (resumable && (resumable.agent !== name || resumable.topology !== topology)) {
    console.error(`[agent-chat] note: this terminal previously hosted ${resumable.agent}@${resumable.topology}; new identity is ${name}@${topology}.`);
    safeUnlink(currentSpeakerPath(resumable.session_key));
    deleteSessionRecord(resumable);
  }

  // Build the record.
  const sessionPid = stableSessionPid();
  const rec: SessionRecord = {
    agent: name,
    topology,
    session_key: sessionKey,
    claude_session_id: process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined,
    host: os.hostname(),
    // stableSessionPid walks the process tree to find the long-lived agent
    // runtime ancestor (Claude Code main process), so the recorded pid is
    // alive throughout the user's session — not just for this bun invocation.
    pid: sessionPid,
    pid_starttime: pidStarttime(sessionPid) ?? undefined,
    started_at: utcStamp(),
    cwd,
    tty,
  };

  // Auto-launch sidecar BEFORE monitor so the sidecar's UDS is up by the time
  // anything else queries it. Default-on; --no-sidecar opts out.
  if (!noSidecar) {
    const s = startSidecar(rec);
    if (s) {
      rec.sidecar_pid = s.pid;
      rec.sidecar_pid_starttime = s.starttime ?? undefined;
    }
  }
  // Auto-launch monitor unless --no-monitor.
  if (!noMonitor) {
    const m = startMonitor(rec);
    if (m) {
      rec.monitor_pid = m.pid;
      rec.monitor_pid_starttime = m.starttime ?? undefined;
    }
  }

  // Write session + presence records. The session file is keyed by
  // session_key (unique per agent runtime instance), but concurrent
  // *readers* (cmdWho, cmdGc, --whoami, findResumableSession) can land
  // mid-write and used to see an empty/partial JSON window with a plain
  // truncating write — atomic write closes that gap (lyra round-2 Q3).
  // The presence file is keyed by agent name and IS contended across
  // sessions; use exclusive-create with EEXIST handling to prevent the
  // TOCTOU race where two concurrent inits both pass the collision check
  // above and then both write.
  ensureControlDirs();
  const fs2 = require("node:fs") as typeof import("node:fs");
  writeFileAtomic(sessionFile(rec.session_key), JSON.stringify(rec, null, 2) + "\n");
  const presencePath = presenceFile(rec.agent);
  const presenceJson = JSON.stringify(rec, null, 2) + "\n";
  try {
    exclusiveWriteOrFail(presencePath, presenceJson);
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    // Race: another writer landed between our collision check and our wx
    // call. Re-read and decide what to do.
    let existing: SessionRecord | null = null;
    try { existing = JSON.parse(fs2.readFileSync(presencePath, "utf8")) as SessionRecord; } catch {}
    const isMe = existing && existing.session_key === rec.session_key;
    const isDead = existing && !processIsOriginal(existing.pid, existing.pid_starttime);
    // Loud warning when --force overrides a still-live presence record.
    // Silent clobber was carina Q1b — last writer wins with no signal.
    if (force && existing && !isMe && !isDead) {
      console.error(
        `[agent-chat] WARNING: --force is overriding LIVE presence ` +
        `${existing.agent}@${existing.host}:${existing.pid} (session ${existing.session_key}, ` +
        `started ${existing.started_at}). The displaced session will lose its identity.`,
      );
      // Clean up the displaced session record too so `who` doesn't show split state.
      try { fs2.unlinkSync(sessionFile(existing.session_key)); } catch {}
    }
    if (isMe || isDead || force) {
      // Slice-2 refactor: pulsar's pid-reuse stale-speaker poisoning fix —
      // when we're replacing a dead-pid SessionRecord, the displaced
      // session's current_speaker.json may still be on disk. Without the
      // unlink, our auto-write splice (#4 below) sees existsSync→true via
      // the wx EEXIST branch and preserves the STALE speaker for the new
      // session. Symmetric with the displaced-session record cleanup at
      // line ~369. cadence's same-key resume path already covers the
      // resumable-prompt branch separately at line ~284.
      if (existing) {
        try { safeUnlink(currentSpeakerPath(existing.session_key)); } catch {}
      }
      fs2.unlinkSync(presencePath);
      exclusiveWriteOrFail(presencePath, presenceJson);
    } else if (existing) {
      // Genuinely concurrent live claim. Roll back our session file and refuse.
      try { fs2.unlinkSync(sessionFile(rec.session_key)); } catch {}
      die(
        `agent "${name}" was just claimed concurrently as ${existing.agent}@${existing.host}:${existing.pid} ` +
        `(session ${existing.session_key}, started ${existing.started_at}). ` +
        `Pick a different name, or pass --force if you're sure that session is dead.`,
      );
    } else {
      // EEXIST but unparsable — replace and continue.
      fs2.unlinkSync(presencePath);
      exclusiveWriteOrFail(presencePath, presenceJson);
    }
  }

  // Slice-2 refactor: auto-write the resolved default speaker. exclusiveWriteOrFail
  // (wx) on the destination path is a single-syscall CAS (pulsar's load-bearing
  // recommendation): if a `agent-chat speaker <name>` invocation landed in the
  // sub-second window between init's resolve check and this write, EEXIST tells
  // us the explicit choice already won; we leave it alone. "Explicit always
  // wins" invariant is preserved at the kernel layer with no .lock needed.
  if (speakerResolution.name) {
    const speakerJson = JSON.stringify(
      { name: speakerResolution.name, set_at: utcStamp() },
      null,
      2,
    ) + "\n";
    const speakerPath = currentSpeakerPath(rec.session_key);
    try {
      // mode 0o600 applied at create time (single openSync syscall) — closes
      // the chmod-race window where a concurrent reader could see the file
      // at default umask 0o644 between create and chmod (lumeyon Phase-4
      // review of the multi-user refactor; same threat model as the
      // 0o600-on-per-session-files invariant).
      exclusiveWriteOrFail(speakerPath, speakerJson, { mode: 0o600 });
      console.error(
        `[agent-chat] speaker auto-resolved to ${speakerResolution.name} ` +
        `(source: ${speakerResolution.source})`,
      );
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // Explicit `agent-chat speaker <name>` won the wx race. Leave their
      // value alone; just log the skip so an operator can debug without
      // needing to grep stderr by hand.
      const explicit = readCurrentSpeaker(rec.session_key);
      if (explicit) {
        console.error(
          `[agent-chat] speaker already set to ${explicit.name} ` +
          `(explicit; auto-resolve to ${speakerResolution.name} from ${speakerResolution.source} skipped)`,
        );
      }
    }
  }

  console.log(`✓ this session is ${name}@${topology}`);
  console.log(`  session_key: ${sessionKey}`);
  console.log(`  pid:         ${rec.pid}`);
  console.log(`  cwd:         ${cwd}`);
  if (rec.monitor_pid) {
    console.log(`  monitor:     pid ${rec.monitor_pid} (background; writes to ${logPathFor(name, "monitor")})`);
  } else {
    console.log(`  monitor:     not launched (--no-monitor)`);
  }
  if (rec.sidecar_pid) {
    console.log(`  sidecar:     pid ${rec.sidecar_pid} (background; UDS ${socketPathFor(name)}, log ${logPathFor(name, "sidecar")})`);
  } else if (noSidecar) {
    console.log(`  sidecar:     not launched (--no-sidecar)`);
  } else {
    console.log(`  sidecar:     not launched (spawn failed)`);
  }
  // Print neighbors so the user immediately sees who they can talk to.
  const edges = edgesOf(topo, name);
  console.log(`  neighbors (${edges.length}): ${edges.map((e) => e.peer).join(", ")}`);
  // CRITICAL: notification delivery. The background monitor writes to a
  // file; that file is invisible to Claude Code's chat unless something
  // tails it via the Monitor tool. Print explicit instructions so the
  // agent knows the next step.
  if (process.env.CLAUDECODE === "1") {
    const monitorScript = path.join(SKILL_ROOT, "scripts", "monitor.ts");
    console.log("");
    console.log("NEXT STEP — deliver notifications to chat:");
    console.log("  Invoke Claude Code's Monitor tool with persistent: true on:");
    console.log(`    bun ${monitorScript}`);
    console.log("  Each turn-flip / park / CONVO.md change becomes a chat notification.");
    console.log("  Without this step, monitor events go ONLY to the log file and");
    console.log("  you (the agent) will not be told when peers respond.");
  }
}

// Auto-archive every parked edge in this session whose CONVO.md has grown
// past the line threshold. Shells out to `archive.ts auto <peer>` per
// edge. Per-edge spawn cost is ~50ms; total cost for a typical session
// (3-15 edges) is sub-second. The shell-out is intentional: it gives us
// the same lock acquisition + validator path as a manual `archive.ts auto`
// invocation without duplicating the seal/commit logic.
//
// Returns the count of edges archived. Caller logs the summary so the
// behavior is visible in `agent-chat exit` / `gc --auto-archive` stdout.
function autoArchiveSessionEdges(rec: SessionRecord, threshold: number): number {
  const topo = (() => { try { return loadTopology(rec.topology); } catch { return null; } })();
  if (!topo) return 0;
  const edges = edgesOf(topo, rec.agent);
  let archived = 0;
  for (const edge of edges) {
    if (!fs.existsSync(edge.convo)) continue;
    if (readTurn(edge.turn) !== "parked") continue;
    let lines = 0;
    try { lines = fs.readFileSync(edge.convo, "utf8").split("\n").length; } catch { continue; }
    if (lines < threshold) continue;
    // Inherit the session's identity via env (CLAUDE_SESSION_ID + topology
    // override) so the spawned `archive.ts auto` resolveIdentity hits the
    // same record this session is operating under.
    const env = {
      ...process.env,
      CLAUDE_SESSION_ID: rec.claude_session_id ?? rec.session_key,
    };
    const r = child_process.spawnSync(
      process.execPath,
      [path.join(SKILL_ROOT, "scripts", "archive.ts"), "auto", edge.peer],
      { env, cwd: SKILL_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    if (r.status === 0) {
      archived++;
      const m = (r.stdout ?? "").match(/auto-archived (\S+)/);
      console.error(`[agent-chat] auto-archived ${edge.peer} edge (${lines} lines) → ${m ? m[1] : "(id?)"}`);
    } else {
      // Non-fatal — log and continue. Common benign cases: nothing-to-archive
      // (CONVO is already at fresh-tail), uncommitted-pending blocking auto.
      const reason = (r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`;
      console.error(`[agent-chat] auto-archive of ${edge.peer} skipped: ${reason}`);
    }
  }
  return archived;
}

async function cmdExit(args: string[]): Promise<void> {
  const noAutoArchive = args.includes("--no-auto-archive");
  const thresholdArg = args.find((a) => a.startsWith("--archive-threshold="));
  const threshold = thresholdArg ? parseInt(thresholdArg.split("=")[1], 10) : 200;

  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (!rec) {
    console.log(`no active session for key ${key} — nothing to do.`);
    return;
  }
  // Auto-archive parked-and-bloated edges BEFORE tearing down daemons so
  // any sealed leaf is durable on disk before the sidecar/monitor stop.
  // Default-on; --no-auto-archive opts out for sessions that prefer to
  // archive manually.
  if (!noAutoArchive) {
    const n = autoArchiveSessionEdges(rec, threshold);
    if (n > 0) console.log(`✓ auto-archived ${n} parked edge(s) before exit`);
  }
  // Stop sidecar BEFORE monitor so the sidecar's graceful shutdown can land
  // before anything else changes state. The sidecar self-cleans its socket +
  // pidfile on graceful exit; if it didn't (kill -9 mid-shutdown), gc reclaims.
  await stopSidecar(rec);
  stopMonitor(rec.monitor_pid, rec.monitor_pid_starttime);
  // Also drop any current_speaker.json — it's session-scoped live state, not
  // durable identity. cadence slice-2 round flagged this lifecycle: clean
  // exit means no consumer should see a stale speaker. safeUnlink (not
  // unlinkSync) tolerates a peer race per cadence's F4-class concern.
  safeUnlink(currentSpeakerPath(key));
  deleteSessionRecord(rec);
  console.log(`✓ ${rec.agent}@${rec.topology} signed out (session ${key})`);
}

function cmdWho(_args: string[]): void {
  const live: SessionRecord[] = [];
  const stale: SessionRecord[] = [];
  for (const rec of listSessions()) {
    if (processIsOriginal(rec.pid, rec.pid_starttime)) live.push(rec);
    else stale.push(rec);
  }
  if (!live.length && !stale.length) { console.log("no sessions on file."); return; }
  if (live.length) {
    console.log(`live (${live.length}):`);
    for (const r of live.sort((a, b) => a.agent.localeCompare(b.agent))) {
      const monStatus = r.monitor_pid
        ? (processIsOriginal(r.monitor_pid, r.monitor_pid_starttime) ? `mon=${r.monitor_pid}` : `mon=GONE`)
        : "mon=-";
      const sideStatus = r.sidecar_pid
        ? (processIsOriginal(r.sidecar_pid, r.sidecar_pid_starttime) ? `side=${r.sidecar_pid}` : `side=GONE`)
        : "side=-";
      console.log(`  ${r.agent.padEnd(10)} @ ${r.host}:${r.pid}  topo=${r.topology}  ${monStatus}  ${sideStatus}  started=${r.started_at}`);
    }
  }
  if (stale.length) {
    console.log(`stale (${stale.length}; pid gone — run \`agent-chat gc\` to remove):`);
    for (const r of stale.sort((a, b) => a.agent.localeCompare(b.agent))) {
      console.log(`  ${r.agent.padEnd(10)} @ ${r.host}:${r.pid}  topo=${r.topology}  started=${r.started_at}`);
    }
  }
}

// safeUnlink moved to lib.ts (slice-2 refactor — single source of truth so
// sidecar.ts and tests can use it without importing from agent-chat.ts).
// Original rationale (cadence Q4 / P0 Major #1): concurrent gc passes used
// to crash here when one peer's unlinkSync hit a file another peer had just
// removed; ENOENT-tolerance kept the sweep from aborting mid-loop.

function cmdGc(args: string[]): void {
  const pruneLogs = args.includes("--prune-logs");
  const autoArchive = args.includes("--auto-archive");
  const thresholdArg = args.find((a) => a.startsWith("--archive-threshold="));
  const threshold = thresholdArg ? parseInt(thresholdArg.split("=")[1], 10) : 200;
  // --auto-archive runs the same per-edge auto-archive sweep as
  // `agent-chat exit` but for the CURRENT live session (so a long-running
  // session can periodically seal old parked edges without exiting). Uses
  // the current session's identity; org-wide cleanup means running gc
  // from each session in turn.
  if (autoArchive) {
    const key = currentSessionKey();
    const rec = readSessionRecord(key);
    if (rec) {
      const n = autoArchiveSessionEdges(rec, threshold);
      if (n > 0) console.log(`gc: auto-archived ${n} parked edge(s) for ${rec.agent}@${rec.topology}`);
      else console.log(`gc: no parked edges over ${threshold} lines for ${rec.agent}@${rec.topology}`);
    } else {
      console.error(`gc: --auto-archive requires an active session record (run \`agent-chat init\` first); skipping the archive sweep.`);
    }
  }
  let removed = 0;
  const myHost = os.hostname();
  for (const rec of listSessions()) {
    // Foreign-host records belong to a peer machine sharing the
    // filesystem — we have no authority to GC them. See cadence F8 (P0 #2).
    if (rec.host !== myHost) continue;
    if (!processIsOriginal(rec.pid, rec.pid_starttime)) {
      const monStillThere = rec.monitor_pid && processIsOriginal(rec.monitor_pid, rec.monitor_pid_starttime);
      stopMonitor(rec.monitor_pid, rec.monitor_pid_starttime);
      // Same defense for the sidecar: kill if still original, then unlink
      // its socket + pidfile so a future init doesn't see a stale lockout.
      const sideStillThere = rec.sidecar_pid && processIsOriginal(rec.sidecar_pid, rec.sidecar_pid_starttime);
      if (sideStillThere) {
        try { process.kill(rec.sidecar_pid!, "SIGTERM"); } catch {}
      }
      try { safeUnlink(socketPathFor(rec.agent)); } catch {}
      try { safeUnlink(pidFilePath(rec.agent, "sidecar")); } catch {}
      // Slice-2 (multi-user): drop the stale current_speaker.json next to
      // the session record. Folded into the session-pass per cadence's
      // recommendation — keeps the "session is dead" decision colocated and
      // inherits Major #1 (safeUnlink ENOENT-tolerant) and Major #2
      // (multi-host skip via the foreign-host continue above) for free.
      try { safeUnlink(currentSpeakerPath(rec.session_key)); } catch {}
      deleteSessionRecord(rec);
      const sideAnnotation = rec.sidecar_pid
        ? `; sidecar pid ${rec.sidecar_pid} ${sideStillThere ? "killed" : "already gone"}`
        : "";
      console.log(`gc: removed stale ${rec.agent}@${rec.topology} (pid ${rec.pid} gone${rec.monitor_pid ? `; monitor pid ${rec.monitor_pid} ${monStillThere ? "killed" : "already gone"}` : ""}${sideAnnotation})`);
      removed++;
    }
  }
  // Slice-2 defense-in-depth: orphan current_speaker.json files whose
  // session_key has no matching SessionRecord at all (e.g. user manually
  // `rm`'d the session record but the speaker file remained). The
  // session-pass above catches the common case (live session record + dead
  // pid); this pass catches the manual-rm / file-corruption tail. cadence
  // slice-2 round explicitly recommended this as a 5-LoC addition.
  if (fs.existsSync(SESSIONS_DIR)) {
    const liveKeys = new Set(listSessions().map((r) => r.session_key));
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(CURRENT_SPEAKER_FILE_SUFFIX)) continue;
      // Reverse the sanitization in currentSpeakerPath: strip the suffix and
      // use the remainder as the session_key candidate. Sanitization replaces
      // characters with "_" so the round-trip isn't byte-perfect for
      // non-conformant keys, but the only purpose here is to test "is this
      // tail-aligned to a live session_key" — which `liveKeys.has` does.
      const key = f.slice(0, -CURRENT_SPEAKER_FILE_SUFFIX.length);
      if (liveKeys.has(key)) continue;
      const fp = path.join(SESSIONS_DIR, f);
      if (safeUnlink(fp)) {
        console.log(`gc: removed orphan speaker file ${f} (no matching session record)`);
        removed++;
      }
    }
  }
  // Defense-in-depth: orphan sockets/pidfiles whose pidfile points to a dead
  // (or recycled) pid. These can occur when a sidecar was killed -9 outside
  // of `agent-chat exit`. Three-step pass: (a) read pidfile, (b) check
  // processIsOriginal, (c) safeUnlink socket + pidfile. Foreign-host check
  // not needed — sockets are always local-host artifacts.
  if (fs.existsSync(SOCKETS_DIR)) {
    for (const f of fs.readdirSync(SOCKETS_DIR)) {
      const m = f.match(/^sidecar-([A-Za-z0-9_-]+)\.pid$/);
      if (!m) continue;
      const agent = m[1];
      const fp = path.join(SOCKETS_DIR, f);
      let pid = 0;
      let st: number | null = null;
      try {
        const text = fs.readFileSync(fp, "utf8").trim();
        const pm = text.match(/^(\d+)\s+(\d+)/);
        if (pm) {
          pid = parseInt(pm[1], 10);
          const s = parseInt(pm[2], 10);
          st = s > 0 ? s : null;
        }
      } catch (e: any) {
        if (e?.code === "ENOENT") continue;
      }
      if (pid > 0 && processIsOriginal(pid, st ?? undefined)) continue;  // live, leave alone
      // Stale: reclaim socket + pidfile.
      try { safeUnlink(socketPathFor(agent)); } catch {}
      if (safeUnlink(fp)) {
        console.log(`gc: removed stale sidecar pidfile + socket for ${agent} (pid ${pid || "?"} gone)`);
        removed++;
      }
    }
  }
  // Also sweep presence files whose pid is dead (defense in depth).
  if (fs.existsSync(PRESENCE_DIR)) {
    for (const f of fs.readdirSync(PRESENCE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(PRESENCE_DIR, f);
      // Read+parse can ENOENT mid-loop if another gc just unlinked it; treat
      // as a peer-handled entry and skip. This catch is intentionally narrow:
      // it covers parse errors AND ENOENT, NOT the unlinkSync below.
      let rec: SessionRecord;
      try { rec = JSON.parse(fs.readFileSync(fp, "utf8")) as SessionRecord; }
      catch (e: any) {
        if (e?.code === "ENOENT") continue;
        // Unparseable presence file — clean it up. safeUnlink tolerates a
        // racing peer having already done so.
        if (safeUnlink(fp)) { console.log(`gc: removed unparseable presence ${f}`); removed++; }
        continue;
      }
      if (rec.host !== myHost) continue;          // foreign host: not ours to GC
      if (!processIsOriginal(rec.pid, rec.pid_starttime)) {
        if (safeUnlink(fp)) {
          console.log(`gc: removed orphan presence ${f}`);
          removed++;
        }
      }
    }
  }
  // --prune-logs: remove monitor + sidecar log files for agents that no
  // longer have a live session OR a presence record on this host. Nothing
  // else cleans these up; long-running boxes accumulate them. Keep ALL logs
  // for currently-live agents (cadence F9 / P3 cleanup).
  // LOGS_DIR is rooted on CONVERSATIONS_DIR (carina/cadence P1 fix); pre-fix
  // this used path.join(SKILL_ROOT, "conversations", ".logs") and silently
  // pruned host logs from inside hermetic test sandboxes.
  if (pruneLogs) {
    if (fs.existsSync(LOGS_DIR)) {
      const liveAgents = new Set<string>();
      for (const r of listSessions()) if (processIsOriginal(r.pid, r.pid_starttime) && r.host === myHost) liveAgents.add(r.agent);
      for (const f of fs.readdirSync(LOGS_DIR)) {
        const m = f.match(/^(monitor|sidecar)-([A-Za-z0-9_-]+)\.log$/);
        if (!m) continue;
        if (liveAgents.has(m[2])) continue;
        if (safeUnlink(path.join(LOGS_DIR, f))) { console.log(`gc: pruned ${m[1]} log ${f}`); removed++; }
      }
    }
  }
  if (!removed) console.log("gc: nothing to remove.");
}

async function cmdWhoami(_args: string[]): Promise<void> {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (rec) {
    // Fast-path through sidecar when running (saves a session-file read on
    // every invocation). Falls back to the file-direct line on any error.
    // current_speaker comes from the sidecar's response when available
    // (sidecar reads the file fresh each dispatch — Bug 1 generalization),
    // or file-direct via readCurrentSpeaker on the fallback path.
    const r = await sidecarRequest<any>(rec.agent, "whoami", {}, { timeoutMs: 200 });
    if (r.ok) {
      const speaker = r.result.current_speaker?.name ?? readCurrentSpeaker(key)?.name ?? "-";
      console.log(`${r.result.agent}@${r.result.topology}  session_key=${key}  pid=${rec.pid}  monitor=${rec.monitor_pid ?? "-"}  sidecar=${r.result.sidecar_pid}  speaker=${speaker}  uptime=${r.result.uptime_ms}ms`);
      return;
    }
    const speaker = readCurrentSpeaker(key)?.name ?? "-";
    console.log(`${rec.agent}@${rec.topology}  session_key=${key}  pid=${rec.pid}  monitor=${rec.monitor_pid ?? "-"}  sidecar=${rec.sidecar_pid ?? "-"}  speaker=${speaker}`);
    return;
  }
  // Fall through to env / .agent-name resolution to give a useful answer.
  try {
    const { resolveIdentity } = require("./lib.ts");
    const id = resolveIdentity();
    console.log(`${id.name}@${id.topology}  (no session record; resolved via ${id.source})`);
  } catch (err) {
    console.error(`(no identity resolved — run \`agent-chat init <name>\`)`);
    process.exit(2);
  }
}

// ----- speaker (slice 2: multi-user transparency) -------------------------
//
// `speaker <name>` declares which human is currently typing in this Claude
// Code session. State persists in conversations/.sessions/<key>.current_speaker.json
// (live state only; durable speaker history lives in CONVO.md handoff
// sections owned by keystone's record-turn dispatcher, not here). 0-arg
// reads the current value; --clear unsets. Validation: name must be in
// the active topology's agents list and must not equal `id.name` (a
// self-edge would be a degenerate AI-talks-to-itself routing).
//
// Schema rationale: pulsar slice-2 round flagged a `prev` field as a
// read-modify-write race surface; cadence flagged it as scope-creep.
// Dropped. Audit trail is keystone's CONVO.md handoff sections.

function cmdSpeaker(args: string[]): void {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (!rec) {
    die(`no active session for key ${key} — run \`agent-chat init <name>\` first.`);
  }
  if (args.length === 0) {
    const cur = readCurrentSpeaker(key);
    if (!cur) console.log("(no speaker set)");
    else console.log(`${cur.name}  set_at=${cur.set_at}`);
    return;
  }
  if (args.length === 1 && args[0] === "--clear") {
    const cur = readCurrentSpeaker(key);
    const removed = safeUnlink(currentSpeakerPath(key));
    if (removed && cur) {
      console.error(`[agent-chat] speaker cleared (was ${cur.name})`);
    } else if (removed) {
      console.error(`[agent-chat] speaker cleared`);
    } else {
      console.error(`[agent-chat] speaker was already not set`);
    }
    return;
  }
  if (args.length !== 1 || args[0].startsWith("--")) {
    die("usage: agent-chat.ts speaker [<name> | --clear]");
  }
  const name = args[0];
  // Validate against the active topology's agents list. Inline check —
  // shared isAgentInTopology helper deferred per orion's Phase-2 cross-slice
  // tension #2 resolution ("keep validation inline; add a helper if a third
  // caller materializes").
  const topo = loadTopology(rec.topology);
  if (!topo.agents.includes(name)) {
    die(`speaker "${name}" is not a declared agent in topology "${rec.topology}". Known agents: ${topo.agents.join(", ")}`);
  }
  // No self-edge: setting the speaker to the same name as the AI session
  // would yield an alphabetical edge id of `<name>-<name>` which canonicalizes
  // to a degenerate self-loop. Refuse loudly.
  if (name === rec.agent) {
    die(`speaker "${name}" is the same as this session's agent identity (${rec.agent}); a self-edge is not meaningful.`);
  }
  const prev = readCurrentSpeaker(key);
  writeCurrentSpeaker(key, name);
  if (prev) {
    console.error(`[agent-chat] speaker: ${prev.name} → ${name}`);
  } else {
    console.error(`[agent-chat] speaker: ${name}`);
  }
}

// ----- record-turn (slice 3) ----------------------------------------------
//
// `record-turn` is the multi-user dispatcher: it reads the current speaker
// (set by `agent-chat speaker`, slice 2) and the AI agent's identity
// (resolveIdentity), then appends a (user-turn, assistant-response) section
// pair to the appropriate <speaker>-<agent> edge with the standard lock +
// flip cycle.
//
// v1 wire shape: agents run this CLI at end of every assistant response.
// Claude Code's `Stop` hook fires only at session end (no per-turn payload),
// so a hook-driven path is deferred to a future PostResponse hook (see
// docs/HOOK_REQUEST.md).
//
// Idempotency: per-edge `recorded_turns.jsonl` ledger keyed by sha256 of
// (speaker + user_prompt + assistant_response). A second invocation with
// the same payload is a silent no-op so retried hook calls don't double-write.

function recordedTurnsLedger(edgeDir: string): string {
  return path.join(edgeDir, "recorded_turns.jsonl");
}

// Read current_speaker via sidecar fast-path (carina's `speaker` UDS method)
// with file-direct fallback (carina's lib-exported `readCurrentSpeaker`).
// Returns the speaker name or null. Renamed from the obvious `readSpeaker`
// to avoid shadowing the lib-exported sync helper of the same name.
async function fetchSpeaker(agent: string, key: string): Promise<string | null> {
  // Sidecar `speaker` UDS method returns `{ current_speaker: {name, set_at} | null }`
  // — the field is nested under `current_speaker`. Pre-fix, this read
  // `r.result.name` (always undefined) and silently fell through to the
  // file-direct path on every call, defeating the dedicated UDS optimization
  // that motivated shipping the method in slice 2. Caught at Phase-4
  // cross-review by carina (multi-user rollout).
  const r = await sidecarRequest<any>(agent, "speaker", {}, { timeoutMs: 200 });
  if (r.ok && r.result?.current_speaker?.name) return r.result.current_speaker.name as string;
  return readCurrentSpeaker(key)?.name ?? null;
}

function turnHash(speaker: string, user: string, assistant: string): string {
  const h = crypto.createHash("sha256");
  h.update(speaker + "\n" + user + "\n" + assistant);
  return h.digest("hex");
}

function alreadyRecorded(ledgerPath: string, sha256: string): boolean {
  if (!fs.existsSync(ledgerPath)) return false;
  const text = fs.readFileSync(ledgerPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { if (JSON.parse(line)?.sha256 === sha256) return true; } catch {}
  }
  return false;
}

function appendLedger(
  ledgerPath: string,
  entry: { sha256: string; ts: string; speaker: string; agent: string },
): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
  try { fs.chmodSync(ledgerPath, 0o600); } catch {}
}

// Take the floor on an edge under speaker-switch / user-typed-prompt
// authorization. The OLD-edge handoff write needs this because the prior
// .turn points at the leaving speaker; the NEW-edge normal flow needs it
// because the speaker had the floor before they typed. Both are equivalent
// to the user-authorized atomic .turn rename pattern documented for
// upgrade-ping unparks. Returns true if the edge ended up with .turn=agent
// (or already was), false if the edge was uninitialized.
function authorityTakeFloor(turnFile: string, agent: string): boolean {
  const cur = fs.existsSync(turnFile) ? fs.readFileSync(turnFile, "utf8").trim() : null;
  if (cur === null) return false;
  if (cur === agent) return true;
  const tmp = `${turnFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, agent);
  fs.renameSync(tmp, turnFile);
  return true;
}

async function cmdRecordTurn(args: string[]): Promise<void> {
  let userText: string | undefined;
  let assistantText: string | undefined;
  let useStdin = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user") userText = args[++i];
    else if (args[i] === "--assistant") assistantText = args[++i];
    else if (args[i] === "--stdin") useStdin = true;
  }
  if (useStdin) {
    const stdin = fs.readFileSync(0, "utf8");
    try {
      const obj = JSON.parse(stdin);
      userText = userText ?? obj.user;
      assistantText = assistantText ?? obj.assistant;
    } catch (err) {
      die(`--stdin: invalid JSON: ${(err as Error).message}`, 70);
    }
  }
  if (typeof userText !== "string" || typeof assistantText !== "string") {
    die(
      "usage: agent-chat.ts record-turn --user <text> --assistant <text>\n" +
      "       agent-chat.ts record-turn --stdin   (reads JSON {user, assistant})",
      70,
    );
  }

  const id = resolveIdentity();
  const topo = loadTopology(id.topology);
  const key = currentSessionKey();
  const rec = readSessionRecord(key);

  // Speaker required — transparency invariant. Never silently drop a turn.
  const speaker = await fetchSpeaker(id.name, key);
  if (!speaker) die("no current speaker; run 'agent-chat speaker <name>' first", 64);
  if (!topo.agents.includes(speaker)) {
    die(
      `speaker '${speaker}' is not a member of topology '${id.topology}'; ` +
      `valid speakers: ${topo.agents.join(", ")}`,
      65,
    );
  }

  const edges = edgesOf(topo, id.name);
  const edge = edges.find((e) => e.peer === speaker);
  if (!edge) {
    die(
      `no edge between speaker '${speaker}' and agent '${id.name}' in topology '${id.topology}'`,
      66,
    );
  }
  // Defensive: refuse AI-to-AI misroute. users.yaml membership IS the human
  // marker — `record-turn` handles only the human→AI direction; AI-to-AI
  // uses turn.ts directly. Replaced the degree heuristic from b11db98
  // (which inverts at N≥AI count under the orthogonal-overlay refactor).
  // Single source of truth: a name in users.yaml is human; otherwise it's
  // an AI agent in the active topology.
  const users = loadUsers();
  const isHuman = (n: string) => users.some((u) => u.name === n);
  if (!isHuman(speaker) || isHuman(id.name)) {
    die(
      `refuse: record-turn is human→AI only. ` +
      `speaker '${speaker}' ${isHuman(speaker) ? "is human ✓" : "is NOT in users.yaml"}; ` +
      `agent '${id.name}' ${isHuman(id.name) ? "is in users.yaml (NOT an AI)" : "is AI ✓"}. ` +
      `AI-to-AI uses turn.ts directly; human-to-human is not supported in v1.`,
      66,
    );
  }

  const sha = turnHash(speaker, userText, assistantText);
  const ledger = recordedTurnsLedger(edge.dir);
  if (alreadyRecorded(ledger, sha)) {
    console.log(`record-turn: idempotent skip — turn already recorded (sha256=${sha.slice(0, 12)}…)`);
    return;
  }

  // Speaker-change handoff write on the OLD edge.
  const prevSpeaker = rec?.last_recorded_speaker;
  if (prevSpeaker && prevSpeaker !== speaker) {
    const oldEdge = edges.find((e) => e.peer === prevSpeaker);
    if (oldEdge) {
      ensureEdgeFiles(oldEdge, [prevSpeaker, id.name].sort() as [string, string]);
      authorityTakeFloor(oldEdge.turn, id.name);
      const oldBody = `${lockTag(id.name)} ${utcStamp()}\n`;
      try {
        exclusiveWriteOrFail(oldEdge.lock, oldBody);
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        const lk = parseLockFile(oldEdge.lock);
        if (lk && lk.agent === id.name && lk.pid === stableSessionPid()) {
          // idempotent re-lock — proceed
        } else if (lk && !processIsOriginal(lk.pid, lk.starttime)) {
          fs.unlinkSync(oldEdge.lock);
          exclusiveWriteOrFail(oldEdge.lock, oldBody);
        } else {
          die(
            `refuse: handoff blocked — old edge ${oldEdge.id} locked by ` +
            `${lk?.agent ?? "?"}@${lk?.host ?? "?"}:${lk?.pid ?? "?"}`,
            71,
          );
        }
      }
      try {
        const handoffStamp = utcStamp();
        const handoffSection =
          `\n---\n\n## ${prevSpeaker} — handoff to ${speaker} (UTC ${handoffStamp})\n\n` +
          `Heading out; ${speaker} is taking over this thread.\n\n→ parked\n`;
        fs.appendFileSync(oldEdge.convo, handoffSection);
        writeTurnAtomic(oldEdge.turn, "parked");
      } finally {
        try { if (fs.existsSync(oldEdge.lock)) fs.unlinkSync(oldEdge.lock); } catch {}
      }
    }
  }

  // Main flow on the NEW edge.
  ensureEdgeFiles(edge, [speaker, id.name].sort() as [string, string]);
  authorityTakeFloor(edge.turn, id.name);
  const body = `${lockTag(id.name)} ${utcStamp()}\n`;
  try {
    exclusiveWriteOrFail(edge.lock, body);
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    const lk = parseLockFile(edge.lock);
    if (lk && lk.agent === id.name && lk.pid === stableSessionPid()) {
      // idempotent re-lock — proceed
    } else if (lk && !processIsOriginal(lk.pid, lk.starttime)) {
      fs.unlinkSync(edge.lock);
      exclusiveWriteOrFail(edge.lock, body);
    } else {
      // Restore .turn to its pre-takefloor value so peers don't observe a
      // phantom turn-flip without a section. authorityTakeFloor wrote
      // .turn=id.name (us); on lock-blocked die, peer's monitor would see
      // value→<id.name> + no .md-grew, refire on every poll. Reverting to
      // `speaker` matches the protocol invariant "speaker has the floor
      // before they speak; agent only takes it during the brief
      // append-and-flip window." Caught at Phase-4 cross-review by carina
      // (multi-user rollout, nit #2).
      try { writeTurnAtomic(edge.turn, speaker); } catch {}
      die(
        `refuse: edge ${edge.id} locked by another live session ` +
        `${lk?.agent ?? "?"}@${lk?.host ?? "?"}:${lk?.pid ?? "?"}`,
        72,
      );
    }
  }
  try {
    const stamp = utcStamp();
    const sectionPair =
      `\n---\n\n## ${speaker} — user turn (UTC ${stamp})\n\n${userText}\n\n→ ${id.name}\n` +
      `\n---\n\n## ${id.name} — assistant response (UTC ${stamp})\n\n${assistantText}\n\n→ ${speaker}\n`;
    fs.appendFileSync(edge.convo, sectionPair);
    writeTurnAtomic(edge.turn, speaker);
    appendLedger(ledger, { sha256: sha, ts: stamp, speaker, agent: id.name });
  } finally {
    try { if (fs.existsSync(edge.lock)) fs.unlinkSync(edge.lock); } catch {}
  }

  // Update session record so next record-turn detects speaker changes.
  if (rec) {
    rec.last_recorded_speaker = speaker;
    writeSessionRecord(rec);
  }

  console.log(`record-turn: appended user+assistant pair on edge ${edge.id}; flipped to ${speaker}`);
}

// ----- dispatcher ----------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "init":         cmdInit(rest); break;
  case "exit":         void cmdExit(rest); break;
  case "who":          cmdWho(rest); break;
  case "gc":           cmdGc(rest); break;
  case "whoami":       void cmdWhoami(rest); break;
  case "speaker":      cmdSpeaker(rest); break;
  case "record-turn":  void cmdRecordTurn(rest); break;
  case undefined:
  case "--help":
  case "-h":
    console.log(
      `usage: agent-chat.ts <command> [args]\n\n` +
      `  init <name> [<topology>] [--force] [--no-monitor] [--no-sidecar]\n` +
      `      Declare this session's identity. Auto-resolves topology if only\n` +
      `      one is in use; offers resume on cwd+tty match. Auto-launches\n` +
      `      both the per-agent sidecar daemon (UDS fast path + inotify\n` +
      `      watcher + diff cache at .sockets/<agent>.sock) and the multi-edge\n` +
      `      monitor (chat-notification stdout) in the background.\n` +
      `      Pass --no-sidecar to disable the daemon (file-direct only).\n` +
      `      Pass --no-monitor to disable the chat-notification poller.\n\n` +
      `  exit\n` +
      `      Sign out: stop this session's monitor and remove its session +\n` +
      `      presence files. Safe to skip — \`gc\` cleans up dead sessions.\n` +
      `      Auto-archives parked edges past --archive-threshold (default 200)\n` +
      `      before teardown; pass --no-auto-archive to opt out.\n\n` +
      `  who\n` +
      `      List live (and stale) sessions on this host.\n\n` +
      `  gc [--prune-logs] [--auto-archive] [--archive-threshold=N]\n` +
      `      Sweep stale session/presence files (pid no longer alive).\n` +
      `      With --prune-logs, also remove monitor log files for agents\n` +
      `      that aren't live on this host.\n` +
      `      With --auto-archive, run \`archive.ts auto\` against every\n` +
      `      parked edge of the CURRENT session whose CONVO.md is past the\n` +
      `      line threshold (default 200). Use --archive-threshold=N to override.\n\n` +
      `  whoami\n` +
      `      Print this session's identity in one line.\n\n` +
      `  speaker [<name> | --clear]\n` +
      `      Multi-user transparency: declare which human is currently typing\n` +
      `      in this Claude Code session. <name> must be a declared agent in\n` +
      `      the active topology. No-arg prints current; --clear unsets. Read\n` +
      `      by 'record-turn' to route turns to <speaker>-<agent> edges.\n\n` +
      `  record-turn --user <text> --assistant <text>\n` +
      `  record-turn --stdin\n` +
      `      Append a (user, assistant) section pair to the appropriate\n` +
      `      <speaker>-<agent> edge. Reads current_speaker from session state\n` +
      `      (set by 'agent-chat speaker'). Idempotent under retry via per-edge\n` +
      `      recorded_turns.jsonl ledger keyed by sha256(speaker, user, assistant).\n` +
      `      Emits a handoff section on the OLD edge when the speaker changes.\n` +
      `      Exit codes: 64=no current speaker, 65=unknown speaker, 66=no edge,\n` +
      `      70=bad args, 71/72=lock blocked.\n`,
    );
    break;
  default:
    die(`unknown command: ${cmd}\nrun \`agent-chat.ts --help\` for usage.`);
}
