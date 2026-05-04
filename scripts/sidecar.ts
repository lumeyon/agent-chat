// sidecar.ts — long-lived per-agent daemon for the agent-chat skill.
//
// One sidecar per agent session, started by `agent-chat init` and stopped by
// `agent-chat exit`. Listens on a Unix domain socket at:
//   <CONVERSATIONS_DIR>/.sockets/<agent>.sock
// with mode 0600 (owner-only) for filesystem-permission auth.
//
// Wire format: line-delimited JSON. One request per line, one response per
// line. Cross-runtime by construction — any language with a UDS client and a
// JSON parser can speak this.
//
// Slice 1 (this file at this revision) implements:
//   - lifecycle (pidfile, stale-socket reclamation, graceful shutdown)
//   - identity resolution (same as every other script in the skill)
//   - UDS bind with mode 0600
//   - dispatcher with three methods: whoami, time, health
//
// Subsequent slices add: peek, last-section (slice 2); fs.watch + diff cache
// + monitor-format stdout emission (slice 3); unread, since-last-spoke +
// cursor persistence (slice 4); lifecycle integration with agent-chat.ts
// (slice 5).
//
// Usage (normally invoked via `agent-chat init`, but can be run standalone):
//   bun scripts/sidecar.ts                    # daemonize-style run (no daemonize fork; rely on init)
//   bun scripts/sidecar.ts --foreground       # explicit foreground for tests/debugging
//   bun scripts/sidecar.ts --once             # bind, log readiness, exit (smoke test only)

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf,
  socketPathFor, pidFilePath, cursorsFilePath,
  ensureControlDirs,
  exclusiveWriteOrFail, writeFileAtomic,
  pidIsAlive, pidStarttime, processIsOriginal, stableSessionPid,
  utcStamp, readTurn, parseLockFile, parseSections, sectionMeta,
  readSessionRecord, currentSessionKey,
  readCurrentSpeaker,
  type SessionRecord, type CurrentSpeaker,
} from "./lib.ts";
import {
  formatHeartbeat, heartbeatPath, SIDECAR_HEARTBEAT_VERSION,
} from "./liveness.ts";

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

type Args = {
  foreground: boolean;     // log to stderr too; lets test harnesses tail
  once: boolean;           // bind + announce + exit (used only by smoke tests)
  staleConnectTimeoutMs: number;
  noWatch: boolean;        // disable fs.watch (slice 3) for tests/debug
  watchDebounceMs: number; // coalesce burst events through a per-edge timer
  reconcilePollMs: number; // belt-and-braces poll for misses on fs.watch
  staleLockSec: number;    // mirror monitor.ts default
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    foreground: false, once: false, staleConnectTimeoutMs: 200,
    noWatch: false, watchDebounceMs: 25, reconcilePollMs: 5000, staleLockSec: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--foreground") a.foreground = true;
    else if (argv[i] === "--once") a.once = true;
    else if (argv[i] === "--stale-connect-timeout-ms") a.staleConnectTimeoutMs = Math.max(20, parseInt(argv[++i] ?? "200", 10));
    else if (argv[i] === "--no-watch") a.noWatch = true;
    else if (argv[i] === "--watch-debounce-ms") a.watchDebounceMs = Math.max(0, parseInt(argv[++i] ?? "25", 10));
    else if (argv[i] === "--reconcile-poll-ms") a.reconcilePollMs = Math.max(500, parseInt(argv[++i] ?? "5000", 10));
    else if (argv[i] === "--stale-lock-sec") a.staleLockSec = Math.max(1, parseInt(argv[++i] ?? "30", 10));
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Identity, edges, log
// ---------------------------------------------------------------------------

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);
const startedAt = utcStamp();
const startedAtMs = Date.now();

ensureControlDirs();

const socketPath = socketPathFor(id.name);
const pidFile = pidFilePath(id.name, "sidecar");

const errors: { ts: string; msg: string }[] = [];
function recordError(msg: string): void {
  errors.unshift({ ts: utcStamp(), msg });
  while (errors.length > 32) errors.pop();
  log(`error: ${msg}`);
}

// Stdout is reserved for monitor-format notifications (added in slice 3).
// Slice 1 logs through console.error so it shows up in the .log file but
// doesn't pollute the stdout-as-event-stream contract.
function log(msg: string): void {
  const line = `[sidecar:${id.name}] ${utcStamp()} ${msg}`;
  console.error(line);
}

// ---------------------------------------------------------------------------
// Pidfile + stale socket reclamation
//
// Three independent guards prevent two sidecars for the same agent on the
// same host:
//   1. pidfile via O_EXCL: write fails EEXIST if a previous sidecar didn't
//      clean up. We then check whether the recorded pid is still original
//      (pid+starttime). If yes → another sidecar is alive; exit. If no →
//      stale; unlink and retry.
//   2. socket file inspected for liveness via async net.connect probe (with
//      a short timeout). Live connect → another sidecar; exit. ECONNREFUSED
//      → stale; unlink and listen.
//   3. server.listen() throws EADDRINUSE if the socket file exists AND a
//      process is bound to it. Belt-and-braces.
// ---------------------------------------------------------------------------

function writePidFile(): void {
  const myPid = process.pid;
  const myStart = pidStarttime(myPid);
  const body = `${myPid} ${myStart ?? 0} ${startedAt}\n`;
  try {
    exclusiveWriteOrFail(pidFile, body);
    return;
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
  }
  // EEXIST: parse, check liveness.
  let prevPid = 0;
  let prevStart: number | null = null;
  try {
    const text = fs.readFileSync(pidFile, "utf8").trim();
    const m = text.match(/^(\d+)\s+(\d+)/);
    if (m) {
      prevPid = parseInt(m[1], 10);
      const s = parseInt(m[2], 10);
      prevStart = s > 0 ? s : null;
    }
  } catch {}
  if (prevPid > 0 && processIsOriginal(prevPid, prevStart ?? undefined)) {
    log(`another sidecar already live: pid ${prevPid}; exiting.`);
    process.exit(0);
  }
  // Stale; replace.
  try { fs.unlinkSync(pidFile); } catch {}
  exclusiveWriteOrFail(pidFile, body);
}

