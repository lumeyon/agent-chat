// Shared helpers for agent-chat scripts. No external deps — uses Node std only.
// Compatible with `bun`, `tsx`, and `node --experimental-strip-types` (Node 23+).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

export type Topology = {
  topology: string;
  description?: string;
  agents: string[];
  edges: [string, string][];
};

export type Identity = {
  name: string;
  topology: string;
  source: string; // "env" | ".agent-name" | "cli"
};

// SKILL_ROOT is the directory containing this scripts/ folder's parent.
// Resolved relative to this file so the skill can live anywhere.
export const SKILL_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

// Conversations directory: defaults to <skill>/conversations, but tests
// (and anyone wanting per-project isolation) can override via env var.
// Topology yaml files always live under SKILL_ROOT — only runtime state
// (CONVO.md, .turn, archives, .sessions, .presence) follows this override.
export const CONVERSATIONS_DIR = process.env.AGENT_CHAT_CONVERSATIONS_DIR
  ? path.resolve(process.env.AGENT_CHAT_CONVERSATIONS_DIR)
  : path.join(SKILL_ROOT, "conversations");

// Tiny YAML parser for our limited schema:
//   topology: <name>
//   description: <text>
//   agents: [list of strings, one per dash line]
//   edges:  [list of two-element arrays, e.g. - [a, b]]
// Anything richer is rejected — keeps the skill auditable.
export function parseTopologyYaml(text: string): Topology {
  const lines = text.split(/\r?\n/);
  const out: any = { agents: [], edges: [] };
  let section: "agents" | "edges" | null = null;
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, ""); // strip comments
    if (!line.trim()) continue;
    const top = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (top && !line.startsWith(" ") && !line.startsWith("\t")) {
      const [, key, val] = top;
      if (key === "agents") { section = "agents"; continue; }
      if (key === "edges") { section = "edges"; continue; }
      section = null;
      out[key] = val.trim();
      continue;
    }
    const dash = line.match(/^\s*-\s*(.*)$/);
    if (!dash) continue;
    const item = dash[1].trim();
    if (section === "agents") {
      out.agents.push(item);
    } else if (section === "edges") {
      const m = item.match(/^\[\s*([^,\s]+)\s*,\s*([^,\s\]]+)\s*\]$/);
      if (!m) throw new Error(`bad edge syntax: ${item}`);
      out.edges.push([m[1], m[2]]);
    }
  }
  if (typeof out.topology !== "string") throw new Error("topology field missing");
  if (!Array.isArray(out.agents) || out.agents.length === 0) throw new Error("agents list empty");
  if (!Array.isArray(out.edges) || out.edges.length === 0) throw new Error("edges list empty");
  return out as Topology;
}

export function loadTopology(topologyName: string): Topology {
  const file = path.join(SKILL_ROOT, `agents.${topologyName}.yaml`);
  if (!fs.existsSync(file)) {
    const choices = fs.readdirSync(SKILL_ROOT)
      .filter((f) => f.startsWith("agents.") && f.endsWith(".yaml"))
      .map((f) => f.replace(/^agents\.|\.yaml$/g, ""))
      .join(", ");
    throw new Error(`no topology "${topologyName}" — available: ${choices}`);
  }
  const t = parseTopologyYaml(fs.readFileSync(file, "utf8"));
  // Validate every edge endpoint is a known agent.
  const known = new Set(t.agents);
  for (const [a, b] of t.edges) {
    if (!known.has(a) || !known.has(b)) {
      throw new Error(`edge [${a}, ${b}] references unknown agent`);
    }
    if (a === b) throw new Error(`self-loop edge [${a}, ${b}] not allowed`);
  }
  return t;
}

// Identity resolution order:
//   1. $AGENT_NAME + $AGENT_TOPOLOGY env vars
//   2. ./.agent-name file (YAML: name + topology)
//   3. throw — never silently guess
//
// When env vars are set AND .agent-name also exists with different values,
// emit a stderr warning so the conflict is visible. This matters when two
// Claude/Codex sessions share a cwd: the file is shared, the env is per-shell,
// so a mismatch usually means the user forgot to override the env in one of
// the shells.
function readAgentNameFile(cwd: string): { name: string; topology: string } | null {
  const file = path.join(cwd, ".agent-name");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const nameM = text.match(/^\s*name:\s*(\S+)\s*$/m);
  const topoM = text.match(/^\s*topology:\s*(\S+)\s*$/m);
  if (!nameM || !topoM) {
    throw new Error(`.agent-name at ${file} must declare 'name:' and 'topology:'`);
  }
  return { name: nameM[1], topology: topoM[1] };
}

// Per-session identity. Written by `agent-chat init`, read by every other
// script. Higher priority than env vars / .agent-name so that ten sessions
// sharing one cwd each get their own identity without the user having to
// touch shell variables. Keyed by Claude's session id when available, or
// the parent shell's pid otherwise — both are stable for the lifetime of
// the session and unique per terminal on a single host.
export type SessionRecord = {
  agent: string;
  topology: string;
  session_key: string;        // claude session id, or "ppid:<n>"
  claude_session_id?: string;
  host: string;
  pid: number;                // pid of the launcher / Claude session
  // Kernel start_time of `pid`, captured at init. Pairing pid+start_time
  // defeats pid-recycling: a pid that was reaped and reassigned to an
  // unrelated process will have a different start_time, so
  // `processIsOriginal` returns false even though `kill(pid, 0)` succeeds.
  // Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot). macOS:
  // `ps -p <pid> -o lstart=` parsed to ms-since-epoch. Other platforms:
  // omitted; legacy records also omit; both fall back to identity-blind
  // pidIsAlive (current behavior). See cadence Q2/Q3.
  pid_starttime?: number;
  started_at: string;
  cwd: string;
  tty?: string;
  monitor_pid?: number;
  monitor_pid_starttime?: number;
};

