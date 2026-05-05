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
  readTurn, writeTurnAtomic, resolveIdentity, loadUsers, parseSections,
  exclusiveWriteOrFail, writeFileAtomic, safeUnlink,
  SKILL_ROOT, SESSIONS_DIR, PRESENCE_DIR, CONVERSATIONS_DIR,
  LOGS_DIR, SOCKETS_DIR, logPathFor, socketPathFor, pidFilePath,
  CURRENT_SPEAKER_FILE_SUFFIX, currentSpeakerPath, readCurrentSpeaker,
  writeCurrentSpeaker, resolveDefaultSpeaker, prepareEphemeralIdentity,
  computeDiameter, readScratch, writeScratch, scratchPath, SCRATCH_DIR,
  type SessionRecord, type CurrentSpeaker, type DefaultSpeakerResolution,
} from "./lib.ts";
// Round-15d-β: sidecar-client + liveness/heartbeat imports removed.
// Persistent-mode infrastructure deleted in this commit.
// Round-15d-β: liveness.ts deleted. Legacy heartbeat-file cleanup is
// inlined where needed (see cmdGc). New ephemeral sessions don't
// emit heartbeats, so this is just legacy artifact reclamation.
function heartbeatPath(agent: string): string {
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(CONVERSATIONS_DIR, ".heartbeats", `${safe}.heartbeat`);
}

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

// Round-15d-β: startMonitor / stopMonitor / startSidecar / stopSidecar
// removed. agent-chat is now ephemeral-only — no long-running daemons.
// Each `agent-chat run` invocation is a single tick that reads filesystem
// state, processes its actionable edges, and exits. Persistent-mode
// monitor + sidecar lifecycle previously launched here is gone.
//
// Backward-compat note on legacy SessionRecord fields: the
// `monitor_pid` / `monitor_pid_starttime` / `sidecar_pid` /
// `sidecar_pid_starttime` fields remain in the SessionRecord type so
// older session files continue to read cleanly, but nothing reads or
// writes them as of Round-15d-β. They're effectively documentation of
// historical layout. cmdGc's stale-session sweep simply ignores them.

// ----- subcommands ---------------------------------------------------------