function probeStaleSocket(timeoutMs: number): Promise<"alive" | "stale" | "absent"> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve("absent"); return; }
    const sock = new net.Socket();
    let settled = false;
    const done = (s: "alive" | "stale" | "absent") => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(s);
    };
    sock.setTimeout(timeoutMs, () => done("stale"));
    sock.once("connect", () => done("alive"));
    sock.once("error", () => done("stale"));
    try { sock.connect(socketPath); } catch { done("stale"); }
  });
}

// ---------------------------------------------------------------------------
// Dispatcher (slice 1: whoami, time, health)
// ---------------------------------------------------------------------------

type Request = { id?: number | string; method?: string; params?: any };
type Ok = { id: number | string | null; ok: true; result: any };
type Err = { id: number | string | null; ok: false; error: { code: string; message: string } };

function ok(id: any, result: any): Ok { return { id: id ?? null, ok: true, result }; }
function err(id: any, code: string, message: string): Err { return { id: id ?? null, ok: false, error: { code, message } }; }

const sidecarPid = process.pid;
const sidecarPidStarttime = pidStarttime(sidecarPid);

// ---------------------------------------------------------------------------
// Per-edge state: cache of parsed sections + last-known turn/lock + lock-aliveness
// timer. Built incrementally as fs.watch fires; rebuilt eagerly on debounced
// events. Slice 3 emits monitor-format stdout lines on transitions; slice 4
// adds the `unread` cursor-based diff that callers consume via IPC.
// ---------------------------------------------------------------------------

// Section offsets are JS string code-unit positions (UTF-16). The "byte"
// suffix is preserved on the IPC schema for compatibility with the plan,
// but internally we operate in code units because String.prototype.slice
// indexes by code units. byte_count fields returned to IPC consumers are
// the true UTF-8 byte length via Buffer.byteLength so they're meaningful
// across runtimes.
type SectionMeta = {
  startByte: number;       // offset into raw CONVO.md (JS string code units)
  endByte: number;         // exclusive
  author: string;          // lowercase; "unknown" if header didn't parse
  ts: string | null;       // UTC stamp from header, or null
  body: string;            // verbatim section text
};

type EdgeCache = {
  edgeId: string;
  peer: string;
  convoPath: string;
  turnPath: string;
  lockPath: string;
  // Last-known values
  turn: string | null;
  turnMtime: number;
  convoMtime: number;
  convoSize: number;
  lockBody: ReturnType<typeof parseLockFile>;
  lockSinceMs: number;     // 0 means lock is absent
  lockStaleEmitted: boolean;
  // Diff cache
  raw: string;
  sections: SectionMeta[];
  // Last self-section end byte (for since-last-spoke). -1 if none.
  lastSelfSectionEnd: number;
  // Watcher handles
  dirWatcher: fs.FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
};

const cache = new Map<string, EdgeCache>();
let lastInotifyEventAt: number | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

// Cursor persistence (slice 4). Anonymous cursors are byte offsets returned
// to the caller and replayed on the next request — fully stateless on the
// sidecar side. Named cursors are persisted across sidecar restarts in
// .sockets/<agent>.cursors.json so a restart doesn't blow away unread
// tracking mid-session.
//
// Schema (v1):
//   { "v": 1, "named": { "<edgeId>": { "<cursorName>": <byteOffset> } } }
type CursorsFile = { v: 1; named: Record<string, Record<string, number>> };
const namedCursors: Map<string, Map<string, number>> = new Map();   // edgeId → name → byteOffset

function cursorsPath(): string { return cursorsFilePath(id.name); }

function loadCursors(): void {
  const p = cursorsPath();
  if (!fs.existsSync(p)) return;
  let parsed: CursorsFile;
  try { parsed = JSON.parse(fs.readFileSync(p, "utf8")) as CursorsFile; }
  catch (e) {
    // Corrupt cursor file: rename and start fresh. Cursor is a hint, never
    // authoritative — losing it doesn't lose any conversation data.
    const broken = `${p}.corrupt-${Date.now()}`;
    try { fs.renameSync(p, broken); } catch {}
    recordError(`cursors file corrupt; renamed to ${broken}: ${(e as Error).message}`);
    return;
  }
  if (parsed?.v !== 1 || !parsed.named) return;
  for (const [edgeId, byName] of Object.entries(parsed.named)) {
    const m = new Map<string, number>();
    for (const [name, off] of Object.entries(byName)) {
      if (typeof off === "number" && off >= 0) m.set(name, off);
    }
    if (m.size > 0) namedCursors.set(edgeId, m);
  }
}

function saveCursors(): void {
  const out: CursorsFile = { v: 1, named: {} };
  for (const [edgeId, byName] of namedCursors) {
    const obj: Record<string, number> = {};
    for (const [n, off] of byName) obj[n] = off;
    if (Object.keys(obj).length > 0) out.named[edgeId] = obj;
  }
  try { writeFileAtomic(cursorsPath(), JSON.stringify(out, null, 2) + "\n"); }
  catch (e) { recordError(`saveCursors failed: ${(e as Error).message}`); }
}

// Compute the diff: every section whose startByte is strictly greater than
// the cursor offset. (We compare on the start of the section so a partial
// trailing read can never be returned as a complete section.)
function sectionsAfter(ec: EdgeCache, cursor: number): SectionMeta[] {
  if (cursor < 0) return ec.sections;          // sentinel for "first turn"
  return ec.sections.filter((s) => s.startByte >= cursor);
}

