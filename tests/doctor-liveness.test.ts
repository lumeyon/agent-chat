// Round 13 slice 3 (keystone) — `agent-chat doctor --liveness` tests.
// Five tests per orion's Phase-1 spec: healthy / stale / orphan /
// missing-heartbeat / --json.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  mkTmpConversations, rmTmp, freshEnv, runScript, fakeSessionId, sessionEnv,
} from "./helpers.ts";

const AGENT = "keystone";
const TOPO = "petersen";

function writeHeartbeat(dir: string, agent: string, opts: { ageMs?: number; pid?: number; starttime?: number; host?: string } = {}): void {
  const heartbeats = path.join(dir, ".heartbeats");
  fs.mkdirSync(heartbeats, { recursive: true });
  const ts = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = opts.host ?? os.hostname();
  // Use the test runner's own pid by default — guaranteed alive AND its
  // starttime is queryable via lib's pidStarttime. That makes "fresh"
  // heartbeats classify correctly.
  const pid = opts.pid ?? process.pid;
  const starttime = opts.starttime ?? readPidStarttime(pid);
  const line = `ts=${ts} host=${host} pid=${pid} starttime=${starttime} sidecar_version=1`;
  fs.writeFileSync(path.join(heartbeats, `${agent}.heartbeat`), line);
}

function readPidStarttime(pid: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    const fields = stat.slice(rparen + 2).split(/\s+/);
    return parseInt(fields[19] ?? "0", 10);
  } catch { return 0; }
}

function writeSessionRecord(dir: string, key: string, agent: string, topology: string): void {
  const sessions = path.join(dir, ".sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const rec = {
    agent, topology, session_key: key,
    host: os.hostname(),
    pid: process.pid, pid_starttime: readPidStarttime(process.pid),
    started_at: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(path.join(sessions, `${safe}.json`), JSON.stringify(rec, null, 2));
}

describe("agent-chat doctor --liveness", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("healthy: fresh heartbeats + matching sessions → exit 0, all status=fresh", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, AGENT, { ageMs: 5_000 });  // 5s old, well under 90s stale threshold
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["doctor", "--liveness"], env, { allowFail: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("status=fresh");
    expect(r.stdout).toContain("all agents fresh");
  });

  test("stale: 120s-old heartbeat → exit 1, status=stale, agent named", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, AGENT, { ageMs: 120_000 });  // 120s, above 90s stale threshold
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["doctor", "--liveness"], env, { allowFail: true });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("status=stale");
    expect(r.stdout).toContain(AGENT);
    // Aligned with carina's StuckReason vocabulary (Round-13 Phase-2/3 ack):
    // stale heartbeats surface under peer-sidecar-dead since the operational
    // response is the same (carina's monitor escalates stale → dead at
    // threshold). Reason vocabulary is shared via liveness.ts.
    expect(r.stdout).toMatch(/stuck-offline=peer-sidecar-dead/);
  });

  test("orphan: heartbeat present, no matching session → exit 1, status=orphan", () => {
    // No session record for "ghost" agent, but a heartbeat file.
    writeHeartbeat(tmp, "ghost", { ageMs: 5_000 });
    const env = sessionEnv(tmp, AGENT, TOPO, fakeSessionId("ks"));
    // Also write a session for AGENT so resolveIdentity works (the doctor
    // command requires identity resolution to walk live sessions).
    writeSessionRecord(tmp, fakeSessionId("ks"), AGENT, TOPO);

    const r = runScript("agent-chat.ts", ["doctor", "--liveness"], env, { allowFail: true });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("ghost");
    expect(r.stdout).toMatch(/orphan/);
  });

  test("missing-heartbeat: live session, no heartbeat file → exit 1", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    // intentionally no writeHeartbeat — session exists, heartbeat doesn't
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["doctor", "--liveness"], env, { allowFail: true });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/missing-heartbeat|no heartbeat files/);
  });

  test("--json: emits valid JSON with diagnostics + thresholds", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, AGENT, { ageMs: 120_000 });  // stale
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["doctor", "--liveness", "--json"], env, { allowFail: true });
    expect(r.exitCode).toBe(1);
    // Should be a parseable JSON object.
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty("heartbeats");
    expect(parsed).toHaveProperty("diagnostics");
    expect(parsed).toHaveProperty("thresholds");
    expect(parsed.thresholds.stale_ms).toBe(90000);
    expect(parsed.thresholds.dead_ms).toBe(300000);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics[0].agent).toBe(AGENT);
  });
});