function cmdInit(args: string[]): void {
  // Round 12 reentrancy guard — refuse to claim a session if we're a child
  // process of an in-flight LLM call. Without this, an LLM-summoned descendant
  // that loads the agent-chat skill would corrupt the parent's lock/turn state.
  // Pulsar Round-12 P1 load-bearing add. See scripts/llm.ts runClaude.
  if (process.env.AGENT_CHAT_INSIDE_LLM_CALL === "1") {
    die(
      "[agent-chat] init refused — running inside an LLM call (AGENT_CHAT_INSIDE_LLM_CALL=1). " +
      "An LLM descendant must not claim its own agent-chat session; that would corrupt the parent's state.",
      75,
    );
  }
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

  // Round-15d-β: sidecar + monitor lifecycle removed. agent-chat is now
  // ephemeral-only — no long-running daemons. Each agent dispatch is a
  // single `agent-chat run` tick that reads filesystem state, processes
  // its actionable edges, and exits. ScheduleWakeup (via loop-driver.ts)
  // handles cache-warm continuation. The flags `--no-sidecar` and
  // `--no-monitor` are accepted for backward-compat but no longer have
  // an effect (deprecation deferred to the next breaking-changes round).
  if (!noSidecar || !noMonitor) {
    // explicitly suppress the unused-var lint without changing the CLI
    // surface. Deprecation accept: the flags exist so existing scripts
    // / docs / muscle memory don't break, but they're parsed-and-ignored.
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
  console.log(`  runtime:     ephemeral (Round-15d-β; no sidecar/monitor daemon)`);
  // Print neighbors so the user immediately sees who they can talk to.
  const edges = edgesOf(topo, name);
  console.log(`  neighbors (${edges.length}): ${edges.map((e) => e.peer).join(", ")}`);
  // Round-15d-β: ephemeral-only notification model. To process pending
  // turns: `agent-chat run` (single tick + exit) or `loop-driver.ts`
  // (cache-warm self-rescheduling via ScheduleWakeup).
  if (process.env.CLAUDECODE === "1") {
    const loopScript = path.join(SKILL_ROOT, "scripts", "loop-driver.ts");
    console.log("");
    console.log("NEXT STEP — process pending work:");
    console.log("  Single tick (process actionable edges, exit):");
    console.log(`    bun ${path.join(SKILL_ROOT, "scripts", "agent-chat.ts")} run`);
    console.log("  Cache-warm self-rescheduling loop (270s ticks):");
    console.log(`    bun ${loopScript}`);
    console.log("  Both modes read .turn files directly — no background daemons needed.");
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
  // Round-15d-β: ephemeral-only — no sidecar / monitor to stop. Drop the
  // session-scoped current_speaker.json so consumers don't see a stale
  // speaker after exit (cadence slice-2 lifecycle invariant).
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
      console.log(`  ${r.agent.padEnd(10)} @ ${r.host}:${r.pid}  topo=${r.topology}  started=${r.started_at}`);
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

async function cmdGc(args: string[]): Promise<void> {
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
      // Round-15d-β: ephemeral-only — no sidecar/monitor processes to stop.
      // Stale per-session artifacts (current_speaker.json) get cleared
      // alongside the session record; legacy heartbeat / socket / pidfile
      // cleanups are best-effort no-ops for old-format sessions still on
      // disk from pre-15d-β installs.
      try { safeUnlink(currentSpeakerPath(rec.session_key)); } catch {}
      // Defense-in-depth: legacy artifacts from pre-15d-β sessions.
      try { safeUnlink(socketPathFor(rec.agent)); } catch {}
      try { safeUnlink(pidFilePath(rec.agent, "sidecar")); } catch {}
      try { safeUnlink(heartbeatPath(rec.agent)); } catch {}
      deleteSessionRecord(rec);
      console.log(`gc: removed stale ${rec.agent}@${rec.topology} (pid ${rec.pid} gone)`);
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
  // Round 12 (cadence Phase-1): reap orphan tmp files from crashed archive
  // writes. writeFileAtomic uses {path}.tmp.{pid}.{ts} naming; if the writer
  // crashes mid-write, the tmp persists indefinitely. Walk every conversations
  // edge's archives subtree and unlink any `*.tmp.*` files older than 5 min.
  // Folded into normal gc (NOT gated behind a flag — small files, infrequent
  // creation, cheap to walk). The 5-min age threshold avoids racing an
  // in-flight LLM call that hasn't finished writing yet.
  const TMP_AGE_THRESHOLD_MS = 5 * 60 * 1000;
  const TMP_RE = /\.tmp\.\d+\.\d+$/;
  const reapDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        reapDir(p);
        continue;
      }
      if (!TMP_RE.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs < TMP_AGE_THRESHOLD_MS) continue;
        if (safeUnlink(p)) { console.log(`gc: reaped orphan tmp ${p}`); removed++; }
      } catch { /* ENOENT race; skip */ }
    }
  };
  // CONVERSATIONS_DIR/<topology>/<edge>/archives/{leaf,condensed}/<aid>/...
  // Walking from CONVERSATIONS_DIR is the simplest correct scope.
  if (fs.existsSync(CONVERSATIONS_DIR)) {
    for (const topo of (() => {
      try { return fs.readdirSync(CONVERSATIONS_DIR); } catch { return [] as string[]; }
    })()) {
      const tdir = path.join(CONVERSATIONS_DIR, topo);
      // Skip control dirs (.sessions, .presence, .sockets, .logs).
      if (topo.startsWith(".")) continue;
      try {
        const st = fs.statSync(tdir);
        if (!st.isDirectory()) continue;
      } catch { continue; }
      // Each edge under topology has an archives/ dir at most.
      for (const edgeName of (() => {
        try { return fs.readdirSync(tdir); } catch { return [] as string[]; }
      })()) {
        const archDir = path.join(tdir, edgeName, "archives");
        reapDir(archDir);
      }
    }
  }
  // Round 13 slice 3 (keystone): --aggressive sweeps cross-session orphans
  // that the per-session passes above don't catch. Bound by hostname so we
  // never delete state recorded against a different host on shared FS.
  // Default `gc` (no flag) stays scoped to my own session; --aggressive is
  // the explicit cross-session opt-in (orion's Phase-1.5 answer).
  const aggressive = args.includes("--aggressive");
  if (aggressive) {
    // Round-15d-β: heartbeat / socket reapers are now legacy cleanup paths
    // for pre-15d-β installs. The current ephemeral architecture writes
    // neither heartbeats nor sockets, but old-format artifacts may still
    // be on disk and this sweep clears them.
    const heartbeatsDir = path.join(CONVERSATIONS_DIR, ".heartbeats");
    if (fs.existsSync(heartbeatsDir)) {
      for (const f of fs.readdirSync(heartbeatsDir)) {
        if (!f.endsWith(".heartbeat")) continue;
        const sp = path.join(heartbeatsDir, f);
        if (safeUnlink(sp)) {
          console.log(`gc: removed legacy heartbeat ${f} (Round-15d-β no longer writes these)`);
          removed++;
        }
      }
    }
    if (fs.existsSync(SOCKETS_DIR)) {
      for (const f of fs.readdirSync(SOCKETS_DIR)) {
        if (!f.endsWith(".sock")) continue;
        const sp = path.join(SOCKETS_DIR, f);
        if (safeUnlink(sp)) {
          console.log(`gc: removed legacy socket ${f} (Round-15d-β no longer creates these)`);
          removed++;
        }
      }
    }
    // Clear `.fts-corrupt` sentinels for edges whose fts.db is now valid.
    // We probe by attempting a lightweight fts query; any throw means still
    // corrupt, leave the sentinel alone. The `fts.ts` module is optional —
    // if it doesn't import, skip silently (lumeyon's slice not landed).
    try {
      const { ftsCorruptSentinelPath, ftsDbPath, query: ftsQuery } = await import("./fts.ts");
      // Walk topologies → edges
      for (const topoName of (() => {
        try {
          return fs.readdirSync(SKILL_ROOT)
            .filter((f) => f.startsWith("agents.") && f.endsWith(".yaml") && f !== "agents.users.yaml")
            .map((f) => f.replace(/^agents\.|\.yaml$/g, ""));
        } catch { return [] as string[]; }
      })()) {
        const tdir = path.join(require("./lib.ts").CONVERSATIONS_DIR, topoName);
        if (!fs.existsSync(tdir)) continue;
        for (const edgeName of (() => {
          try { return fs.readdirSync(tdir); } catch { return [] as string[]; }
        })()) {
          const edgeDir = path.join(tdir, edgeName);
          const sentinel = ftsCorruptSentinelPath(edgeDir);
          if (!fs.existsSync(sentinel)) continue;
          if (!fs.existsSync(ftsDbPath(edgeDir))) continue;
          // Probe with a no-op query — if it throws, fts.db is still corrupt.
          try {
            ftsQuery(edgeDir, "agentchatgcprobeneverexists__", 1);
            // If query returned without throwing, fts is healthy; clear the sentinel.
            if (safeUnlink(sentinel)) {
              console.log(`gc: cleared .fts-corrupt sentinel for ${edgeName} (fts.db now healthy)`);
              removed++;
            }
          } catch { /* still corrupt; leave the sentinel */ }
        }
      }
    } catch { /* fts.ts not present or import failed; skip */ }
  }

  if (!removed) console.log("gc: nothing to remove.");
}