export const SESSIONS_DIR = path.join(CONVERSATIONS_DIR, ".sessions");
export const PRESENCE_DIR = path.join(CONVERSATIONS_DIR, ".presence");

export function ensureControlDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(PRESENCE_DIR, { recursive: true });
}

// Returns the session key for the *current* process. Must be:
//   - stable across every bun invocation within ONE agent session
//   - different between two agent sessions on the same host (no collisions)
//   - cheap to compute (no syscalls beyond /proc reads)
//
// Resolution order:
//   1. $CLAUDE_SESSION_ID / $CLAUDE_CODE_SESSION_ID — explicit session id,
//      if the runtime sets one.
//   2. `pid:<stableSessionPid>` — derived from the long-lived agent runtime
//      ancestor (Claude Code main process via /proc walk on Linux, or
//      process.ppid on plain shell / non-Linux). Each Claude Code instance
//      has a different main pid, so two instances on the same host get
//      different keys. Stable across every bun invocation within a session
//      because the ancestor pid doesn't change.
//
// We deliberately do NOT key by $CLAUDE_CODE_SSE_PORT: empirically, two
// Claude Code instances under the same VS Code remote dev parent can share
// a single SSE port, and a shared key silently clobbers the prior session's
// record. The pid-based key is collision-free.
export function currentSessionKey(): string {
  const cs = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  if (cs && cs.trim()) return cs.trim();
  return `pid:${stableSessionPid()}`;
}

export function sessionFile(key: string): string {
  // Sanitize: keys are typically uuids or "ppid:NNNN"; replace anything
  // funky with "_" to keep them safe filenames on Windows too.
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

export function presenceFile(agent: string): string {
  return path.join(PRESENCE_DIR, `${agent}.json`);
}

export function readSessionRecord(key: string): SessionRecord | null {
  const f = sessionFile(key);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as SessionRecord; }
  catch { return null; }
}

export function writeSessionRecord(rec: SessionRecord): void {
  ensureControlDirs();
  fs.writeFileSync(sessionFile(rec.session_key), JSON.stringify(rec, null, 2) + "\n");
  fs.writeFileSync(presenceFile(rec.agent), JSON.stringify(rec, null, 2) + "\n");
}

export function deleteSessionRecord(rec: SessionRecord): void {
  try { fs.unlinkSync(sessionFile(rec.session_key)); } catch {}
  // Only remove the presence file if it still points at THIS session — don't
  // clobber a presence record written by a different session that happens to
  // share the agent name (which would be a misconfig but we don't want to
  // make it worse).
  try {
    const p = presenceFile(rec.agent);
    if (fs.existsSync(p)) {
      const cur = JSON.parse(fs.readFileSync(p, "utf8")) as SessionRecord;
      if (cur.session_key === rec.session_key) fs.unlinkSync(p);
    }
  } catch {}
}

export function listSessions(): SessionRecord[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out: SessionRecord[] = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"))); } catch {}
  }
  return out;
}

// "Resume key" identifies a recurring login from the same terminal: same
// cwd, same tty. Lets `init` offer "you were orion last time, resume?"
// instead of forcing the user to redeclare each restart.
export function resumeKey(cwd: string, tty: string | undefined): string {
  return `${cwd}|${tty ?? ""}`;
}

export function findResumableSession(rk: string): SessionRecord | null {
  for (const rec of listSessions()) {
    if (resumeKey(rec.cwd, rec.tty) !== rk) continue;
    // Only offer resume if the original pid is gone (recycled OR dead).
    // processIsOriginal returns false on a recycled-pid mismatch, which is
    // exactly the case where resume IS appropriate.
    if (!processIsOriginal(rec.pid, rec.pid_starttime)) return rec;
  }
  return null;
}

export function findLivePresence(agent: string): SessionRecord | null {
  const f = presenceFile(agent);
  if (!fs.existsSync(f)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(f, "utf8")) as SessionRecord;
    // Foreign-host records belong to a different machine sharing this
    // filesystem (NFS/sshfs). Their pid is meaningless on us — checking
    // pidIsAlive against our pid namespace would either falsely match
    // (recycled local pid) or falsely reject (live remote pid we can't see).
    // The only safe answer is "not mine, ignore." See cadence F8.
    if (rec.host !== os.hostname()) return null;
    return processIsOriginal(rec.pid, rec.pid_starttime) ? rec : null;
  } catch { return null; }
}

// Atomic exclusive-create write: open with O_CREAT|O_EXCL so the call fails
// with EEXIST if the file already exists, never silently truncating.
//
// Used for filesystem-as-mutex primitives: the lock file (one writer at a
// time) and the presence file (one session per agent name). The previous
// `fs.writeFileSync(p, …)` was create-or-truncate, which lets two
// concurrent callers both "succeed" with the second silently overwriting
// the first.
//
// NFS caveat: O_EXCL semantics on NFSv2/v3 are historically lossy (the
// server may report success when another client already holds the file).
// All current users of this skill are on local filesystems, so the simple
// implementation suffices. If multi-host filesystem use ever ships,
// switch to a link()-based fallback for NFSv2/v3.
export function exclusiveWriteOrFail(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "wx");
  try { fs.writeFileSync(fd, content); }
  finally { fs.closeSync(fd); }
}

