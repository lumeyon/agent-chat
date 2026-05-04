// monitor-liveness.test.ts — Round 13 slice 2 (carina) load-bearing
// coverage for monitor.ts's stuck-turn detector. Tests use a tmpdir
// CONVERSATIONS_DIR + the petersen topology, write fixture heartbeat files
// to simulate lumeyon's slice-1 writer, and run `monitor.ts --once` to get
// a single tick of stdout.
//
// Test #2 (`stuck=agent-stuck-on-own-turn`) is the Round-12-hang regression
// receipt — orion himself exhibited this exact failure mode during Phase-4/5
// of round 12, and the detector exists to make it visible.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkTmpConversations, rmTmp, runScript, sessionEnv } from "./helpers.ts";
import { pidStarttime } from "../scripts/lib.ts";

let CONVO_DIR: string;
let CARINA_ENV: Record<string, string>;
let SESSION_KEY: string;

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  CARINA_ENV = sessionEnv(CONVO_DIR, "carina", "petersen");
  SESSION_KEY = CARINA_ENV.CLAUDE_SESSION_ID!;
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".heartbeats"), { recursive: true });
  // Pre-create the session record so resolveIdentity finds carina@petersen.
  const rec = {
    agent: "carina", topology: "petersen", session_key: SESSION_KEY,
    claude_session_id: SESSION_KEY, host: os.hostname(), pid: process.pid,
    started_at: "2026-05-04T00:00:00Z", cwd: CONVO_DIR,
  };
  fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${SESSION_KEY}.json`), JSON.stringify(rec));
});

afterEach(() => { rmTmp(CONVO_DIR); });

// Helper: create the edge dir + .turn at a controlled value, then backdate
// the .turn mtime to simulate "turn has been on this value for N seconds".
function ensureEdge(peer: string): { dir: string; turn: string; convo: string } {
  // Petersen edge id is alphabetical; carina-orion, carina-pulsar, etc.
  const [a, b] = ["carina", peer].sort();
  const dir = path.join(CONVO_DIR, "petersen", `${a}-${b}`);
  fs.mkdirSync(dir, { recursive: true });
  const turn = path.join(dir, "CONVO.md.turn");
  const convo = path.join(dir, "CONVO.md");
  fs.writeFileSync(convo, "# CONVO — initial\n");
  return { dir, turn, convo };
}

function setTurn(turnPath: string, value: string, ageSec: number = 0): void {
  fs.writeFileSync(turnPath, value);
  if (ageSec > 0) {
    const t = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(turnPath, t, t);
  }
}

function writeHeartbeat(agent: string, ageSec: number = 0, opts: { dead?: boolean } = {}): void {
  const ts = new Date(Date.now() - ageSec * 1000).toISOString();
  // Use the test-process pid + ITS real starttime so classifyHeartbeat's
  // processIsOriginal returns true (heartbeat is "fresh" semantically — pid
  // is alive, starttime matches). For the dead variant, force a pid+
  // starttime pair that processIsOriginal rejects.
  const realStart = pidStarttime(process.pid) ?? 0;
  const pid = opts.dead ? 999_999_999 : process.pid;
  const starttime = opts.dead ? 999_999_999 : realStart;
  const line = `ts=${ts} host=${os.hostname()} pid=${pid} starttime=${starttime} sidecar_version=1`;
  fs.writeFileSync(path.join(CONVO_DIR, ".heartbeats", `${agent}.heartbeat`), line + "\n");
}

function runOnce(extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  return runScript("monitor.ts", ["--once"], { ...CARINA_ENV, ...extraEnv });
}

describe("monitor stuck-turn detector — Round 13 slice 2", () => {
  test("1. stale peer heartbeat + turn=peer → emit peer-sidecar-dead", () => {
    const e = ensureEdge("orion");
    setTurn(e.turn, "orion");
    writeHeartbeat("carina", 10);                      // own heartbeat fresh
    writeHeartbeat("orion", 200);                      // peer's heartbeat 200s old (>90s stale threshold)
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/stuck=peer-sidecar-dead/);
    expect(r.stdout).toMatch(/peer=orion/);
    expect(r.stdout).toMatch(/edge=carina-orion/);
  });

  test("2. ROUND-12 HANG REGRESSION — turn=me, no lock, mtime old → emit agent-stuck-on-own-turn", () => {
    // The exact failure mode orion himself exhibited during Round-12
    // Phase-4/5: turn was on him, no lock, no recent CONVO.md growth, but
    // he simply stopped processing. The monitor had no way to surface it.
    // Detector pin: this test fails if a future refactor breaks the case.
    const e = ensureEdge("orion");
    setTurn(e.turn, "carina", 360);                    // turn on me, 360s old (>300s default timeout)
    writeHeartbeat("carina", 10);                      // own heartbeat fresh — alive but stuck
    // CONVO.md was created in ensureEdge with no recent writes; backdate it too.
    const oldT = new Date(Date.now() - 400 * 1000);
    fs.utimesSync(e.convo, oldT, oldT);
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/stuck=agent-stuck-on-own-turn/);
    expect(r.stdout).toMatch(/turn_age_s=\d+/);
    expect(r.stdout).toMatch(/timeout_s=300/);
  });

  test("3. stale own heartbeat + turn=me → emit local-sidecar-dead", () => {
    const e = ensureEdge("orion");
    setTurn(e.turn, "carina");                         // turn on me, recent
    writeHeartbeat("carina", 200);                     // own heartbeat 200s old (>90s)
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/stuck=local-sidecar-dead/);
    expect(r.stdout).toMatch(/edge=carina-orion/);
  });

  test("4. recovery: stale → fresh → no re-emit; back to stale → re-emit (re-arm)", () => {
    // The re-arm semantic — when condition clears, the *Emitted flag clears
    // too, so a future re-occurrence emits again. Tested by running 3 ticks
    // sequentially via 3 separate `monitor --once` invocations.
    //
    // Note: this verifies the SINGLE-TICK behavior (each --once is a fresh
    // process so the in-memory ratelimit doesn't carry across runs). The
    // re-arm logic in a long-running monitor is exercised by tests 1-3
    // (each fires exactly once per --once run because the flag starts
    // false). A more thorough re-arm test would require a long-running
    // monitor harness — out of scope for this slice.
    const e = ensureEdge("orion");
    setTurn(e.turn, "orion");
    writeHeartbeat("carina", 10);
    writeHeartbeat("orion", 200);                      // stale → emits
    const r1 = runOnce();
    expect(r1.stdout).toMatch(/stuck=peer-sidecar-dead/);

    writeHeartbeat("orion", 10);                       // freshen
    const r2 = runOnce();
    // Fresh state in this --once invocation; emit flag was reset on process
    // boot. No emission expected (peer heartbeat is fresh).
    expect(r2.stdout).not.toMatch(/stuck=peer-sidecar-dead/);

    writeHeartbeat("orion", 200);                      // stale again
    const r3 = runOnce();
    expect(r3.stdout).toMatch(/stuck=peer-sidecar-dead/);
  });

  test("5. turn=parked → no stuck emission regardless of heartbeat or turn age", () => {
    const e = ensureEdge("orion");
    setTurn(e.turn, "parked", 600);                    // parked, 600s old
    writeHeartbeat("carina", 200);                     // own heartbeat stale
    writeHeartbeat("orion", 200);                      // peer heartbeat stale
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/stuck=peer-sidecar-dead/);
    expect(r.stdout).not.toMatch(/stuck=local-sidecar-dead/);
    expect(r.stdout).not.toMatch(/stuck=agent-stuck-on-own-turn/);
  });

  test("6. lock held + turn=me >timeout → no agent-stuck-on-own-turn (active lock = progress)", () => {
    const e = ensureEdge("orion");
    setTurn(e.turn, "carina", 360);                    // turn on me, 360s old
    writeHeartbeat("carina", 10);                      // own heartbeat fresh
    // Active lock: peer is mid-write; this is NOT a stuck state.
    // Round-13 Phase-5: post-keystone-CONCERN-#1 fix the lock check uses
    // processIsOriginal, so the lock body must encode a genuinely live
    // pid+starttime pair. Use the test runner's own pid + real starttime.
    const realStart = pidStarttime(process.pid) ?? 0;
    fs.writeFileSync(
      path.join(e.dir, "CONVO.md.turn.lock"),
      `carina@host:${process.pid}:${realStart} ${new Date().toISOString()}\n`,
    );
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/stuck=agent-stuck-on-own-turn/);
  });

  test("7. STALE-LOCK REGRESSION — dead-pid lock must NOT suppress agent-stuck-on-own-turn", () => {
    // Round-13 Phase-4 keystone→carina CONCERN #1: bare `lockHeld =
    // fs.existsSync(e.lock)` previously suppressed emission whenever a
    // stale lock from a dead session was present — the OPPOSITE of
    // progress, and exactly the failure mode lumeyon exhibited at
    // 02:02Z when his park flow forgot to unlock and the orchestrator
    // (orion) had to manually `rm` the lock to recover.
    //
    // The fix: lockHeldByLiveSession uses parseLockFile + processIsOriginal.
    // Recorded pid `999_999_999` with starttime `999_999_999` cannot be a
    // live original process; this dead-pid pattern matches what
    // writeHeartbeat uses for its dead-pid variant elsewhere.
    const e = ensureEdge("orion");
    setTurn(e.turn, "carina", 360);                    // turn on me, 360s old
    writeHeartbeat("carina", 10);                      // own heartbeat fresh
    // CONVO.md was created in ensureEdge with no recent writes; backdate
    // it past the timeout so recentConvoGrowth doesn't suppress emission
    // (matches test #2's pattern).
    const oldT = new Date(Date.now() - 400 * 1000);
    fs.utimesSync(e.convo, oldT, oldT);
    // Stale lock: dead pid + dead starttime. Must not suppress emission.
    fs.writeFileSync(
      path.join(e.dir, "CONVO.md.turn.lock"),
      `carina@host:999999999:999999999 ${new Date().toISOString()}\n`,
    );
    const r = runOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/stuck=agent-stuck-on-own-turn/);
  });
});