// Round-15d-β: cmdDoctor preserved as a CLI surface for backward-compat
// but the heartbeat-driven liveness check is gone (heartbeats no longer
// emitted under ephemeral-only). The doctor command now reports session
// records on this host; future rounds may extend with ephemeral-aware
// stuck-tick detection (e.g. probing scratchpad mtime + .turn age).
async function cmdSelfTest(args: string[]): Promise<void> {
  // Round-15g: end-to-end smoke test for the installed plugin. Spawns the
  // plugin's own scripts in subprocesses against a tmp conversations dir
  // and verifies the wire protocol, config layer, doctor surfaces, and
  // edge canonicalization. See scripts/self-test.ts for the full check
  // list. The script self-reports PASS/FAIL and exits 0 on all-pass.
  const child = child_process.spawn("bun", [path.join(SKILL_ROOT, "scripts/self-test.ts"), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  await new Promise<void>((resolve) => child.on("exit", (code) => {
    process.exit(code ?? 1);
  }));
}

async function cmdDoctor(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--paths") {
    const { CONVERSATIONS_DIR, SKILL_ROOT, CONFIG_PATH, CONFIG } = require("./lib.ts");
    const envOverride = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    const cfgOverride = CONFIG?.conversations_dir;
    const source = envOverride
      ? `env:AGENT_CHAT_CONVERSATIONS_DIR`
      : cfgOverride
        ? `config:${CONFIG_PATH}`
        : `default`;
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        skill_root: SKILL_ROOT,
        conversations_dir: CONVERSATIONS_DIR,
        conversations_dir_source: source,
        config_path: CONFIG_PATH,
        config_present: fs.existsSync(CONFIG_PATH),
      }, null, 2));
    } else {
      console.log(`doctor --paths:`);
      console.log(`  skill_root         = ${SKILL_ROOT}`);
      console.log(`  conversations_dir  = ${CONVERSATIONS_DIR}`);
      console.log(`  source             = ${source}`);
      console.log(`  config_path        = ${CONFIG_PATH}`);
      console.log(`  config_present     = ${fs.existsSync(CONFIG_PATH)}`);
    }
    return;
  }
  if (sub !== "--liveness") {
    die("usage: agent-chat.ts doctor --liveness [--json] | doctor --paths [--json]");
  }
  const wantJson = args.includes("--json");
  const sessions = listSessions().filter((r) => r.host === os.hostname());
  const live = sessions.filter((r) => processIsOriginal(r.pid, r.pid_starttime));
  const stale = sessions.filter((r) => !processIsOriginal(r.pid, r.pid_starttime));
  if (wantJson) {
    console.log(JSON.stringify({
      sessions: sessions.map((r) => ({
        agent: r.agent, pid: r.pid,
        live: processIsOriginal(r.pid, r.pid_starttime),
      })),
      live_count: live.length,
      stale_count: stale.length,
      runtime: "ephemeral-only (Round-15d-β; no sidecar heartbeats)",
    }, null, 2));
  } else {
    console.log(`doctor --liveness (Round-15d-β; ephemeral-only):`);
    console.log(`  ${live.length} live session(s), ${stale.length} stale`);
    for (const r of live) {
      console.log(`  ${r.agent.padEnd(12)} status=live         pid=${r.pid}  started=${r.started_at}`);
    }
    for (const r of stale) {
      console.log(`  ${r.agent.padEnd(12)} status=stale        pid=${r.pid} (gone) — run \`agent-chat gc\``);
    }
  }
  process.exit(stale.length === 0 ? 0 : 1);
}