export function resolveIdentity(cwd: string = process.cwd()): Identity {
  // 1. Per-session file (Claude session id or parent shell pid). This is the
  //    high-N path: ten sessions in the same cwd each have their own session
  //    record and never need env vars.
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (rec) {
    return { name: rec.agent, topology: rec.topology, source: `session:${key}` };
  }
  // 2. $AGENT_NAME + $AGENT_TOPOLOGY env vars
  const envName = process.env.AGENT_NAME;
  const envTopo = process.env.AGENT_TOPOLOGY;
  if (envName && envTopo) {
    try {
      const fileId = readAgentNameFile(cwd);
      if (fileId && (fileId.name !== envName || fileId.topology !== envTopo)) {
        console.error(
          `[agent-chat] WARNING: .agent-name in ${cwd} says "${fileId.name}@${fileId.topology}" ` +
          `but env says "${envName}@${envTopo}" — using env. If you have two sessions sharing ` +
          `this directory, that's expected. If not, remove or update .agent-name.`,
        );
      }
    } catch (err) {
      console.error(`[agent-chat] WARNING: ${(err as Error).message}`);
    }
    return { name: envName, topology: envTopo, source: "env" };
  }
  // 3. ./.agent-name file
  const fileId = readAgentNameFile(cwd);
  if (fileId) {
    return { name: fileId.name, topology: fileId.topology, source: ".agent-name" };
  }
  throw new Error(
    `cannot resolve identity — run \`bun scripts/agent-chat.ts init <name> [<topology>]\`, ` +
    `or set $AGENT_NAME + $AGENT_TOPOLOGY, or write .agent-name in ${cwd}.`,
  );
}

// Process fingerprint for *display* purposes (resolve.ts whoami, init banner).
// Reflects the actual current bun process pid so the user can see "this exact
// bun is here right now". Don't use this for lock files — see lockTag below.
export function processTag(name: string): string {
  return `${name}@${os.hostname()}:${process.pid}`;
}

// Lock-file fingerprint: agent@host:<stable-session-pid>. The lock body
// records the long-lived agent runtime ancestor pid (Claude Code main
// process, or the user's terminal pid for plain shell), NOT the
// short-lived bun pid. With process.pid, every bun spawn looks like a
// "stale lock" the moment it returns; with stableSessionPid, the lock
// looks fresh as long as the Claude Code session is alive, and goes
// stale only when that session genuinely exits.
// Lock body wire format: `<agent>@<host>:<pid>:<starttime> <ts>` (4-tuple).
// The previous format was `<agent>@<host>:<pid> <ts>` (3-tuple); parseLockFile
// accepts both for one release so an in-flight upgrade doesn't strand
// already-held locks. Embedding starttime lets unlock/flip/park reject foreign
// recycled-pid claimants the same way SessionRecord+processIsOriginal does.
export function lockTag(name: string): string {
  const sp = stableSessionPid();
  const st = pidStarttime(sp);
  return `${name}@${os.hostname()}:${sp}:${st ?? 0}`;
}

// Parse a lock file body of the form "<agent>@<host>:<pid>:<starttime> <ts>"
// (new) or "<agent>@<host>:<pid> <ts>" (legacy). When the legacy form is
// observed, `starttime` is null and callers fall back to pidIsAlive.
export function parseLockFile(
  p: string,
): { agent: string; host: string; pid: number; starttime: number | null; ts: string } | null {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8").trim();
  // Try 4-tuple first.
  let m = text.match(/^(\S+)@([^:\s]+):(\d+):(\d+)\s+(\S+)$/);
  if (m) {
    const st = parseInt(m[4], 10);
    return { agent: m[1], host: m[2], pid: parseInt(m[3], 10), starttime: st > 0 ? st : null, ts: m[5] };
  }
  // Legacy 3-tuple.
  m = text.match(/^(\S+)@([^:\s]+):(\d+)\s+(\S+)$/);
  if (!m) return null;
  return { agent: m[1], host: m[2], pid: parseInt(m[3], 10), starttime: null, ts: m[4] };
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence test, doesn't actually signal
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err?.code === "EPERM";
  }
}

// Return the kernel start_time of `pid` as an opaque comparable number, or
// null if we can't read it. Linux: `/proc/<pid>/stat` field 22 (clock ticks
// since boot, monotonic for the lifetime of the kernel). macOS: parse
// `ps -p <pid> -o lstart=` to ms-since-epoch. Other platforms: null.
//
// The returned number is a fingerprint, not a timestamp — only equality
// matters. Treat it as opaque.
//
// macOS `ps` shells out (~10ms); call sparingly (init, gc, exit).
export function pidStarttime(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (1-indexed) is starttime in clock ticks. The comm field
      // (field 2) is parenthesized and may contain spaces, so split by the
      // last `)` rather than naïve whitespace.
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return null;
      const fields = stat.slice(rparen + 2).split(/\s+/);
      // After ")", field 3 (state) is fields[0], so starttime is fields[19].
      const t = parseInt(fields[19] ?? "", 10);
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    try {
      const r = require("node:child_process").spawnSync(
        "ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: 2000 },
      );
      if (r.status !== 0) return null;
      const t = Date.parse(r.stdout.trim());
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  }
  return null;
}

