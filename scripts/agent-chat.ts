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
import * as child_process from "node:child_process";
import {
  loadTopology, listSessions, readSessionRecord, writeSessionRecord,
  deleteSessionRecord, currentSessionKey, sessionFile, presenceFile,
  ensureControlDirs, findLivePresence, findResumableSession, resumeKey,
  pidIsAlive, pidStarttime, processIsOriginal, stableSessionPid, processTag,
  utcStamp, edgesOf,
  exclusiveWriteOrFail, writeFileAtomic,
  SKILL_ROOT, SESSIONS_DIR, PRESENCE_DIR,
  LOGS_DIR, SOCKETS_DIR, logPathFor, socketPathFor, pidFilePath,
  type SessionRecord,
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
  if (resumable && resumable.agent === name && resumable.topology === topology) {
    console.error(`[agent-chat] resume: prior session for ${name}@${topology} in this terminal is gone — taking over identity.`);
  } else if (resumable && (resumable.agent !== name || resumable.topology !== topology)) {
    console.error(`[agent-chat] note: this terminal previously hosted ${resumable.agent}@${resumable.topology}; new identity is ${name}@${topology}.`);
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

async function cmdExit(_args: string[]): Promise<void> {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (!rec) {
    console.log(`no active session for key ${key} — nothing to do.`);
    return;
  }
  // Stop sidecar BEFORE monitor so the sidecar's graceful shutdown can land
  // before anything else changes state. The sidecar self-cleans its socket +
  // pidfile on graceful exit; if it didn't (kill -9 mid-shutdown), gc reclaims.
  await stopSidecar(rec);
  stopMonitor(rec.monitor_pid, rec.monitor_pid_starttime);
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

// Unlink that tolerates a peer having already removed the file.
// Concurrent gc passes used to crash here: the inner `unlinkSync` on a
// file a peer just deleted threw ENOENT past the loop boundary, aborting
// the rest of the sweep. See cadence Q4 (P0 Major #1).
function safeUnlink(p: string): boolean {
  try { fs.unlinkSync(p); return true; }
  catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

function cmdGc(args: string[]): void {
  const pruneLogs = args.includes("--prune-logs");
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
      deleteSessionRecord(rec);
      const sideAnnotation = rec.sidecar_pid
        ? `; sidecar pid ${rec.sidecar_pid} ${sideStillThere ? "killed" : "already gone"}`
        : "";
      console.log(`gc: removed stale ${rec.agent}@${rec.topology} (pid ${rec.pid} gone${rec.monitor_pid ? `; monitor pid ${rec.monitor_pid} ${monStillThere ? "killed" : "already gone"}` : ""}${sideAnnotation})`);
      removed++;
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
    const r = await sidecarRequest<any>(rec.agent, "whoami", {}, { timeoutMs: 200 });
    if (r.ok) {
      console.log(`${r.result.agent}@${r.result.topology}  session_key=${key}  pid=${rec.pid}  monitor=${rec.monitor_pid ?? "-"}  sidecar=${r.result.sidecar_pid}  uptime=${r.result.uptime_ms}ms`);
      return;
    }
    console.log(`${rec.agent}@${rec.topology}  session_key=${key}  pid=${rec.pid}  monitor=${rec.monitor_pid ?? "-"}  sidecar=${rec.sidecar_pid ?? "-"}`);
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

// ----- dispatcher ----------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "init":     cmdInit(rest); break;
  case "exit":     void cmdExit(rest); break;
  case "who":      cmdWho(rest); break;
  case "gc":       cmdGc(rest); break;
  case "whoami":   void cmdWhoami(rest); break;
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
      `      presence files. Safe to skip — \`gc\` cleans up dead sessions.\n\n` +
      `  who\n` +
      `      List live (and stale) sessions on this host.\n\n` +
      `  gc [--prune-logs]\n` +
      `      Sweep stale session/presence files (pid no longer alive).\n` +
      `      With --prune-logs, also remove monitor log files for agents\n` +
      `      that aren't live on this host.\n\n` +
      `  whoami\n` +
      `      Print this session's identity in one line.\n`,
    );
    break;
  default:
    die(`unknown command: ${cmd}\nrun \`agent-chat.ts --help\` for usage.`);
}