async function cmdWhoami(_args: string[]): Promise<void> {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (rec) {
    // Round-15d-β: ephemeral-only — no sidecar UDS to fast-path through.
    // Read directly from the SessionRecord + speaker file.
    const speaker = readCurrentSpeaker(key)?.name ?? "-";
    console.log(`${rec.agent}@${rec.topology}  session_key=${key}  pid=${rec.pid}  speaker=${speaker}`);
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

// Read current_speaker for a given session_key. Round-15d-β: ephemeral-
// only — file-direct only (no sidecar UDS fast-path). The lib-exported
// readCurrentSpeaker handles the read; this helper preserves the async
// signature for backward-compat with cmdRecordTurn callers.
async function fetchSpeaker(_agent: string, key: string): Promise<string | null> {
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
  // Round 12 reentrancy guard — same shape as cmdInit and turn.ts:lock.
  // Refuse to write CONVO.md / locks if we're inside an LLM call.
  if (process.env.AGENT_CHAT_INSIDE_LLM_CALL === "1") {
    die(
      "[agent-chat] record-turn refused — running inside an LLM call (AGENT_CHAT_INSIDE_LLM_CALL=1). " +
      "An LLM descendant must not write to CONVO.md; that would corrupt the parent's audit trail.",
      75,
    );
  }
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

// ----- run (Round-15a slice 1: ephemeral mode) -----------------------------
//
// `agent-chat run` is the ephemeral entry point: process one tick worth of
// inbox work (any edge with .turn=<self>), exit. No sidecar startup, no
// monitor. ScheduleWakeup re-fires the loop via scripts/loop-driver.ts.
//
// Cross-slice context: Round-14 audit Finding 7 (file-checklist
// simplification) — we don't need a separate task list file. The
// .turn=<self> + index.jsonl mtime ARE the "more work" signal. cmdRun
// just walks edges, processes any with our turn, exits.
//
// Per Round-14 audit Finding 1 (registry-vs-execution split): identity is
// already file-backed (`.sessions/<key>.json`); cmdRun reuses
// resolveIdentity + edgesOf. The "agent" doesn't need to be a live process
// — Ruflo's agent_terminate flips a status field; ours can do less, since
// our session record already exists from `init` time.

async function cmdRun(args: string[]): Promise<{ workDone: boolean; pending: number }> {
  // cmdRun is single-tick by design — Round-14 Finding 7 endorses
  // keeping the work loop bounded to one pass, with `loop-driver.ts`
  // as the scheduling wrapper. Round-15a Phase-4 review caught the
  // `--once` flag as parsed-but-unused (lumeyon CONCERN #1) — same
  // anti-pattern shape that produced bm25-weights drift, missing-
  // sidecar_version, file-checklist-doc-lies, NO_LLM-footgun. Phase-5
  // resolution: drop the flag entirely so CLI surface matches code
  // semantics. For self-scheduling, run `bun scripts/loop-driver.ts`.
  const opts = {
    unsafe: false,
    peers: [] as string[],
    speaker: null as string | null,
    // Round-15d: sub-relay activation. When a peer agent dispatches to one
    // of its own neighbors (e.g. carina → lumeyon), --sub-relay-from
    // names the dispatching parent. cmdRun uses this to:
    //   (a) refuse cycles (lumeyon → carina when carina was the parent),
    //   (b) bound chain depth ≤ topology.diameter,
    //   (c) tag the resulting CONVO.md section with sub-relay provenance.
    // The flag value is a comma-separated chain (most-recent first):
    //   "carina,orion" means carina dispatched me, who was originally
    //   dispatched by orion. Empty/absent = top-level dispatch.
    subRelayFrom: null as string | null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--unsafe") opts.unsafe = true;
    else if (a === "--speaker") opts.speaker = args[++i] ?? null;
    else if (a === "--sub-relay-from") opts.subRelayFrom = args[++i] ?? null;
    else if (!a.startsWith("--")) opts.peers.push(a);
  }
  // Reentrancy guard: refuse if we're already inside an LLM call. The
  // existing runClaude check at llm.ts:187 catches it, but a clearer
  // error here saves the user a confusing trace.
  if (process.env.AGENT_CHAT_INSIDE_LLM_CALL === "1") {
    die(`refuse: AGENT_CHAT_INSIDE_LLM_CALL=1. cmdRun cannot recurse into a child LLM call.`, 64);
  }
  const id = resolveIdentity();
  const topo = loadTopology(id.topology);
  // Round-15d-β: ephemeral-only — no sidecar exists, so no collision check
  // is needed. Stale .sockets/<agent>.sock files from pre-15d-β installs
  // are tolerated; they're cleaned up by `agent-chat gc`.
  const all = edgesOf(topo, id.name);
  const targetEdges = opts.peers.length > 0 ? all.filter((e) => opts.peers.includes(e.peer)) : all;
  if (targetEdges.length === 0) {
    console.error(`[agent-chat run] no target edges (peer filter: ${opts.peers.join(",") || "none"}).`);
    return { workDone: false, pending: 0 };
  }

  // Round-15d: sub-relay validation. If we're being dispatched as a sub-
  // relay (parent in opts.subRelayFrom), enforce two invariants:
  //   1. Cycle refusal: my own name must NOT appear in the chain.
  //   2. Depth ≤ topology.diameter: longer chains hit a graph property
  //      that says "you can reach the same destination via fewer hops",
  //      so deeper recursion is wasted (or a cycle).
  let subRelayChain: string[] = [];
  if (opts.subRelayFrom) {
    subRelayChain = opts.subRelayFrom.split(",").map((s) => s.trim()).filter(Boolean);
    if (subRelayChain.includes(id.name)) {
      die(`refuse: sub-relay cycle detected. My agent name "${id.name}" already appears in chain "${opts.subRelayFrom}". A→B→A would cycle.`, 67);
    }
    const diameter = computeDiameter(topo);
    if (subRelayChain.length >= diameter) {
      die(`refuse: sub-relay chain depth ${subRelayChain.length} ≥ topology diameter ${diameter}. Deeper chains hit a graph property that says the same destination is reachable in fewer hops.`, 68);
    }
    console.error(`[agent-chat run] sub-relay: chain=[${subRelayChain.join(", ")}] depth=${subRelayChain.length} max=${diameter}`);
  }

  // Round-15d: read the agent's autobiographical scratchpad. This is the
  // structural answer to "the same agent must know context from the
  // distant past" under ephemeral-only execution. Empty for first-run
  // agents; populated agents have their cross-tick relationship summary
  // here. Caller composes prompt with scratchpad prepended.
  const scratchContent = readScratch(id.name);

  // Lazy-import safety + runClaude — keeps cmdRun decoupled from optional deps.
  const { detectDestructive } = await import("./safety.ts");
  const { runClaude } = await import("./llm.ts");

  // Round-15c (Contract A): if --speaker was passed, pre-write a
  // synthetic SessionRecord + current_speaker.json so any in-process
  // record-turn invocation by the dispatched ephemeral child resolves
  // the speaker correctly. Validate the speaker against users.yaml
  // BEFORE pre-writing — same defense as cmdRecordTurn's gate.
  let ephemeralCleanup: (() => void) | null = null;
  if (opts.speaker) {
    const users = loadUsers().map((u) => u.name);
    if (!users.includes(opts.speaker)) {
      die(`refuse: --speaker "${opts.speaker}" is not in users.yaml. Speaker must be a registered human user.`, 65);
    }
    // Read parent SessionRecord for inheritance (pid, host, etc.). The
    // dispatcher must have run `agent-chat init` so a SessionRecord
    // exists.
    const parentKeyRaw = currentSessionKey();
    const parent = readSessionRecord(parentKeyRaw);
    if (!parent) {
      die(`refuse: --speaker "${opts.speaker}" requires a live parent SessionRecord (run agent-chat init first).`, 64);
    }
    const eph = prepareEphemeralIdentity({ agent: id.name, speaker: opts.speaker, parent });
    process.env.CLAUDE_SESSION_ID = eph.sessionKey;
    ephemeralCleanup = eph.cleanup;
    console.error(`[agent-chat run] ephemeral speaker="${opts.speaker}" session_key=${eph.sessionKey} (Contract A pre-write)`);
  }

  let workDone = false;
  let pending = 0;
  for (const edge of targetEdges) {
    const turn = readTurn(edge.turn);
    if (turn !== id.name) {
      // Not our turn on this edge; skip.
      continue;
    }
    if (fs.existsSync(edge.lock)) {
      // Locked by some session (us or peer); skip — don't fight the lock.
      pending++;
      continue;
    }
    // Compose continuation prompt: scratchpad (autobiographical memory) +
    // last few peer sections from CONVO.md.
    let prompt = "";
    try {
      const convoText = fs.readFileSync(edge.convo, "utf8");
      const { sections } = parseSections(convoText);
      const tail = sections.slice(-4).join("\n\n");
      const scratchBlock = scratchContent
        ? `Your persistent scratchpad (your own autobiographical memory across all relationships, written by past invocations of yourself):\n\n${scratchContent}\n\n---\n\n`
        : "";
      const subRelayBlock = subRelayChain.length > 0
        ? `Sub-relay context: dispatched as part of chain [${subRelayChain.join(" → ")} → ${id.name}]. Original dispatcher is "${subRelayChain[subRelayChain.length - 1]}".\n\n`
        : "";
      // Round-15f: per-agent role definition from agents.<topology>.yaml.
      // Prepended to the system prompt so each spawned `claude -p`
      // subprocess has a coherent specialty instead of a generic
      // "you are <name>" persona.
      const myRole = topo.roles?.[id.name];
      const roleBlock = myRole
        ? `Your role as ${id.name} in ${id.topology}:\n\n${myRole}\n\n---\n\n`
        : "";
      // Round-15f: peer roles (excluding self) — surface so the agent can
      // make informed sub-relay decisions ("which neighbor specializes
      // in this question?"). Only include roles for direct neighbors.
      const neighbors = edgesOf(topo, id.name);
      const peerRolesLines: string[] = [];
      for (const e of neighbors) {
        const r = topo.roles?.[e.peer];
        if (r) peerRolesLines.push(`  - ${e.peer}: ${r.split("\n")[0]}`);
      }
      const peerRolesBlock = peerRolesLines.length > 0
        ? `Your direct neighbors in this topology and their specialties (you can sub-relay to any of them by emitting <dispatch peer="<name>">...</dispatch> in your response):\n\n${peerRolesLines.join("\n")}\n\n---\n\n`
        : "";
      prompt =
        roleBlock +
        `You are agent "${id.name}" in topology "${id.topology}", currently in conversation with "${edge.peer}".\n\n` +
        peerRolesBlock +
        scratchBlock +
        subRelayBlock +
        `Recent conversation tail (last 4 sections):\n\n${tail}\n\n` +
        `Compose your response as a single Markdown section beginning with the canonical header ` +
        `"## ${id.name} — <topic> (UTC <stamp>)" and ending with "→ ${edge.peer}" or "→ parked". ` +
        `Output the section verbatim, no preamble.\n\n` +
        // Round-15d/f: agent-managed memory + auto-dispatch directives.
        // The agent may optionally append structured blocks AFTER the section:
        //
        // <scratch>
        //   <new contents of your scratchpad — your autobiographical
        //    memory for this relationship and others. Capped at 8KB.>
        // </scratch>
        //
        // <archive>
        //   sections: <count of recent CONVO.md sections to seal>
        //   summary: <your own summary of what those sections covered>
        // </archive>
        //
        // <dispatch peer="<neighbor-name>">
        //   <prompt for that neighbor — what specifically do you need
        //    from them? cmdRun will sub-relay to that neighbor with
        //    your prompt as new content on YOUR edge with them, then
        //    that neighbor's response flows back through their tick.>
        // </dispatch>
        //
        // All blocks are OPTIONAL. cmdRun parses them after extracting
        // the canonical section.
        `If you want to update your scratchpad or archive prior sections, ` +
        `append <scratch>...</scratch> and/or <archive>sections: N\\nsummary: ...</archive> ` +
        `blocks AFTER the section. If you want to dispatch a sub-question to ` +
        `one of your direct neighbors (orchestrator pattern), append ` +
        `<dispatch peer="NAME">your prompt to them</dispatch>. All blocks ` +
        `are optional.`;
    } catch (err) {
      console.error(`[agent-chat run] failed to read CONVO.md at ${edge.convo}: ${(err as Error).message}; skipping.`);
      continue;
    }
    // Pre-flight safety scan. detectDestructive returns first match; refuse
    // unless --unsafe. Mid-prose `rm -rf` in legitimate help-text discussion
    // is a known false-positive class — `--unsafe` is the explicit override.
    const safetyHit = detectDestructive(prompt);
    if (safetyHit && !opts.unsafe) {
      console.error(
        `[agent-chat run] refused on edge ${edge.id}: pattern '${safetyHit.pattern}' detected (matched: ${JSON.stringify(safetyHit.match)}). ` +
        `Pass --unsafe to override.`,
      );
      pending++;
      continue;
    }
    // Shell out to runClaude for the actual work. AGENT_CHAT_INSIDE_LLM_CALL
    // gets set by runClaude's internal env mgmt; downstream turn.ts shell-outs
    // (lock/flip/unlock) check that flag and would refuse — so we must do
    // the lock+flip BEFORE invoking runClaude (otherwise re-entry blocks).
    // Simpler shape: lock the edge, run claude, on success append section
    // and flip+unlock; on failure, unlock and skip.
    const lockResult = require("node:child_process").spawnSync(
      process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "lock", edge.peer],
      { encoding: "utf8" },
    );
    if (lockResult.status !== 0) {
      console.error(`[agent-chat run] lock failed for ${edge.id}: ${lockResult.stderr}`);
      pending++;
      continue;
    }
    let r;
    try {
      r = await runClaude({ prompt, timeoutMs: 90_000 });
    } catch (err) {
      console.error(`[agent-chat run] runClaude threw on ${edge.id}: ${(err as Error).message}`);
      try { require("node:child_process").spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "unlock", edge.peer], { encoding: "utf8" }); } catch {}
      continue;
    }
    if (r.reason !== "ok" || !r.stdout) {
      console.error(`[agent-chat run] runClaude ${r.reason} on ${edge.id} (${r.code ?? "no-code"}); skipping.`);
      try { require("node:child_process").spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "unlock", edge.peer], { encoding: "utf8" }); } catch {}
      continue;
    }
    // Round-15d: parse agent-managed memory directives BEFORE the section
    // append. The agent's response may include <scratch>...</scratch> and/or
    // <archive>...</archive> blocks AFTER the canonical section. We extract
    // them, persist their effects, and strip them from the section before
    // appending to CONVO.md (the directives are runtime metadata, not
    // part of the conversation).
    let stdout = r.stdout;
    let scratchUpdate: string | null = null;
    let archiveDirective: { sections: number; summary: string } | null = null;
    // Round-15f: <dispatch peer="<name>">prompt</dispatch> auto-sub-relay
    // directives. Multiple dispatches per response allowed; processed
    // post-section-append in order.
    const dispatchDirectives: { peer: string; prompt: string }[] = [];
    const scratchMatch = stdout.match(/<scratch>([\s\S]*?)<\/scratch>/);
    if (scratchMatch) {
      scratchUpdate = scratchMatch[1].trim();
      stdout = stdout.replace(scratchMatch[0], "").trim();
    }
    const archiveMatch = stdout.match(/<archive>([\s\S]*?)<\/archive>/);
    if (archiveMatch) {
      const body = archiveMatch[1].trim();
      const sectionsLine = body.match(/sections:\s*(\d+)/);
      const summaryLine = body.match(/summary:\s*([\s\S]*?)$/m);
      if (sectionsLine && summaryLine) {
        const n = parseInt(sectionsLine[1], 10);
        if (Number.isFinite(n) && n > 0) {
          archiveDirective = { sections: n, summary: summaryLine[1].trim() };
        }
      }
      stdout = stdout.replace(archiveMatch[0], "").trim();
    }
    // Round-15f: extract all <dispatch peer="..."> blocks. Validate each
    // peer is an actual neighbor of mine in this topology before queuing
    // the sub-relay (prevents typos and out-of-graph dispatches).
    const neighborNames = new Set(edgesOf(topo, id.name).map((e) => e.peer));
    let dispatchSearch = stdout;
    while (true) {
      const m = dispatchSearch.match(/<dispatch\s+peer=["']([a-z0-9_-]+)["']\s*>([\s\S]*?)<\/dispatch>/i);
      if (!m) break;
      const peerName = m[1];
      const subPrompt = m[2].trim();
      if (!neighborNames.has(peerName)) {
        console.error(`[agent-chat run] dispatch directive refused: "${peerName}" is not a direct neighbor of ${id.name} in ${id.topology}`);
      } else if (subPrompt) {
        dispatchDirectives.push({ peer: peerName, prompt: subPrompt });
      }
      dispatchSearch = dispatchSearch.replace(m[0], "");
    }
    stdout = dispatchSearch.trim();
    // Append the section + flip turn to peer + unlock.
    try {
      // Sanity: section must end with a "→ <next>" line so the turn flip
      // matches the section semantics. If runClaude omitted it, append
      // "→ <peer>" on a new line.
      const tail = stdout.trimEnd();
      const hasArrow = /\n→\s+\S+\s*$/.test(tail);
      const sectionText = hasArrow ? tail + "\n" : tail + `\n\n→ ${edge.peer}\n`;
      fs.appendFileSync(edge.convo, "\n---\n\n" + sectionText);
      const flipResult = require("node:child_process").spawnSync(
        process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "flip", edge.peer, edge.peer],
        { encoding: "utf8" },
      );
      if (flipResult.status !== 0) {
        console.error(`[agent-chat run] flip failed for ${edge.id}: ${flipResult.stderr}`);
      }
      try { require("node:child_process").spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "unlock", edge.peer], { encoding: "utf8" }); } catch {}
      console.log(`[agent-chat run] processed ${edge.id} → flipped to ${edge.peer}`);
      workDone = true;
      // Round-15d: persist agent-managed memory directives AFTER successful
      // section append. Failures here are non-blocking — the conversation
      // is intact; missing scratchpad update or archive seal can be retried
      // next tick.
      if (scratchUpdate != null) {
        try {
          writeScratch(id.name, scratchUpdate);
          console.log(`[agent-chat run] scratchpad updated for ${id.name} (${scratchUpdate.length} bytes)`);
        } catch (err) {
          console.error(`[agent-chat run] scratchpad write failed: ${(err as Error).message}`);
        }
      }
      if (archiveDirective) {
        // Round-15e: execute the agent's archive directive via
        // `archive.ts auto <peer> --seal-count N --agent-summary` with
        // the agent's authored summary on stdin. archive.ts validates
        // the schema (TL;DR / Decisions / Keywords / Expand-for-details
        // required) and refuses if invalid; non-blocking on failure
        // so the conversation isn't half-committed.
        try {
          const archiveResult = require("node:child_process").spawnSync(
            process.execPath,
            [path.join(SKILL_ROOT, "scripts/archive.ts"), "auto", edge.peer,
             "--seal-count", String(archiveDirective.sections),
             "--agent-summary",
             "--force"],
            {
              encoding: "utf8",
              input: archiveDirective.summary,
              env: { ...process.env, AGENT_CHAT_NO_LLM: "1" },
            },
          );
          if (archiveResult.status === 0) {
            console.log(`[agent-chat run] archive sealed (agent-authored): ${archiveDirective.sections} sections on ${edge.id}`);
          } else {
            console.error(`[agent-chat run] archive seal failed (non-blocking): ${archiveResult.stderr}`);
            // Persist the directive to the pending dir so a future run
            // can recover the agent's intent.
            try {
              fs.mkdirSync(SCRATCH_DIR, { recursive: true });
              const pendingPath = path.join(SCRATCH_DIR, `pending-archive-${id.name}-${edge.peer}-${Date.now()}.md`);
              fs.writeFileSync(pendingPath, archiveDirective.summary, { mode: 0o600 });
            } catch {}
          }
        } catch (err) {
          console.error(`[agent-chat run] archive seal failed: ${(err as Error).message}`);
        }
      }
      // Round-15f: execute auto-dispatch directives. For each
      // <dispatch peer="X">prompt</dispatch> the agent emitted, append
      // the prompt as a new section on MY edge with that peer (with me
      // as the speaker — it's MY question/dispatch to them), flip the
      // turn to that peer, then shell out a sub-relay tick that processes
      // their edge with the chain extended. The sub-relay's response
      // flows back through normal protocol on that edge.
      //
      // Cycle/depth bounded by the existing --sub-relay-from validation
      // in the spawned cmdRun. The chain is built by appending my name
      // to the existing chain (or starting a fresh chain if I'm the
      // top-level dispatcher).
      for (const d of dispatchDirectives) {
        try {
          // Find my edge with this peer.
          const subEdge = edgesOf(topo, id.name).find((e) => e.peer === d.peer);
          if (!subEdge) {
            console.error(`[agent-chat run] dispatch refused: no edge between ${id.name} and ${d.peer}`);
            continue;
          }
          // Compose a section from me on my-${peer} edge with the dispatch prompt.
          // Then flip turn to the peer so cmdRun for that peer picks it up.
          const ts = new Date().toISOString();
          const dispatchSection =
            `\n---\n\n## ${id.name} — dispatch to ${d.peer} (UTC ${ts})\n\n${d.prompt}\n\n→ ${d.peer}\n`;
          // Lock the sub-edge before append+flip.
          const subLock = require("node:child_process").spawnSync(
            process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "lock", d.peer],
            { encoding: "utf8" },
          );
          if (subLock.status !== 0) {
            console.error(`[agent-chat run] dispatch ${d.peer}: lock failed (${subLock.stderr.trim()}); skipping`);
            continue;
          }
          fs.appendFileSync(subEdge.convo, dispatchSection);
          require("node:child_process").spawnSync(
            process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "flip", d.peer, d.peer],
            { encoding: "utf8" },
          );
          require("node:child_process").spawnSync(
            process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "unlock", d.peer],
            { encoding: "utf8" },
          );
          // Now spawn a sub-relay tick AS the peer agent. The chain is
          // [...subRelayChain, id.name] so cmdRun's depth/cycle check
          // bounds recursion at topology.diameter and refuses cycles.
          const newChain = [...subRelayChain, id.name].join(",");
          const subResult = require("node:child_process").spawnSync(
            process.execPath,
            [path.join(SKILL_ROOT, "scripts/agent-chat.ts"), "run",
             "--sub-relay-from", newChain],
            {
              cwd: SKILL_ROOT,
              encoding: "utf8",
              env: {
                ...process.env,
                AGENT_NAME: d.peer,
                AGENT_TOPOLOGY: id.topology,
                // Drop CLAUDE_SESSION_ID so the spawned cmdRun resolves identity
                // via env vars (#2) instead of hitting the parent's per-session
                // record (which is for id.name, not d.peer).
                CLAUDE_SESSION_ID: "",
              },
              stdio: ["ignore", "inherit", "inherit"],
            },
          );
          if (subResult.status === 0) {
            console.log(`[agent-chat run] dispatch executed: ${id.name} → ${d.peer} (chain depth ${newChain.split(",").length})`);
          } else {
            console.error(`[agent-chat run] dispatch ${id.name} → ${d.peer} exited ${subResult.status}; sub-relay tick failed (non-blocking)`);
          }
        } catch (err) {
          console.error(`[agent-chat run] dispatch directive failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[agent-chat run] append/flip failed for ${edge.id}: ${(err as Error).message}`);
      try { require("node:child_process").spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/turn.ts"), "unlock", edge.peer], { encoding: "utf8" }); } catch {}
    }
  }
  // Round-15d-β: post-flight heartbeat liveness hint removed (heartbeats
  // are no longer emitted under ephemeral-only). Stuck-tick detection
  // moves to the loop-driver scratchpad/turn-mtime probe in a future
  // round; for now, silent.
  // Round-15c (Contract A): clean up the synthetic ephemeral identity if
  // we pre-wrote one. Idempotent — safe even if the work loop crashed
  // mid-iteration (the cleanup just unlinks files that may or may not
  // exist).
  if (ephemeralCleanup) {
    try { ephemeralCleanup(); } catch (err) {
      console.error(`[agent-chat run] ephemeral cleanup failed: ${(err as Error).message} (cmdGc dead-pid sweep will catch orphans)`);
    }
  }
  // Round-15h Concern-1: per-tick auto-archive. Ephemeral mode means most
  // sessions never explicitly `agent-chat exit`, so the exit-time auto-
  // archive that's been the only sealing trigger never fires. Run the
  // same sweep at the END of every cmdRun tick — cheap (no-op for edges
  // below threshold), idempotent (autoArchiveSessionEdges only seals
  // parked-AND-bloated edges), and defensive against indefinite growth.
  // Synthesized-identity ticks (Contract A) skip this — they have no
  // persistent SessionRecord on disk; the cleanup above unlinked it.
  try {
    const tickRec = readSessionRecord(currentSessionKey());
    if (tickRec) {
      const n = autoArchiveSessionEdges(tickRec, 200);
      if (n > 0) console.error(`[agent-chat run] per-tick auto-archive: sealed ${n} parked edge(s)`);
    }
  } catch (err) {
    console.error(`[agent-chat run] per-tick auto-archive failed: ${(err as Error).message} (non-blocking)`);
  }
  return { workDone, pending };
}

// ----- dispatcher ----------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "init":         cmdInit(rest); break;
  case "exit":         void cmdExit(rest); break;
  case "who":          cmdWho(rest); break;
  case "gc":           void cmdGc(rest); break;
  case "doctor":       void cmdDoctor(rest); break;
  case "whoami":       void cmdWhoami(rest); break;
  case "speaker":      cmdSpeaker(rest); break;
  case "record-turn":  void cmdRecordTurn(rest); break;
  case "run":          void cmdRun(rest); break;
  case "self-test":    void cmdSelfTest(rest); break;
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
      `      70=bad args, 71/72=lock blocked.\n\n` +
      `  self-test [--json]\n` +
      `      End-to-end smoke test (~5–10s). Spawns subprocesses against a tmp\n` +
      `      conversations dir and verifies plugin layout, doctor surfaces,\n` +
      `      config.json layer, two-agent identity binding, edge canonicalization,\n` +
      `      lock+append+flip+unlock round-trip, and park semantics. Exits 0\n` +
      `      on all-pass; agents driving via tmux can rely on the exit code.\n`,
    );
    break;
  default:
    die(`unknown command: ${cmd}\nrun \`agent-chat.ts --help\` for usage.`);
}