// "Is this pid still the same process whose start_time we recorded?"
// `expected == null/undefined` means we don't have a fingerprint for it
// (legacy SessionRecord, non-Linux/non-macOS, or initial recording failed).
// In that case fall back to identity-blind pidIsAlive — same behavior as
// before, no regression.
//
// When we DO have a fingerprint, this rejects (a) dead pids and (b) pids
// recycled to a different process. That closes the gc-deletes-foreign-state
// loophole and the exit-kills-wrong-pid race.
export function processIsOriginal(pid: number, expected: number | null | undefined): boolean {
  if (!pidIsAlive(pid)) return false;
  if (expected == null) return true;
  const actual = pidStarttime(pid);
  if (actual == null) return true; // can't verify on this platform; trust pidIsAlive
  return actual === expected;
}

// Find the pid of the long-lived agent runtime that ultimately spawned the
// current bun process. Under Claude Code, every Bash() invocation gets a
// freshly-spawned shell as its parent, so process.ppid is dead by the time
// anyone checks. We need an ancestor pid that survives the whole user
// session.
//
// Strategy: Claude Code sets CLAUDECODE=1 in the env of its child processes.
// That means every descendant of the Claude Code main process has the
// marker, but the Claude Code process itself does NOT (its own env was
// inherited from the user's shell, which doesn't set it). So the Claude
// Code main process is the first ancestor *without* the marker whose
// child *had* it.
//
// Walk up /proc/<pid>/status (Linux only); track whether the previous
// (deeper) ancestor had the marker; return the first ancestor where we
// transition from has-marker → no-marker. Falls back to process.ppid for
// plain shells, non-Linux platforms, when /proc isn't readable, or when
// the current process isn't running under Claude Code.
export function stableSessionPid(): number {
  if (process.env.CLAUDECODE !== "1") {
    // Plain shell / Codex: ppid is the user's terminal, which is itself
    // long-lived enough.
    return process.ppid || process.pid;
  }
  if (process.platform === "linux") return stableSessionPidLinux();
  if (process.platform === "darwin") return stableSessionPidDarwin();
  return process.ppid || process.pid;
}

function stableSessionPidLinux(): number {
  let pid = process.ppid;
  let prevHadMarker = true; // we (the bun process) have CLAUDECODE=1 set
  const seen = new Set<number>();
  for (let depth = 0; depth < 30 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    let hasMarker = false;
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      hasMarker = environ.split("\0").includes("CLAUDECODE=1");
    } catch { break; }
    if (prevHadMarker && !hasMarker) return pid;
    prevHadMarker = hasMarker;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s*(\d+)/m);
      if (!m) break;
      const ppid = parseInt(m[1], 10);
      if (ppid <= 1) break;
      pid = ppid;
    } catch { break; }
  }
  // Walked the depth ceiling without finding the marker transition — likely
  // an unusual process tree (daemonized parent, container init, etc.). Warn
  // so the user can investigate; lock identity is unstable in this state.
  if (seen.size >= 30) {
    console.error(`[agent-chat] stableSessionPid: walked 30 ancestors without finding the Claude Code main process; falling back to ppid=${process.ppid}.`);
  }
  return process.ppid || process.pid;
}

