// liveness.ts — shared heartbeat schema, thresholds, and classification.
// Round 13 — slice 3 keystone. Imported by:
//   - sidecar.ts / lumeyon's slice 1 (heartbeat WRITER)
//   - monitor.ts / carina's slice 2 (online stuck-detection emission)
//   - agent-chat.ts (this slice's `doctor --liveness` offline check)
//
// Single source of truth so the three call sites can't drift on the schema
// or thresholds. Round-12 caught a bm25-weights drift bug that would've
// been impossible if the weights had lived in one shared constant; we
// apply the same lesson preventively here.
//
// Heartbeat wire format: space-delimited key=value, single line per file,
// atomic tmpfile+rename. Five required fields:
//   ts=<utc-stamp> host=<hostname> pid=<stableSessionPid> starttime=<pidStarttime> sidecar_version=<version>
// Reasoning for not-JSON: a torn read on a JSON line is a syntax error;
// space-delimited gracefully fails on missing fields and matches the
// existing `.turn.lock` body shape (`<agent>@<host>:<pid>:<starttime> <utc>`).

import * as fs from "node:fs";
import * as path from "node:path";
import { CONVERSATIONS_DIR, processIsOriginal } from "./lib.ts";

export const HEARTBEATS_DIR = path.join(CONVERSATIONS_DIR, ".heartbeats");

// Thresholds. Defaults align with carina's monitor 30s heartbeat-write tick:
// 3 missed ticks → stale, 10 missed ticks → dead. Env overrides for tests +
// custom deployments.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const HEARTBEAT_STALE_MS = envInt("AGENT_CHAT_HEARTBEAT_STALE_MS", 90_000);
export const HEARTBEAT_DEAD_MS = envInt("AGENT_CHAT_HEARTBEAT_DEAD_MS", 300_000);

// Round-13 slice 1 (lumeyon): wire-format version. Sidecar emits this in
// every heartbeat; carina's reader refuses unknown versions LOUDLY (returns
// `unparseable` so degraded liveness isn't silent). String-typed to match
// keystone's `Heartbeat.sidecar_version: string`.
export const SIDECAR_HEARTBEAT_VERSION = "1";

export type HeartbeatStatus = "fresh" | "stale" | "dead" | "unparseable" | "missing";

export type Heartbeat = {
  ts: string;            // utc stamp from the file
  ts_ms: number;         // pre-parsed epoch ms (saves carina's monitor a Date.parse on every poll tick)
  host: string;
  pid: number;
  starttime: number;
  sidecar_version: string;
};

export type HeartbeatRecord = {
  agent: string;          // derived from filename
  status: HeartbeatStatus;
  ageMs: number | null;   // null if missing or unparseable
  hb: Heartbeat | null;
  raw: string | null;     // raw file contents, useful for diagnostics
  reason?: string;        // human-readable status detail
};

export function heartbeatPath(agent: string): string {
  // Mirror the `safeAgent` sanitization used elsewhere so a malformed
  // agent name can't escape the .heartbeats/ dir.
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(HEARTBEATS_DIR, `${safe}.heartbeat`);
}