function buildSectionsCache(rawText: string): SectionMeta[] {
  // Re-walk parseSections-style logic but track code-unit offsets in the raw
  // text so String.prototype.slice can extract the body with no encoding
  // surprises. We can't lean on parseSections because it strips separators
  // and doesn't expose offsets — replicate the scan here, fence-aware
  // (keystone #2). Multibyte characters (em-dash, etc.) are common in our
  // section headers, so byte-offset math against the JS string would
  // mis-slice for non-ASCII content.
  const out: SectionMeta[] = [];
  const lines = rawText.split(/\r?\n/);
  // posOf[i] is the JS-string position of the start of lines[i] in rawText.
  // Reconstruct by accumulating each line's .length plus the actual newline
  // delimiter length used by the source text — for CRLF files we'd add 2,
  // for LF we add 1. Probe by scanning rawText once.
  const posOf: number[] = [];
  let p = 0;
  for (let i = 0; i < lines.length; i++) {
    posOf.push(p);
    p += lines[i].length;
    if (i < lines.length - 1) {
      // Look at the actual delimiter at rawText[p]. If CRLF, advance 2; if
      // LF, advance 1. Defensive fallback: 1.
      if (rawText[p] === "\r" && rawText[p + 1] === "\n") p += 2;
      else if (rawText[p] === "\n") p += 1;
      else p += 1;
    }
  }
  const isFenceLine = (s: string) => /^(```|~~~)/.test(s);

  // Locate header end (first `## ` outside a fence).
  let inFence = false;
  let firstHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^## \S/.test(lines[i])) { firstHeader = i; break; }
  }
  if (firstHeader === -1) return out;

  // Walk sections.
  inFence = false;
  let curStartLine = -1;
  const flush = (endLine: number) => {
    if (curStartLine === -1) return;
    const startPos = posOf[curStartLine];
    const endPos = endLine < lines.length ? posOf[endLine] : rawText.length;
    // Trim trailing blank lines from body to match parseSections's contract.
    const body = rawText.slice(startPos, endPos).replace(/\n+$/, "");
    const meta = sectionMeta(body);
    out.push({ startByte: startPos, endByte: startPos + body.length, author: meta.author, ts: meta.ts, body });
  };
  for (let i = firstHeader; i < lines.length; i++) {
    if (isFenceLine(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^## \S/.test(lines[i])) {
      if (curStartLine !== -1) flush(i);
      curStartLine = i;
    }
  }
  flush(lines.length);
  return out;
}

function readConvoSnapshot(p: string): { raw: string; mtime: number; size: number } | null {
  // fstat-bounded read defeats Bun's read-buffer-overshoot on growing files
  // (rhino #3). Bound the read to fstat.size; the trailing line is either
  // complete or absent — never half-present.
  if (!fs.existsSync(p)) return null;
  const fd = fs.openSync(p, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return { raw: "", mtime: stat.mtimeMs, size: 0 };
    const buf = Buffer.alloc(stat.size);
    let off = 0;
    while (off < stat.size) {
      const n = fs.readSync(fd, buf, off, stat.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { raw: buf.subarray(0, off).toString("utf8"), mtime: stat.mtimeMs, size: stat.size };
  } finally { fs.closeSync(fd); }
}

function findLastSelfSectionEnd(sections: SectionMeta[]): number {
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].author === id.name.toLowerCase()) return sections[i].endByte;
  }
  return -1;
}

function emitNotification(line: string): void {
  // Stdout is the event stream. Each line becomes one chat notification when
  // wired through Claude Code's Monitor tool. Same exact format as
  // monitor.ts so the wiring is interchangeable.
  console.log(line);
}

