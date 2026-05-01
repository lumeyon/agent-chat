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
  pidIsAlive, stableSessionPid, processTag, utcStamp, edgesOf,
  exclusiveWriteOrFail,
  SKILL_ROOT, SESSIONS_DIR, PRESENCE_DIR,
  type SessionRecord,
} from "./lib.ts";

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

function pickTopologyDefault(): string | null {
  // If exactly one topology is currently in use by other live sessions on
  // this host, use that. Saves the user typing it for sessions 2..N.
  const live = listSessions().filter((r) => pidIsAlive(r.pid));
  const topos = new Set(live.map((r) => r.topology));
  if (topos.size === 1) return [...topos][0];
  return null;
}

function startMonitor(rec: SessionRecord): number | undefined {
  // Background-launch the per-session monitor. It inherits the session-file
  // identity via $CLAUDE_SESSION_ID/PPID, so no env override needed. Stdout
  // redirected to a per-agent log so notifications don't disappear.
  const logDir = path.join(SKILL_ROOT, "conversations", ".logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `monitor-${rec.agent}.log`);
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
    return child.pid;
  } catch (err) {
    console.error(`[agent-chat] could not auto-launch monitor: ${(err as Error).message}`);
    return undefined;
  }
}

function stopMonitor(pid: number | undefined): void {
  if (!pid || !pidIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
}

// ----- subcommands ---------------------------------------------------------

function cmdInit(args: string[]): void {
  const positional: string[] = [];
  let force = false;
  let noMonitor = false;
  for (const a of args) {
    if (a === "--force") force = true;
    else if (a === "--no-monitor") noMonitor = true;
    else positional.push(a);
  }
  const [name, topologyArg] = positional;
  if (!name) die("usage: agent-chat.ts init <name> [<topology>] [--force] [--no-monitor]");

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
  const rec: SessionRecord = {
    agent: name,
    topology,
    session_key: sessionKey,
    claude_session_id: process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined,
    host: os.hostname(),
    // stableSessionPid walks the process tree to find the long-lived agent
    // runtime ancestor (Claude Code main process), so the recorded pid is
    // alive throughout the user's session — not just for this bun invocation.
    pid: stableSessionPid(),
    started_at: utcStamp(),
    cwd,
    tty,
  };

  // Auto-launch monitor unless --no-monitor.
  if (!noMonitor) {
    rec.monitor_pid = startMonitor(rec);
  }

  // Write session + presence records. The session file is keyed by
  // session_key (unique per agent runtime instance), so a regular write is
  // fine — no concurrent contention. The presence file is keyed by agent
  // name and IS contended across sessions; use exclusive-create with
  // EEXIST handling to prevent the TOCTOU race where two concurrent inits
  // both pass the collision check above and then both write.
  ensureControlDirs();
  const fs2 = require("node:fs") as typeof import("node:fs");
  fs2.writeFileSync(sessionFile(rec.session_key), JSON.stringify(rec, null, 2) + "\n");
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
    const isDead = existing && !pidIsAlive(existing.pid);
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
    const logPath = path.join(SKILL_ROOT, "conversations", ".logs", `monitor-${name}.log`);
    console.log(`  monitor:     pid ${rec.monitor_pid} (background; writes to ${logPath})`);
  } else {
    console.log(`  monitor:     not launched (--no-monitor)`);
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

function cmdExit(_args: string[]): void {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (!rec) {
    console.log(`no active session for key ${key} — nothing to do.`);
    return;
  }
  stopMonitor(rec.monitor_pid);
  deleteSessionRecord(rec);
  console.log(`✓ ${rec.agent}@${rec.topology} signed out (session ${key})`);
}

function cmdWho(_args: string[]): void {
  const live: SessionRecord[] = [];
  const stale: SessionRecord[] = [];
  for (const rec of listSessions()) {
    if (pidIsAlive(rec.pid)) live.push(rec);
    else stale.push(rec);
  }
  if (!live.length && !stale.length) { console.log("no sessions on file."); return; }
  if (live.length) {
    console.log(`live (${live.length}):`);
    for (const r of live.sort((a, b) => a.agent.localeCompare(b.agent))) {
      const monStatus = r.monitor_pid
        ? (pidIsAlive(r.monitor_pid) ? `mon=${r.monitor_pid}` : `mon=GONE`)
        : "mon=-";
      console.log(`  ${r.agent.padEnd(10)} @ ${r.host}:${r.pid}  topo=${r.topology}  ${monStatus}  started=${r.started_at}`);
    }
  }
  if (stale.length) {
    console.log(`stale (${stale.length}; pid gone — run \`agent-chat gc\` to remove):`);
    for (const r of stale.sort((a, b) => a.agent.localeCompare(b.agent))) {
      console.log(`  ${r.agent.padEnd(10)} @ ${r.host}:${r.pid}  topo=${r.topology}  started=${r.started_at}`);
    }
  }
}

function cmdGc(_args: string[]): void {
  let removed = 0;
  for (const rec of listSessions()) {
    if (!pidIsAlive(rec.pid)) {
      stopMonitor(rec.monitor_pid);
      deleteSessionRecord(rec);
      console.log(`gc: removed stale ${rec.agent}@${rec.topology} (pid ${rec.pid} is gone)`);
      removed++;
    }
  }
  // Also sweep presence files whose pid is dead (defense in depth).
  if (fs.existsSync(PRESENCE_DIR)) {
    for (const f of fs.readdirSync(PRESENCE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(PRESENCE_DIR, f);
      try {
        const rec = JSON.parse(fs.readFileSync(fp, "utf8")) as SessionRecord;
        if (!pidIsAlive(rec.pid)) {
          fs.unlinkSync(fp);
          console.log(`gc: removed orphan presence ${f}`);
          removed++;
        }
      } catch { fs.unlinkSync(fp); removed++; }
    }
  }
  if (!removed) console.log("gc: nothing to remove.");
}

function cmdWhoami(_args: string[]): void {
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (rec) {
    console.log(`${rec.agent}@${rec.topology}  session_key=${key}  pid=${rec.pid}  monitor=${rec.monitor_pid ?? "-"}`);
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
  case "exit":     cmdExit(rest); break;
  case "who":      cmdWho(rest); break;
  case "gc":       cmdGc(rest); break;
  case "whoami":   cmdWhoami(rest); break;
  case undefined:
  case "--help":
  case "-h":
    console.log(
      `usage: agent-chat.ts <command> [args]\n\n` +
      `  init <name> [<topology>] [--force] [--no-monitor]\n` +
      `      Declare this session's identity. Auto-resolves topology if only\n` +
      `      one is in use; offers resume on cwd+tty match. Auto-launches the\n` +
      `      multi-edge monitor in the background unless --no-monitor.\n\n` +
      `  exit\n` +
      `      Sign out: stop this session's monitor and remove its session +\n` +
      `      presence files. Safe to skip — \`gc\` cleans up dead sessions.\n\n` +
      `  who\n` +
      `      List live (and stale) sessions on this host.\n\n` +
      `  gc\n` +
      `      Sweep stale session/presence files (pid no longer alive).\n\n` +
      `  whoami\n` +
      `      Print this session's identity in one line.\n`,
    );
    break;
  default:
    die(`unknown command: ${cmd}\nrun \`agent-chat.ts --help\` for usage.`);
}