// Parse a heartbeat file's contents. Tolerant: a torn read (truncated mid-
// line) returns null rather than throwing; missing required fields return
// null; partial parse (some fields valid, others missing) returns null.
// The caller decides what `null` means in their context (stale vs unparse-
// able) — this function just reports parse outcome.
export function parseHeartbeat(text: string): Heartbeat | null {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const part of line.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const ts = fields.get("ts");
  const host = fields.get("host");
  const pid = parseInt(fields.get("pid") ?? "", 10);
  // starttime accepts either `?` sentinel (Phase-1 spec) OR numeric `0`
  // (writer-side fallback when pidStarttime() returns null on platforms
  // where /proc/<pid>/stat is unavailable). Both normalize to 0 and rely
  // on processIsOriginal's pid-recycle pair-match for liveness checking.
  // Round-13 lumeyon→keystone Phase-4 nit + carina→lumeyon Phase-4 nit:
  // accept both forms so the writer doesn't have to memorize one variant.
  const stRaw = fields.get("starttime") ?? "";
  const starttime = stRaw === "?" ? 0 : parseInt(stRaw, 10);
  const sidecar_version = fields.get("sidecar_version") ?? "";
  if (!ts || !host || !Number.isFinite(pid) || !Number.isFinite(starttime)) return null;
  // Round-13 Phase-4 lumeyon→keystone CONCERN #1: refuse missing/empty
  // sidecar_version. Without this, a torn read truncated before the
  // sidecar_version field would parse "successfully" with empty version
  // and downstream consumers would treat it as a (different) version
  // mismatch by coincidence. Refusing to parse is the principled fix.
  if (!sidecar_version) return null;
  // Round-13 Phase-4 lumeyon→keystone CONCERN #2: refuse unknown future
  // sidecar_version. orion Phase-1.5 spec: "carina's slice-2 parser
  // refusing unknown versions LOUDLY is the right paranoia." String
  // equality with the constant — a future v=2 schema requires a parser
  // bump, not silent v=1 misinterpretation.
  if (sidecar_version !== SIDECAR_HEARTBEAT_VERSION) return null;
  // Pre-parse ts → epoch ms once at parse time so callers (carina's monitor
  // poll loop especially) don't repeat Date.parse on every tick.
  const ts_ms = Date.parse(ts);
  if (!Number.isFinite(ts_ms)) return null;
  return { ts, ts_ms, host, pid, starttime, sidecar_version };
}

// formatHeartbeat — writer-side companion to parseHeartbeat (Round-13
// slice 1, lumeyon). Symmetric pair: parse(format(x)).{ts,host,pid,starttime,sidecar_version} === x
// is the contract pinned by tests/heartbeat.test.ts. Sidecar emits this
// every AGENT_CHAT_HEARTBEAT_INTERVAL seconds via writeFileAtomic.
//
// pid + starttime fingerprint matches lockTag (Round-4) and processIsOriginal
// (Round-9). When monitor reports stuck-but-pid-alive, these are the fields
// to grep.
//
// `starttime: 0` is the on-Linux fallback when pidStarttime() can't read
// /proc/<pid>/stat (rare; sidecar runs as a child of an alive parent and
// /proc is reliably present on supported deployments). The reader treats
// 0 as a valid integer; pid-recycle protection still works because the
// recorded pair must MATCH the live process's (pid, starttime) — a
// recycled pid will have a non-zero starttime that doesn't match.
export function formatHeartbeat(input: {
  ts: string;
  host: string;
  pid: number;
  starttime: number;
  sidecar_version?: string;
}): string {
  const v = input.sidecar_version ?? SIDECAR_HEARTBEAT_VERSION;
  return `ts=${input.ts} host=${input.host} pid=${input.pid} starttime=${input.starttime} sidecar_version=${v}`;
}

// Classify a heartbeat against the current wall clock + processIsOriginal.
// Returns ageMs and status. Caller already has the parsed Heartbeat.
//
// The pid-recycle guard via processIsOriginal is what makes "dead" mean
// what we want it to mean: a pid that was reaped and reassigned to an
// unrelated process must NOT register as fresh just because the new
// process happens to be alive.
export function classifyHeartbeat(hb: Heartbeat, nowMs = Date.now()): { ageMs: number; status: HeartbeatStatus; reason: string } {
  // ts_ms pre-parsed at parse time; no Date.parse here (Round-13 cross-slice
  // ergonomics for carina's hot path).
  const ageMs = Number.isFinite(hb.ts_ms) ? Math.max(0, nowMs - hb.ts_ms) : Number.POSITIVE_INFINITY;
  // Sidecar pid liveness is the strongest signal. If the recorded pid is
  // dead OR recycled, mark dead regardless of timestamp age.
  if (!processIsOriginal(hb.pid, hb.starttime || undefined)) {
    return { ageMs, status: "dead", reason: `sidecar pid ${hb.pid} dead or recycled` };
  }
  if (ageMs >= HEARTBEAT_DEAD_MS) {
    return { ageMs, status: "dead", reason: `age ${Math.round(ageMs / 1000)}s ≥ dead threshold ${HEARTBEAT_DEAD_MS / 1000}s` };
  }
  if (ageMs >= HEARTBEAT_STALE_MS) {
    return { ageMs, status: "stale", reason: `age ${Math.round(ageMs / 1000)}s ≥ stale threshold ${HEARTBEAT_STALE_MS / 1000}s` };
  }
  return { ageMs, status: "fresh", reason: `age ${Math.round(ageMs / 1000)}s < ${HEARTBEAT_STALE_MS / 1000}s` };
}