function nowIso(): string { return new Date().toISOString(); }
function mtimeOf(p: string): number { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function reevaluateEdge(ec: EdgeCache): void {
  // Snapshot the three files. If anything changed since last snapshot,
  // compute a fresh diff and emit notifications matching monitor.ts's lines.
  const now = nowIso();
  const nowMs = Date.now();
  const turn = readTurn(ec.turnPath);
  const turnMtime = mtimeOf(ec.turnPath);
  const convoMtime = mtimeOf(ec.convoPath);
  const lockHeld = fs.existsSync(ec.lockPath);
  const prevTurn = ec.turn;
  const prevTurnMtime = ec.turnMtime;
  const prevConvoMtime = ec.convoMtime;

  // Update lock-aliveness state.
  if (lockHeld) {
    if (ec.lockSinceMs === 0) ec.lockSinceMs = nowMs;
  } else {
    ec.lockSinceMs = 0;
    ec.lockStaleEmitted = false;
  }
  ec.lockBody = parseLockFile(ec.lockPath);

  const valChange = turn !== prevTurn;
  const turnTouched = prevTurnMtime > 0 && turnMtime !== prevTurnMtime;
  const convoGrew = prevConvoMtime > 0 && convoMtime !== prevConvoMtime;

  const interesting = turn === id.name || turn === "parked";
  const fired = !lockHeld && interesting && (valChange || turnTouched || convoGrew);

  if (fired) {
    const why: string[] = [];
    if (valChange) why.push(`value→${turn}`);
    if (turnTouched && !valChange) why.push(".turn-rewritten");
    if (convoGrew) why.push(".md-grew");
    emitNotification(`${now} edge=${ec.edgeId} peer=${ec.peer} .turn=${turn} ${why.join(" ")} — re-read ${ec.convoPath}`);
  }

  // Protocol-violation: peer appended to CONVO.md but did NOT flip the turn.
  // Same line shape as monitor.ts.
  if (
    !lockHeld && convoGrew && !valChange && !turnTouched &&
    turn !== id.name && turn !== "parked" && turn !== null
  ) {
    emitNotification(`${now} edge=${ec.edgeId} peer=${ec.peer} .turn=${turn} protocol-violation:peer-appended-without-flip — re-read ${ec.convoPath}`);
  }

  // Stale-lock detection.
  if (lockHeld && !ec.lockStaleEmitted && ec.lockSinceMs > 0) {
    const heldMs = nowMs - ec.lockSinceMs;
    if (heldMs >= /* args */ argsRef.staleLockSec * 1000) {
      const lk = ec.lockBody;
      if (lk && !processIsOriginal(lk.pid, lk.starttime)) {
        emitNotification(`${now} edge=${ec.edgeId} peer=${ec.peer} lock-stale held=${Math.round(heldMs/1000)}s by=${lk.agent}@${lk.host}:${lk.pid} (pid gone or recycled) — run \`bun scripts/turn.ts unlock ${ec.peer} --force-stale\` to clear`);
        ec.lockStaleEmitted = true;
      }
    }
  }

  // Update the diff cache only when the lock isn't held — same hold-prev
  // discipline as monitor.ts. Otherwise an in-flight peer write could
  // "consume" the diff before it lands.
  if (!lockHeld) {
    ec.turn = turn;
    ec.turnMtime = turnMtime;
    if (convoMtime !== prevConvoMtime || ec.raw === "") {
      const snap = readConvoSnapshot(ec.convoPath);
      if (snap) {
        ec.raw = snap.raw;
        ec.convoMtime = snap.mtime;
        ec.convoSize = snap.size;
        try {
          ec.sections = buildSectionsCache(snap.raw);
          ec.lastSelfSectionEnd = findLastSelfSectionEnd(ec.sections);
        } catch (e) {
          recordError(`section parse failed for ${ec.convoPath}: ${(e as Error).message}`);
          // Keep prior sections so a transient bad parse doesn't blow away
          // the cache; we'll retry on next event.
        }
      }
    }
  }
  lastInotifyEventAt = Date.now();
}

// argsRef is declared after parseArgs; shimmed via late binding so
// reevaluateEdge can read the current args. (We can't use closure capture
// because reevaluateEdge is referenced before main() runs.)
let argsRef: Args = args;

function scheduleEdgeTick(ec: EdgeCache): void {
  if (ec.debounceTimer) return;
  ec.debounceTimer = setTimeout(() => {
    ec.debounceTimer = null;
    try { reevaluateEdge(ec); }
    catch (e) { recordError(`reevaluateEdge failed for ${ec.edgeId}: ${(e as Error).message}`); }
  }, argsRef.watchDebounceMs);
}

function attachWatcher(ec: EdgeCache): void {
  if (argsRef.noWatch) return;
  // Directory-level watch survives atomic tmp+rename writes (the dominant
  // protocol pattern). Per-file watches attach to the inode and are blown
  // away by rename on Linux.
  if (!fs.existsSync(path.dirname(ec.turnPath))) return;
  try {
    const w = fs.watch(path.dirname(ec.turnPath), { persistent: false }, (_evt, fname) => {
      if (!fname) { scheduleEdgeTick(ec); return; }
      // Only react to the three files we care about.
      const f = String(fname);
      if (f === "CONVO.md" || f === "CONVO.md.turn" || f === "CONVO.md.turn.lock") {
        scheduleEdgeTick(ec);
      }
    });
    w.on("error", (e) => recordError(`fs.watch error on ${ec.edgeId}: ${e.message}`));
    ec.dirWatcher = w;
  } catch (e) {
    recordError(`fs.watch failed for ${ec.edgeId}: ${(e as Error).message}`);
  }
}

function startReconcilePoll(): void {
  // Belt-and-braces: re-evaluate every edge every N seconds in case fs.watch
  // dropped an event (WSL1, certain FUSE mounts, NFS-the-skill-doesn't-support-
  // but-we-still-want-best-effort). Cheap: 3 stats per edge per cycle.
  if (argsRef.reconcilePollMs <= 0) return;
  reconcileTimer = setInterval(() => {
    for (const ec of cache.values()) {
      try { reevaluateEdge(ec); }
      catch (e) { recordError(`reconcile tick failed for ${ec.edgeId}: ${(e as Error).message}`); }
    }
  }, argsRef.reconcilePollMs);
}

// Round 12 feature 13 (keystone): incremental auto-compaction.
// Every N seconds (default 60), check each edge: if CONVO.md is over the
// token threshold AND turn=parked AND no lock, spawn `archive.ts auto`
// in the background. The threshold + interval are env-overridable so
// tests can short-circuit (`AGENT_CHAT_AUTO_ARCHIVE_INTERVAL=0.1` +
// `AGENT_CHAT_AUTO_ARCHIVE_TOKENS=1`).
//
// This is the ONE sidecar.ts change in Round 12 — orion's spec explicitly
// designated sidecar.ts as "unchanged" elsewhere. Any future feature
// touching sidecar should call this out the same way.
let autoCompactTimer: NodeJS.Timeout | null = null;
const autoCompactingEdges = new Set<string>();  // edges with an in-flight auto archive

function startAutoCompactionPoll(): void {
  const interval = parseFloat(process.env.AGENT_CHAT_AUTO_ARCHIVE_INTERVAL ?? "60");
  if (!Number.isFinite(interval) || interval <= 0) return;
  const intervalMs = Math.max(50, Math.round(interval * 1000));
  const tokenThreshold = parseInt(process.env.AGENT_CHAT_AUTO_ARCHIVE_TOKENS ?? "50000", 10);
  autoCompactTimer = setInterval(() => {
    for (const ec of cache.values()) {
      try { maybeAutoCompact(ec, tokenThreshold); }
      catch (e) { recordError(`auto-compact tick failed for ${ec.edgeId}: ${(e as Error).message}`); }
    }
  }, intervalMs);
  log(`auto-compaction poll started: every ${intervalMs}ms, threshold ${tokenThreshold} tokens`);
}

// ---------------------------------------------------------------------------
// Round-13 slice 1 (lumeyon): heartbeat emitter.
//
// Every AGENT_CHAT_HEARTBEAT_INTERVAL seconds (default 30, min 0.05),
// write `<conversations>/.heartbeats/<agent>.heartbeat` via atomic
// tmpfile+rename. Reader (carina's monitor) polls these to surface
// stuck-but-pid-alive agents. Schema lives in scripts/liveness.ts (single
// source of truth).
//
// The interval value uses the same `<=0 OR literal "0" disables` semantic
// as monitor's --no-parked-startup pattern: testing escape hatch can't be
// silently float-parsed into "enabled".
//
// pid + starttime fingerprint matches lockTag (Round-4) and is verified by
// processIsOriginal (Round-9). When monitor reports stuck-but-pid-alive,
// these are the fields to grep.
let heartbeatTimer: NodeJS.Timeout | null = null;

function startHeartbeatEmitter(): void {
  const raw = process.env.AGENT_CHAT_HEARTBEAT_INTERVAL ?? "30";
  // Refuse "0" / "" / non-positive — testing escape hatch.
  if (raw === "0" || raw.trim() === "") {
    log(`heartbeat emitter disabled via AGENT_CHAT_HEARTBEAT_INTERVAL`);
    return;
  }
  const interval = parseFloat(raw);
  if (!Number.isFinite(interval) || interval <= 0) {
    log(`heartbeat emitter disabled (AGENT_CHAT_HEARTBEAT_INTERVAL=${raw})`);
    return;
  }
  const intervalMs = Math.max(50, Math.round(interval * 1000));
  // Resolve writer-side pid/starttime ONCE at startup; sidecar identity
  // is invariant across its lifetime. stableSessionPid() returns the
  // long-lived parent (Round-4); pidStarttime() reads /proc/<pid>/stat
  // (Round-9). 0-fallback when pidStarttime returns null — reader
  // tolerates 0 as an integer; pid-recycle protection still works
  // because the live process's (pid, starttime) won't match.
  const writerPid = stableSessionPid();
  const writerStarttime = pidStarttime(writerPid) ?? 0;
  const hostname = os.hostname();
  const writeOnce = (): void => {
    try {
      // Use full-resolution ISO timestamp (with milliseconds) instead of
      // utcStamp()'s second-truncated form. Heartbeats can fire at sub-
      // second intervals (test fixtures use 0.5s) and consumers compare
      // ts_ms values directly — without milliseconds, two ticks within
      // the same second produce identical ts and "subsequent ticks
      // update ts" can't be observed. Round-13 Phase-5 fix surfaced by
      // tests/heartbeat.test.ts:217.
      const line = formatHeartbeat({
        ts: new Date().toISOString(),
        host: hostname,
        pid: writerPid,
        starttime: writerStarttime,
        sidecar_version: SIDECAR_HEARTBEAT_VERSION,
      });
      writeFileAtomic(heartbeatPath(id.name), line);
    } catch (e) {
      recordError(`heartbeat write failed: ${(e as Error).message}`);
    }
  };
  // Kickstart: write IMMEDIATELY so consumers see fresh state within
  // ~10ms of sidecar boot (well under the 100ms test budget). Then tick.
  writeOnce();
  heartbeatTimer = setInterval(writeOnce, intervalMs);
  log(`heartbeat emitter started: every ${intervalMs}ms → ${heartbeatPath(id.name)}`);
}

function maybeAutoCompact(ec: EdgeCache, tokenThreshold: number): void {
  // Three preconditions before spawning archive.ts:
  //   1. We're not already running an auto-compact for this edge.
  //   2. .turn is "parked" — neither side has the floor; safe to mutate CONVO.
  //   3. No active lock — another writer may be in-flight.
  //   4. CONVO.md size / 4 > tokenThreshold.
  if (autoCompactingEdges.has(ec.edgeId)) return;
  const turn = ec.turn;
  if (turn !== "parked") return;
  // Lock probe — direct stat (cache may be slightly stale; protocol authority
  // is filesystem, not cache).
  const edge = edges.find((e) => e.id === ec.edgeId);
  if (!edge) return;
  if (fs.existsSync(edge.lock)) return;
  let convoSize = 0;
  try { convoSize = fs.statSync(edge.convo).size; } catch { return; }
  const estimatedTokens = Math.ceil(convoSize / 4);
  if (estimatedTokens < tokenThreshold) return;

  // Spawn archive.ts auto in the background. The skill's archive.ts
  // already handles atomic CONVO.md truncate, lock acquisition, fresh-tail
  // protection, and index.jsonl/fts5 sync — sidecar's job is only to
  // trigger it at the right moment, not to re-implement.
  autoCompactingEdges.add(ec.edgeId);
  const archiveScript = path.resolve(import.meta.dirname, "archive.ts");
  const cp = require("node:child_process");
  // Pass --no-llm by default so a missing claude binary doesn't break the
  // compaction. Carina's slice 1 LLM gating still runs the LLM path when
  // claude is available AND --no-llm isn't set.
  const peer = ec.edgeId.split("-").find((p) => p !== id.name) ?? "";
  const child = cp.spawn(process.execPath, [archiveScript, "auto", peer, "--no-llm"], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID ?? "" },
    cwd: SKILL_ROOT,
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.on("exit", (code: number | null) => {
    autoCompactingEdges.delete(ec.edgeId);
    if (code === 0) {
      log(`auto-compact ${ec.edgeId}: ok (~${estimatedTokens} → archive)`);
    } else {
      recordError(`auto-compact ${ec.edgeId} exited ${code}: ${stderr.slice(0, 200)}`);
    }
  });
  child.on("error", (e: Error) => {
    autoCompactingEdges.delete(ec.edgeId);
    recordError(`auto-compact spawn failed ${ec.edgeId}: ${e.message}`);
  });
  child.unref();
}

function primeCache(): void {
  for (const e of edges) {
    const turn = readTurn(e.turn);
    const tMt = mtimeOf(e.turn);
    const cMt = mtimeOf(e.convo);
    const snap = readConvoSnapshot(e.convo);
    const sections = snap ? buildSectionsCache(snap.raw) : [];
    const lockHeld = fs.existsSync(e.lock);
    const ec: EdgeCache = {
      edgeId: e.id,
      peer: e.peer,
      convoPath: e.convo,
      turnPath: e.turn,
      lockPath: e.lock,
      turn,
      turnMtime: tMt,
      convoMtime: cMt,
      convoSize: snap?.size ?? 0,
      lockBody: parseLockFile(e.lock),
      lockSinceMs: lockHeld ? Date.now() : 0,
      lockStaleEmitted: false,
      raw: snap?.raw ?? "",
      sections,
      lastSelfSectionEnd: findLastSelfSectionEnd(sections),
      dirWatcher: null,
      debounceTimer: null,
    };
    cache.set(e.id, ec);
  }
}

function emitStartupPending(): void {
  // Same shape as monitor.ts startup-pending: actionable edges (turn=me OR
  // turn=parked) and unlocked, fire one notification each at boot so the
  // agent knows the floor state without rescanning manually.
  for (const ec of cache.values()) {
    const lockHeld = fs.existsSync(ec.lockPath);
    if (!lockHeld && (ec.turn === id.name || ec.turn === "parked")) {
      emitNotification(`${nowIso()} edge=${ec.edgeId} peer=${ec.peer} .turn=${ec.turn} startup-pending — re-read ${ec.convoPath}`);
    }
  }
}

// Re-read this session's SessionRecord from disk. The sidecar is launched
// BEFORE init writes monitor_pid + monitor_pid_starttime to the record, so
// caching at startup leaves monitor_pid permanently null. Fixed by re-reading
// each whoami/health call (carina round-2-after-cycle anomaly #1).
function readSelfSessionRecord(): SessionRecord | null {
  // Honor whatever session key resolveIdentity used. The sidecar's id.source
  // field is "session:<key>" so we extract the suffix. Fall back to the
  // currentSessionKey lookup if the source string isn't recognizable.
  const m = id.source.match(/^session:(.+)$/);
  const key = m ? m[1] : currentSessionKey();
  return readSessionRecord(key);
}

// Find an edge by peer name, with the same friendly error as turn.ts.
function findEdgeByPeer(peer: string) {
  if (typeof peer !== "string" || !peer) return { edge: null, code: "E_BAD_REQUEST", message: "peer is required" };
  const edge = edges.find((e) => e.peer === peer);
  if (!edge) return { edge: null, code: "E_NOT_NEIGHBOR", message: `${peer} is not a neighbor of ${id.name}` };
  return { edge, code: "", message: "" };
}

// Read CONVO.md once, parse, return sections + the absolute path. In slice 2
// this is per-request; slice 3 caches across the inotify lifecycle.
function readConvoSections(convoPath: string): { header: string; sections: string[]; raw: string } | null {
  if (!fs.existsSync(convoPath)) return null;
  let raw: string;
  try { raw = fs.readFileSync(convoPath, "utf8"); }
  catch { return null; }
  const { header, sections } = parseSections(raw);
  return { header, sections, raw };
}

async function dispatch(req: Request): Promise<Ok | Err> {
  const m = (req.method ?? "").toString();
  if (!m) return err(req.id, "E_BAD_REQUEST", "missing method");
  switch (m) {
    case "whoami": {
      // Re-read SessionRecord each call so post-init field updates (notably
      // the monitor pid that init writes AFTER spawning the sidecar — see
      // carina's anomaly #1) are reflected without forcing a sidecar restart.
      // Cost is one small JSON read; negligible vs. UDS round-trip latency.
      // Slice-2 (multi-user): same lesson generalized — current_speaker is
      // written by `agent-chat speaker <name>` AFTER sidecar boot and can
      // change at any time during a session. Read on every dispatch (no
      // caching) to inherit the Bug-1 fix's discipline. Pulsar's slice-2
      // round mandated this and pinned a regression test by name.
      const rec = readSelfSessionRecord();
      const key = rec?.session_key ?? currentSessionKey();
      const speaker = readCurrentSpeaker(key);
      return ok(req.id, {
        agent: id.name,
        topology: id.topology,
        monitor_pid: rec?.monitor_pid ?? null,
        sidecar_pid: sidecarPid,
        sidecar_pid_starttime: sidecarPidStarttime,
        uptime_ms: Date.now() - startedAtMs,
        started_at: startedAt,
        host: os.hostname(),
        edges: edges.map((e) => e.id),
        current_speaker: speaker,  // {name, set_at} | null
      });
    }
    case "time": {
      const now = new Date();
      return ok(req.id, {
        utc: now.toISOString(),
        iso: now.toISOString(),
        // hrtime is BigInt; serialize as decimal string so JSON survives.
        monotonic_ns: process.hrtime.bigint().toString(),
      });
    }
    case "health": {
      const rec = readSelfSessionRecord();
      const monitorAlive = !!(rec?.monitor_pid && processIsOriginal(rec.monitor_pid, rec.monitor_pid_starttime));
      return ok(req.id, {
        ok: errors.length === 0,
        edges: edges.length,
        monitor_pid: rec?.monitor_pid ?? null,
        monitor_alive: monitorAlive,
        sidecar_uptime_ms: Date.now() - startedAtMs,
        last_inotify_event_age_ms: lastInotifyEventAt == null ? null : Date.now() - lastInotifyEventAt,
        errors: errors.slice(0, 8),
        cursors_file_path: cursorsPath(),
      });
    }
    case "peek": {
      const { edge, code, message } = findEdgeByPeer(req.params?.peer);
      if (!edge) return err(req.id, code, message);
      const turn = readTurn(edge.turn);
      const lock = parseLockFile(edge.lock);
      const cs = readConvoSections(edge.convo);
      let last_section_author: string | null = null;
      let last_section_ts: string | null = null;
      let last_section_byte_count = 0;
      let total_sections = 0;
      if (cs) {
        total_sections = cs.sections.length;
        if (total_sections > 0) {
          const last = cs.sections[total_sections - 1];
          const meta = sectionMeta(last);
          last_section_author = meta.author === "unknown" ? null : meta.author;
          last_section_ts = meta.ts;
          last_section_byte_count = Buffer.byteLength(last, "utf8");
        }
      }
      return ok(req.id, {
        edge_id: edge.id,
        turn,
        lock,
        last_section_author,
        last_section_ts,
        last_section_byte_count,
        total_sections,
        convo_path: edge.convo,
      });
    }
    case "last-section": {
      const { edge, code, message } = findEdgeByPeer(req.params?.peer);
      if (!edge) return err(req.id, code, message);
      let n = req.params?.n;
      if (n == null) n = 1;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
        return err(req.id, "E_BAD_REQUEST", `n must be a positive integer (1..16); got ${n}`);
      }
      if (n > 16) return err(req.id, "E_BAD_REQUEST", `n=${n} exceeds maximum (16)`);
      n = Math.floor(n);
      const cs = readConvoSections(edge.convo);
      if (!cs || cs.sections.length === 0) {
        return ok(req.id, { edge_id: edge.id, sections: [] });
      }
      // Compute start_byte/end_byte for each returned section by tracking
      // header preamble length + cumulative section bytes (with the 4-byte
      // separator "\n\n---\n\n" === 8 chars, but parseSections strips
      // separators so we reconstruct the offsets from the raw text instead
      // — slice 4 will replace this with the cached offsets).
      const want = cs.sections.slice(-n);
      const result = want.map((body) => {
        const meta = sectionMeta(body);
        const start = cs.raw.indexOf(body);
        return {
          author: meta.author === "unknown" ? null : meta.author,
          ts: meta.ts,
          body,
          start_byte: start,                        // -1 if not found (shouldn't happen)
          end_byte: start >= 0 ? start + Buffer.byteLength(body, "utf8") : -1,
        };
      });
      return ok(req.id, { edge_id: edge.id, sections: result });
    }
    case "unread": {
      const { edge, code, message } = findEdgeByPeer(req.params?.peer);
      if (!edge) return err(req.id, code, message);
      const ec = cache.get(edge.id);
      if (!ec) return err(req.id, "E_EDGE_NOT_INITIALIZED", `edge ${edge.id} not in cache (no CONVO.md yet?)`);
      const cursorName = req.params?.cursor_name;
      const givenCursor = req.params?.cursor;
      let baseline: number;
      if (typeof cursorName === "string" && cursorName) {
        const byName = namedCursors.get(edge.id);
        baseline = byName?.get(cursorName) ?? -1;        // -1 = first call → return all
      } else if (typeof givenCursor === "number" && givenCursor >= 0) {
        baseline = givenCursor;
      } else if (givenCursor === undefined || givenCursor === null) {
        baseline = -1;                                    // first call (anonymous)
      } else {
        return err(req.id, "E_BAD_REQUEST", "cursor must be a non-negative integer or omitted");
      }
      const newSections = sectionsAfter(ec, baseline);
      const newCursor = ec.sections.length > 0
        ? ec.sections[ec.sections.length - 1].endByte
        : 0;
      // Persist named cursor.
      if (typeof cursorName === "string" && cursorName) {
        let byName = namedCursors.get(edge.id);
        if (!byName) { byName = new Map(); namedCursors.set(edge.id, byName); }
        byName.set(cursorName, newCursor);
        saveCursors();
      }
      const byteCount = newSections.reduce((acc, s) => acc + Buffer.byteLength(s.body, "utf8"), 0);
      return ok(req.id, {
        edge_id: edge.id,
        cursor: newCursor,
        sections_since: newSections.map((s) => ({
          author: s.author === "unknown" ? null : s.author,
          ts: s.ts,
          body: s.body,
        })),
        byte_count: byteCount,
      });
    }
    case "since-last-spoke": {
      const { edge, code, message } = findEdgeByPeer(req.params?.peer);
      if (!edge) return err(req.id, code, message);
      const ec = cache.get(edge.id);
      if (!ec) return err(req.id, "E_EDGE_NOT_INITIALIZED", `edge ${edge.id} not in cache`);
      const turn = readTurn(ec.turnPath);
      const lock = parseLockFile(ec.lockPath);
      // First-turn case: self has never written a section. Return everything
      // in CONVO.md as the diff so the agent's prompt has full context.
      const selfEnd = ec.lastSelfSectionEnd;
      const isFirstTurn = selfEnd < 0;
      const baseline = isFirstTurn ? -1 : selfEnd;
      const newSections = sectionsAfter(ec, baseline);
      const byteCount = newSections.reduce((acc, s) => acc + Buffer.byteLength(s.body, "utf8"), 0);
      // fresh_tail_archived: if we have ZERO sections in cache but CONVO.md
      // is non-empty, we presumably just ran an archive seal that truncated
      // self's last section. Signal so the consumer knows to consult
      // search.ts. Conservative implementation in v1.
      const fresh_tail_archived = ec.raw.length > 0 && ec.sections.length === 0 && !isFirstTurn;
      return ok(req.id, {
        edge_id: edge.id,
        turn,
        lock,
        sections_since: newSections.map((s) => ({
          author: s.author === "unknown" ? null : s.author,
          ts: s.ts,
          body: s.body,
        })),
        byte_count: byteCount,
        fresh_tail_archived,
        is_first_turn: isFirstTurn,
      });
    }
    case "speaker": {
      // Slice-2 dedicated read-only fast-path. Returns the current_speaker
      // record (or null) without the rest of the whoami payload — saves
      // bytes on the hot path where keystone's record-turn dispatcher
      // queries on every assistant turn (orion's Phase-2 cross-slice note).
      // Read on every dispatch — same Bug-1 generalization as whoami.
      const rec = readSelfSessionRecord();
      const key = rec?.session_key ?? currentSessionKey();
      const speaker = readCurrentSpeaker(key);
      return ok(req.id, { current_speaker: speaker });  // {name, set_at} | null
    }
    case "shutdown":
      // Reply first, then exit on next tick so the response actually ships.
      setImmediate(() => gracefulExit(0, "shutdown via IPC"));
      return ok(req.id, { ok: true });
    default:
      return err(req.id, "E_UNKNOWN_METHOD", `unknown method: ${m}`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function handleConnection(sock: net.Socket): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", async (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req: Request;
      try { req = JSON.parse(line) as Request; }
      catch (e) {
        const r: Err = err(null, "E_BAD_REQUEST", `unparseable request: ${(e as Error).message}`);
        sock.write(JSON.stringify(r) + "\n");
        continue;
      }
      try {
        const resp = await dispatch(req);
        sock.write(JSON.stringify(resp) + "\n");
      } catch (e) {
        const r: Err = err(req.id, "E_INTERNAL", (e as Error).message);
        sock.write(JSON.stringify(r) + "\n");
        recordError(`dispatch failed for ${req.method}: ${(e as Error).message}`);
      }
    }
  });
  sock.on("error", (e) => recordError(`client socket error: ${e.message}`));
}