// macOS marker-walk. /proc isn't available; we shell out to `ps -E -o command=`
// (env disclosure for our own user's processes only) to read each ancestor's
// environment block, looking for the same CLAUDECODE=1 → no-CLAUDECODE
// transition that the Linux walk uses. ~10ms per step, walk usually 1-3 deep
// — acceptable for `init`/`lock`/`unlock` cadence.
function stableSessionPidDarwin(): number {
  const cp = require("node:child_process") as typeof import("node:child_process");
  function envHasMarker(pid: number): boolean | null {
    try {
      const r = cp.spawnSync("ps", ["-E", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
      if (r.status !== 0) return null;
      // `ps -E` prepends the process's environment to the command. We just
      // want to know whether `CLAUDECODE=1` appears anywhere in the line.
      return / CLAUDECODE=1(\s|$)/.test(" " + r.stdout.trim());
    } catch { return null; }
  }
  function ppidOf(pid: number): number | null {
    try {
      const r = cp.spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 2000 });
      if (r.status !== 0) return null;
      const p = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch { return null; }
  }
  let pid = process.ppid;
  let prevHadMarker = true;
  const seen = new Set<number>();
  for (let depth = 0; depth < 30 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const marker = envHasMarker(pid);
    if (marker == null) break;
    if (prevHadMarker && !marker) return pid;
    prevHadMarker = marker;
    const next = ppidOf(pid);
    if (next == null || next <= 1) break;
    pid = next;
  }
  return process.ppid || process.pid;
}

// Canonical edge id is "<lo>-<hi>" (alphabetical) so each edge maps to one path
// regardless of which side is talking.
export function edgeId(a: string, b: string): string {
  return [a, b].sort().join("-");
}

export function neighborsOf(t: Topology, name: string): string[] {
  const out = new Set<string>();
  for (const [a, b] of t.edges) {
    if (a === name) out.add(b);
    else if (b === name) out.add(a);
  }
  return [...out].sort();
}

export function edgesOf(t: Topology, name: string): { peer: string; id: string; dir: string; convo: string; turn: string; lock: string }[] {
  return neighborsOf(t, name).map((peer) => {
    const id = edgeId(name, peer);
    const dir = path.join(CONVERSATIONS_DIR, t.topology, id);
    const convo = path.join(dir, "CONVO.md");
    const turn = path.join(dir, "CONVO.md.turn");
    const lock = path.join(dir, "CONVO.md.turn.lock");
    return { peer, id, dir, convo, turn, lock };
  });
}

export function ensureEdgeFiles(edge: ReturnType<typeof edgesOf>[number], participants: [string, string]) {
  fs.mkdirSync(edge.dir, { recursive: true });
  if (!fs.existsSync(edge.convo)) {
    const header = `# CONVO — ${participants[0]} ↔ ${participants[1]}\n\nProtocol: agent-chat\nParticipants: ${participants[0]}, ${participants[1]}\n\nOnly the agent named in CONVO.md.turn may append.\nIf CONVO.md.turn is parked, do not write unless explicitly resumed.\n`;
    fs.writeFileSync(edge.convo, header);
  }
  // Note: .turn is intentionally NOT created here. Whoever initializes the edge picks first writer.
}

export function readTurn(turnFile: string): string | null {
  if (!fs.existsSync(turnFile)) return null;
  return fs.readFileSync(turnFile, "utf8").trim();
}

export function writeTurnAtomic(turnFile: string, value: string) {
  const tmp = `${turnFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, turnFile);
}

export function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Archive layer (LCM-inspired). Per-edge DAG of summary nodes.
//
//   archives/leaf/<archive-id>/        depth=0, source=raw CONVO.md sections
//     BODY.md       — verbatim transcript chunk (sealed, never edited)
//     SUMMARY.md    — human/agent-written summary; MUST end with the
//                     "Expand for details about: ..." footer
//     META.yaml     — id, depth, kind, time_range, body_sha256, parents,
//                     children, descendant_count, keywords, file_refs
//
//   archives/condensed/d1/<archive-id>/   depth=1, parents= leaf summaries
//   archives/condensed/d2/<archive-id>/   depth=2, parents= d1 summaries
//   archives/condensed/d3/<archive-id>/   depth>=3, durable
//
// Plus per-edge `index.jsonl` (one line per archive at any depth) so search.ts
// doesn't need to walk the tree to filter by keyword/time/peer.
// ---------------------------------------------------------------------------

export type ArchiveKind = "leaf" | "condensed";
export type ArchiveDepth = 0 | 1 | 2 | 3; // 3 collapses to "d3+"; META can carry exact depth

export type IndexEntry = {
  id: string;
  edge_id: string;
  topology: string;
  kind: ArchiveKind;
  depth: number;
  earliest_at: string;
  latest_at: string;
  participants: [string, string];
  parents: string[];           // child summary ids this one folds (condensed only)
  descendant_count: number;    // total number of leaf sources under this node
  keywords: string[];
  tldr: string;                // first 240 chars of TL;DR for cheap grep
  body_sha256?: string;        // present only for leaves
  path: string;                // absolute path to the archive directory
};

export function archiveId(kind: ArchiveKind, latestAt: string): string {
  // arch_<kind-prefix>_<UTC compact>_<short hash>
  // Keeps archive ids sortable by time and visibly typed.
  const stamp = latestAt.replace(/[-:T]/g, "").replace(/Z$/, "");
  const rand = crypto.randomBytes(4).toString("hex");
  const prefix = kind === "leaf" ? "L" : "C";
  return `arch_${prefix}_${stamp}_${rand}`;
}

export function archivesRoot(edgeDir: string): string {
  return path.join(edgeDir, "archives");
}

export function leafArchiveDir(edgeDir: string, id: string): string {
  return path.join(archivesRoot(edgeDir), "leaf", id);
}

export function condensedArchiveDir(edgeDir: string, depth: number, id: string): string {
  const bucket = depth >= 3 ? "d3" : `d${depth}`;
  return path.join(archivesRoot(edgeDir), "condensed", bucket, id);
}

export function indexFile(edgeDir: string): string {
  return path.join(edgeDir, "index.jsonl");
}

// Atomic write: tmpfile + rename in the same directory. The destination is
// either fully present (post-rename) or absent — never half-written. With
// `fsync: true`, also flush the data to disk before the rename, so a power
// loss between write and the page cache flush can't strand a 0-byte file.
// Used by archive seal (which destroys the source) and by appendIndexEntry
// when called from a commit path (durability matters once we've validated).
export function writeFileAtomic(p: string, content: string, opts: { fsync?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    if (opts.fsync) fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}

export function appendIndexEntry(
  edgeDir: string,
  entry: IndexEntry,
  opts: { fsync?: boolean } = {},
): void {
  fs.mkdirSync(edgeDir, { recursive: true });
  const f = indexFile(edgeDir);
  // O_APPEND on local FS is whole-record atomic for any single write up to
  // the underlying inode rwsem boundary — rhino's race testing confirmed
  // 1KB-1MB at 4 concurrent writers produces zero interleaving. The fsync
  // is opt-in for commit paths only (durability matters once we've passed
  // the validator) so non-commit callers don't pay the cost.
  if (opts.fsync) {
    const fd = fs.openSync(f, "a");
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } else {
    fs.appendFileSync(f, JSON.stringify(entry) + "\n");
  }
}

// Snapshot read of a growing append-only file. Open, fstat once, then
// readSync exactly that many bytes. Bun's readFileSync may return more
// bytes than the open-time fstat-size on a file that's being appended,
// which captures the leading bytes of an in-flight entry as a torn line.
// Bounding the read to the fstat-size makes the trailing line either
// complete (if the writer finished before our open) or absent (if the
// writer is mid-append) — never half-present. See rhino #3.
function readIndexSnapshot(f: string): string {
  const fd = fs.openSync(f, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return "";
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function readIndex(edgeDir: string): IndexEntry[] {
  const f = indexFile(edgeDir);
  if (!fs.existsSync(f)) return [];
  // Pair patch with readIndexSnapshot: bounded read defeats the over-read,
  // per-line try/catch defeats both a corrupt line that snuck in and the
  // residual torn-trailer case that snapshot can still observe under ext4's
  // per-page i_size update window. Either patch alone leaves a hole.
  const out: IndexEntry[] = [];
  for (const line of readIndexSnapshot(f).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as IndexEntry); }
    catch (err) {
      console.error(`[agent-chat] readIndex: skipping malformed line in ${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONVO.md section parser + fresh-tail splitter.
//
// A "section" is a markdown block that begins with `## ` or `---` (separator)
// and ends just before the next one. The header preamble (everything before
// the first section) is preserved across archive cycles. Fresh-tail = the last
// K sections, never archived; that's how LCM keeps recent raw context cheap.
// ---------------------------------------------------------------------------

export type ConvoSplit = {
  header: string;             // preamble before any section, kept verbatim
  archivable: string;         // sections that should go into the leaf archive
  freshTail: string;          // last K sections, kept in CONVO.md
  sectionCount: number;       // total sections (excluding the header)
  archivableSectionCount: number;
};

export function parseSections(convoText: string): { header: string; sections: string[] } {
  // Section starts at a line beginning with `## ` (markdown h2) preceded by
  // a `---` separator or BOF. We treat the preamble as everything up to the
  // first `## ` line (LCM-style), and slice on `## ` headers from there.
  const lines = convoText.split(/\r?\n/);
  let firstSection = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \S/.test(lines[i])) { firstSection = i; break; }
  }
  if (firstSection === -1) {
    return { header: convoText, sections: [] };
  }
  // Strip a trailing `---` separator from the header (it belongs to the first section).
  let headerEnd = firstSection;
  while (headerEnd > 0 && /^(\s*|---\s*)$/.test(lines[headerEnd - 1])) headerEnd--;
  const header = lines.slice(0, headerEnd).join("\n").replace(/\n+$/, "") + "\n";

  const sections: string[] = [];
  let cur: string[] = [];
  for (let i = firstSection; i < lines.length; i++) {
    if (/^## \S/.test(lines[i]) && cur.length) {
      sections.push(cur.join("\n").replace(/\n+$/, ""));
      cur = [];
    }
    cur.push(lines[i]);
  }
  if (cur.length) sections.push(cur.join("\n").replace(/\n+$/, ""));
  return { header, sections };
}

export function splitForArchive(convoText: string, freshTailCount: number): ConvoSplit {
  const { header, sections } = parseSections(convoText);
  const tailStart = Math.max(0, sections.length - freshTailCount);
  const archivableSections = sections.slice(0, tailStart);
  const tailSections = sections.slice(tailStart);
  const sep = "\n\n---\n\n";
  return {
    header,
    archivable: archivableSections.length ? archivableSections.join(sep) + "\n" : "",
    freshTail: tailSections.length ? tailSections.join(sep) + "\n" : "",
    sectionCount: sections.length,
    archivableSectionCount: archivableSections.length,
  };
}

// Best-effort timestamp + author extraction from a section header:
//   ## <author> — <topic> (UTC YYYY-MM-DDTHH:MM:SSZ)
// Falls back to (file mtime, "unknown") if a section doesn't match.
export function sectionMeta(section: string): { author: string; ts: string | null } {
  const m = section.match(/^##\s+([A-Za-z0-9_-]+)\s+—.*?\(UTC\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\)/m);
  if (!m) return { author: "unknown", ts: null };
  return { author: m[1].toLowerCase(), ts: m[2] };
}

export function timeRangeOf(sections: string[]): { earliest: string; latest: string } {
  const stamps = sections.map((s) => sectionMeta(s).ts).filter((t): t is string => !!t).sort();
  const fallback = utcStamp();
  return { earliest: stamps[0] ?? fallback, latest: stamps[stamps.length - 1] ?? fallback };
}

// ---------------------------------------------------------------------------
// Summary template + validator. Inspired by lossless-claw's depth-aware
// prompts: depth 0 (leaf/segment), 1 (session), 2 (phase), 3+ (durable).
// Each depth specifies what to PRESERVE and what to DROP, and every summary
// must end with the exact `Expand for details about:` line so the model can
// decide whether the `expand` step is worth running.
// ---------------------------------------------------------------------------

export type SummaryRenderInput = {
  edgeId: string;
  archiveId: string;
  kind: ArchiveKind;
  depth: number;
  participants: [string, string];
  earliestAt: string;
  latestAt: string;
  sourceLabel: string;        // "raw sections" for leaf, "child summaries" for condensed
  sourceText: string;         // body to summarize, embedded in HTML comment
};

export function depthPolicy(depth: number, kind: ArchiveKind): { policy: string; targetTokens: number } {
  if (kind === "leaf") {
    return {
      policy: [
        "Normal leaf policy (depth 0):",
        "- Preserve key decisions, rationale, constraints, and active tasks.",
        "- Keep essential technical details needed to continue work safely.",
        "- Remove obvious repetition and conversational filler.",
        "- Track artifact references (paths, commits, nodes) explicitly.",
      ].join("\n"),
      targetTokens: 1000,
    };
  }
  if (depth === 1) {
    return {
      policy: [
        "Depth-1 (session) policy:",
        "- Compact several leaf summaries into one session-level memory.",
        "- Preserve decisions and outcomes; drop intermediate dead ends.",
        "- Mark superseded decisions and what replaced them.",
        "- Include a brief timeline (hour/half-hour granularity).",
      ].join("\n"),
      targetTokens: 1500,
    };
  }
  if (depth === 2) {
    return {
      policy: [
        "Depth-2 (phase) policy:",
        "- A future model should understand trajectory, not per-session minutiae.",
        "- Preserve decisions still in effect, completed work and outcomes,",
        "  active constraints, and current state of in-progress work.",
        "- Drop session-local operational detail and identifiers no longer relevant.",
        "- Include a timeline with dates + approximate time-of-day.",
      ].join("\n"),
      targetTokens: 1800,
    };
  }
  return {
    policy: [
      "Depth-3+ (durable) policy:",
      "- This summary may persist for the rest of the conversation.",
      "- Keep only durable context: key decisions and rationale, what was",
      "  accomplished, active constraints, important relationships, durable lessons.",
      "- Drop method details unless the method itself was the decision.",
      "- Be concise. Brief headers acceptable.",
    ].join("\n"),
    targetTokens: 2000,
  };
}

export function renderSummaryStub(inp: SummaryRenderInput): string {
  const { policy, targetTokens } = depthPolicy(inp.depth, inp.kind);
  // The stub embeds the source text inside an HTML comment so the agent can
  // read it while filling in the summary, but the resulting SUMMARY.md is
  // self-contained when stripped of the comment block (`<!-- ... -->`).
  return [
    `# SUMMARY — ${inp.edgeId} · ${inp.kind} · depth ${inp.depth} · ${inp.earliestAt} → ${inp.latestAt}`,
    "",
    `<archive-id: ${inp.archiveId}>`,
    `<participants: ${inp.participants.join(", ")}>`,
    `<source: ${inp.sourceLabel}>`,
    "",
    "## TL;DR",
    "<!-- 3 lines max. Lead with: what was decided, what is blocked, what is next.",
    "     Replace the example below with your real summary — `(none)` is NOT accepted here. -->",
    "Adopted strategy X over alternative Y after evaluating Z; one blocker remains in module M; next step is to land PR #123.",
    "",
    "## Decisions",
    "<!-- One bullet per decision. `(none) — explanation` is acceptable when no",
    "     decision was reached, e.g. `(none) — ran out of time, see follow-ups`. -->",
    "- adopted X over Y because Z (see commit abc1234)",
    "",
    "## Blockers",
    "- (none)  <!-- or: describe the blocker with owner and evidence ref -->",
    "",
    "## Follow-ups",
    "- (none)  <!-- or: describe each follow-up and why it is non-blocking -->",
    "",
    "## Artifacts referenced",
    "- (none)  <!-- or: list paths, commits, archive ids -->",
    "",
    "## Keywords",
    "<!-- ≥3 distinct alphanumeric tokens of length ≥3, comma-separated. Replace these. -->",
    "scan-orchestration, edge-flip, lock-presence",
    "",
    "## Expand for details about:",
    "<!-- Comma-separated list of what was DROPPED or COMPRESSED. Required —",
    "     `(none)` is NOT accepted here; this is the signal that lets a future",
    "     agent decide whether to read BODY.md. -->",
    "exact phrasing of the rejected alternative, intermediate dead ends, why we ruled out method M",
    "",
    "<!-- ====================================================================",
    `${policy}`,
    `Target length: about ${targetTokens} tokens or less.`,
    "Keep the section headings above; the validator checks for them by name.",
    "Once you've filled in every TODO, remove this comment block and any other",
    "<!-- ... --> blocks before saving.",
    "==================================================================== -->",
    "",
    "<!-- ====== source begins below — strip before committing the summary ======",
    inp.sourceText,
    "====== source ends ====== -->",
    "",
  ].join("\n");
}

export type SummaryValidation = {
  ok: boolean;
  issues: string[];
};

const REQUIRED_SECTIONS = [
  "TL;DR",
  "Decisions",
  "Blockers",
  "Follow-ups",
  "Artifacts referenced",
  "Keywords",
  "Expand for details about:",
];

// Sections that must contain substantive content. The other three
// (Blockers / Follow-ups / Artifacts referenced) may legitimately be `(none)`.
const REQUIRES_REAL_BODY: ReadonlySet<string> = new Set([
  "TL;DR",
  "Decisions",
  "Keywords",
  "Expand for details about:",
]);

// A "placeholder line" is a whole-line value that conveys no information:
// `(none)`, `n/a`, `tbd`, `todo`, `xxx`, `wip`, `placeholder`, single em/en
// dash, single dot, single underscore. Surrounding list-bullet decoration
// (`-`, `*`) and parenthesis are tolerated; anything else on the line means
// the writer added real content alongside the placeholder.
const PLACEHOLDER_LINE = /^[\s\-*]*\(?\s*(?:none|n\/a|tbd|todo|fixme|xxx|wip|placeholder|—|–|\.|_)\s*\)?[\s\-*]*$/i;

// Generic regex escape — covers every metacharacter, not the partial set
// the previous validator escaped. Future-proofs new entries in
// REQUIRED_SECTIONS that may contain `(`, `)`, `*`, etc.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateSummary(text: string): SummaryValidation {
  // Normalize CR / CRLF to LF so the line-anchored regex below has a
  // consistent terminator to scan against. Then strip HTML comments
  // (lifting their trailing newline so the comment-removal does not
  // leave a blank line inside what should be a body) and fenced code
  // blocks (without this, a SUMMARY.md entirely wrapped in triple
  // backticks renders as a single empty code block but satisfies the
  // heading regex on the raw markdown).
  const stripped = text
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  const issues: string[] = [];

  // 1. Heading presence + uniqueness. `[^\S\n]+` requires non-newline
  // whitespace between `##` and the heading name (closing the
  // line-split bypass), and the trailing `[^\S\n]*$` likewise refuses
  // to span a newline.
  for (const heading of REQUIRED_SECTIONS) {
    const re = new RegExp(`^##[^\\S\\n]+${escapeRegex(heading)}[^\\S\\n]*$`, "gm");
    const matches = stripped.match(re) ?? [];
    if (matches.length === 0) issues.push(`missing section: "## ${heading}"`);
    else if (matches.length > 1) issues.push(`duplicate section: "## ${heading}"`);
  }

  // 2. Broadened placeholder-marker check. The original validator only
  // caught uppercase `TODO`; this catches the common alternatives
  // (TBD/FIXME/XXX/WIP/PLACEHOLDER) case-insensitively.
  if (/\b(?:todo|fixme|xxx|tbd|wip|placeholder)\b/i.test(stripped)) {
    issues.push("unfilled placeholder marker remains (TODO/FIXME/XXX/TBD/WIP/PLACEHOLDER)");
  }

  // Body capture: stop at the next `## ` heading or absolute end of
  // string. Crucially do NOT stop at a blank line — paragraph breaks
  // inside a body are normal markdown and a comment-strip can also
  // leave a residual blank line ahead of the real content.
  const bodyRegex = (heading: string) =>
    new RegExp(
      `^##[^\\S\\n]+${escapeRegex(heading)}[^\\S\\n]*\\n([\\s\\S]*?)(?=^##[^\\S\\n]|$(?![\\s\\S]))`,
      "m",
    );

  // 3. Real-body check for the four sections that must have substantive
  // content. A body is "real" when at least one line is not a
  // placeholder and the body contains at least one ≥2-char alphanumeric
  // token.
  for (const heading of REQUIRES_REAL_BODY) {
    const m = stripped.match(bodyRegex(heading));
    const body = (m?.[1] ?? "").trim();
    if (!body) {
      issues.push(`section "${heading}" has empty body`);
      continue;
    }
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const allPlaceholder = lines.length > 0 && lines.every((l) => PLACEHOLDER_LINE.test(l));
    if (allPlaceholder) issues.push(`section "${heading}" is all placeholder tokens`);
    if (!/[\p{L}\p{N}]{2,}/u.test(body)) {
      issues.push(`section "${heading}" has no real-word tokens`);
    }
  }

  // 4. Keywords: at least 3 distinct alphanumeric tokens of length ≥3,
  // case-insensitive. Defeats single-glyph and zero-width-space bypasses.
  const kwM = stripped.match(bodyRegex("Keywords"));
  if (kwM) {
    const toks = new Set(
      kwM[1]
        .split(/[,\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[\p{L}\p{N}_-]{3,}$/u.test(s)),
    );
    if (toks.size < 3) {
      issues.push("Keywords requires ≥3 distinct alphanumeric tokens of length ≥3");
    }
  }

  // 5. Expand-for-details: at least one item that is not a placeholder.
  const exM = stripped.match(bodyRegex("Expand for details about:"));
  if (exM) {
    const items = exM[1]
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !PLACEHOLDER_LINE.test(s));
    if (items.length === 0) {
      issues.push("Expand-for-details has no real items (all placeholder)");
    }
  }

  return { ok: issues.length === 0, issues };
}

export function extractTldr(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/^##\s+TL;DR\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!m) return "";
  return m[1].trim().split(/\n/).slice(0, 3).join(" ").trim().slice(0, 240);
}

export function extractKeywords(text: string): string[] {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/^##\s+Keywords\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!m) return [];
  return m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

// Minimal YAML emitter for our limited META schema. Strings are quoted.
export function writeYaml(p: string, obj: Record<string, unknown>): void {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) { out.push(`${k}: []`); continue; }
      // Inline arrays of scalars; block-style for arrays of arrays.
      if (v.every((x) => typeof x === "string" || typeof x === "number")) {
        out.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
      } else {
        out.push(`${k}:`);
        for (const x of v) out.push(`  - ${JSON.stringify(x)}`);
      }
    } else if (v && typeof v === "object") {
      out.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out.push(`  ${k2}: ${JSON.stringify(v2)}`);
      }
    } else {
      out.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  fs.writeFileSync(p, out.join("\n") + "\n");
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