export function readHeartbeatRecord(agent: string, nowMs = Date.now()): HeartbeatRecord {
  const p = heartbeatPath(agent);
  if (!fs.existsSync(p)) {
    return { agent, status: "missing", ageMs: null, hb: null, raw: null, reason: "no .heartbeat file" };
  }
  let raw: string;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (err) {
    return { agent, status: "unparseable", ageMs: null, hb: null, raw: null, reason: `read failed: ${(err as Error).message}` };
  }
  const hb = parseHeartbeat(raw);
  if (!hb) {
    return { agent, status: "unparseable", ageMs: null, hb: null, raw, reason: "could not parse heartbeat fields" };
  }
  const c = classifyHeartbeat(hb, nowMs);
  return { agent, status: c.status, ageMs: c.ageMs, hb, raw, reason: c.reason };
}

// List all heartbeat files on this host (full sweep). Returns one record
// per file. Use `agent-chat doctor --liveness` to display.
export function listHeartbeatRecords(nowMs = Date.now()): HeartbeatRecord[] {
  if (!fs.existsSync(HEARTBEATS_DIR)) return [];
  const out: HeartbeatRecord[] = [];
  for (const f of fs.readdirSync(HEARTBEATS_DIR)) {
    if (!f.endsWith(".heartbeat")) continue;
    const agent = f.replace(/\.heartbeat$/, "");
    out.push(readHeartbeatRecord(agent, nowMs));
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

// ---------------------------------------------------------------------------
// StuckReason vocabulary — Round 13 slice 2 (carina).
//
// Single source of truth shared between:
//   - scripts/monitor.ts (carina, slice 2): online detector — emits
//     `stuck=<reason>` notifications to chat as conditions arm.
//   - scripts/agent-chat.ts doctor --liveness (keystone, slice 3): offline
//     reporter — emits `stuck-offline=<reason>` for the same vocabulary.
//
// orion Phase-1.5 confirm #4: pull the reason union from a single shared
// definition so a future rename can't drift between slices.
//
// The three conditions:
//   peer-sidecar-dead       — turn = peer; peer's heartbeat is stale → peer's
//                             sidecar is dead, their turn won't progress
//                             without manual intervention.
//   local-sidecar-dead      — turn = me; MY sidecar's heartbeat is stale →
//                             agent-chat exit + init recommended.
//   agent-stuck-on-own-turn — turn = me; turn has been on me for >timeout
//                             with no lock and no CONVO.md growth → the
//                             session is alive but not making progress
//                             (Round-12 hang case orion himself exhibited).
// ---------------------------------------------------------------------------

export type StuckReason =
  | "peer-sidecar-dead"
  | "local-sidecar-dead"
  | "agent-stuck-on-own-turn";

// `as const satisfies` pins the array against the union at compile time.
// Round-13 Phase-4 keystone→carina drift-insurance nit: a future rename of
// either side without the other now trips a TS error. Same lesson as Round-12
// bm25-weights drift (one wire-shape primitive, two consumer sites that must
// stay in lockstep) applied preventively to the StuckReason union.
export const STUCK_REASONS = [
  "peer-sidecar-dead",
  "local-sidecar-dead",
  "agent-stuck-on-own-turn",
] as const satisfies ReadonlyArray<StuckReason>;

// `agent-stuck-on-own-turn` threshold. Default 5 min (300s). Env override
// `AGENT_CHAT_STUCK_TURN_TIMEOUT_MS` so deployments with legitimately long
// LLM calls can extend.
export const STUCK_TURN_TIMEOUT_MS = envInt("AGENT_CHAT_STUCK_TURN_TIMEOUT_MS", 300_000);