async function bindServer(): Promise<net.Server> {
  // Belt-and-braces socket cleanup. We've already verified no live process is
  // bound (probeStaleSocket); the unlink defends against EADDRINUSE if the
  // file still exists.
  const probe = await probeStaleSocket(args.staleConnectTimeoutMs);
  if (probe === "alive") {
    log(`another sidecar appears live on ${socketPath}; exiting.`);
    process.exit(0);
  }
  if (probe === "stale") {
    try { fs.unlinkSync(socketPath); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  }
  const server = net.createServer({ allowHalfOpen: false }, handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      // Mode 0600 is critical for filesystem-permission auth. Chmod INSIDE
      // the listen callback (before resolving the promise) so a client that
      // observes "socket is connectable" also observes the final mode. Pre-
      // fix, the chmod ran AFTER the promise resolved, racing the test's
      // `waitForSocket` polls under load — the test could `fs.statSync` and
      // see pre-chmod 0o755 before the chmod fired. Caught at Phase-5
      // integration during the multi-user rollout; the team's added tests
      // pushed concurrent test load past the threshold where the race
      // became observable.
      try { fs.chmodSync(socketPath, 0o600); }
      catch (e) { recordError(`chmod 0600 on socket failed: ${(e as Error).message}`); }
      resolve();
    });
  });
  return server;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let server: net.Server | null = null;
let exiting = false;

function gracefulExit(code: number, why: string): void {
  if (exiting) return;
  exiting = true;
  log(`shutting down: ${why}`);
  try {
    for (const ec of cache.values()) {
      if (ec.debounceTimer) { clearTimeout(ec.debounceTimer); ec.debounceTimer = null; }
      if (ec.dirWatcher) { try { ec.dirWatcher.close(); } catch {} ec.dirWatcher = null; }
    }
  } catch {}
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  if (autoCompactTimer) { clearInterval(autoCompactTimer); autoCompactTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try {
    if (server) server.close();
  } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
  // Round-13 slice 1: unlink heartbeat. SIGTERM handler runs the same
  // path as cmdExit; defense-in-depth via cmdGc covers the killed-9 case
  // where this handler never fires.
  try { fs.unlinkSync(heartbeatPath(id.name)); } catch {}
  setImmediate(() => process.exit(code));
}

process.on("SIGINT", () => gracefulExit(0, "SIGINT"));
process.on("SIGTERM", () => gracefulExit(0, "SIGTERM"));
process.on("uncaughtException", (e) => {
  recordError(`uncaughtException: ${(e as Error).message}`);
  gracefulExit(1, "uncaughtException");
});

async function main() {
  writePidFile();
  log(`starting up (pid ${sidecarPid}, starttime ${sidecarPidStarttime ?? "?"}, edges ${edges.length})`);
  server = await bindServer();
  log(`listening on ${socketPath}`);
  // Prime the diff cache + attach watchers + run startup-pending pass before
  // we accept any IPC traffic that depends on the cache (peek/last-section
  // already work without it via per-request reads, but a primed cache is
  // strictly cheaper). Order matters: prime → emit startup-pending → attach
  // watcher (so the watcher's first tick doesn't double-emit startup state).
  loadCursors();
  primeCache();
  emitStartupPending();
  for (const ec of cache.values()) attachWatcher(ec);
  startReconcilePoll();
  startAutoCompactionPoll();
  startHeartbeatEmitter();
  if (args.once) {
    // Smoke-test mode: exit cleanly after announcing readiness.
    gracefulExit(0, "--once");
    return;
  }
  if (args.foreground) {
    log(`running in foreground; SIGINT to stop.`);
  }
}

main().catch((e) => {
  recordError(`startup failed: ${(e as Error).message}`);
  gracefulExit(2, "startup error");
});
