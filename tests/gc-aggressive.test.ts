// Round 13 slice 3 (keystone) — `agent-chat gc --aggressive` tests.
// Four tests per orion's Phase-1 spec.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  mkTmpConversations, rmTmp, runScript, fakeSessionId, sessionEnv,
} from "./helpers.ts";

const AGENT = "keystone";
const TOPO = "petersen";

function readPidStarttime(pid: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    const fields = stat.slice(rparen + 2).split(/\s+/);
    return parseInt(fields[19] ?? "0", 10);
  } catch { return 0; }
}

function writeSessionRecord(dir: string, key: string, agent: string, topology: string, opts: { pid?: number; starttime?: number; host?: string } = {}): void {
  const sessions = path.join(dir, ".sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const pid = opts.pid ?? process.pid;
  const rec = {
    agent, topology, session_key: key,
    host: opts.host ?? os.hostname(),
    pid,
    pid_starttime: opts.starttime ?? readPidStarttime(pid),
    started_at: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(path.join(sessions, `${safe}.json`), JSON.stringify(rec, null, 2));
}

function writeHeartbeat(dir: string, agent: string, opts: { host?: string; pid?: number; starttime?: number } = {}): void {
  const heartbeats = path.join(dir, ".heartbeats");
  fs.mkdirSync(heartbeats, { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = opts.host ?? os.hostname();
  const pid = opts.pid ?? process.pid;
  const starttime = opts.starttime ?? readPidStarttime(pid);
  const line = `ts=${ts} host=${host} pid=${pid} starttime=${starttime} sidecar_version=1`;
  fs.writeFileSync(path.join(heartbeats, `${agent}.heartbeat`), line);
}

function writeOrphanSocket(dir: string, agent: string): void {
  const sockets = path.join(dir, ".sockets");
  fs.mkdirSync(sockets, { recursive: true });
  // A fake socket file (regular file, not real UDS) is enough to verify
  // the gc unlinks it. The real socket would be a UDS but `safeUnlink`
  // doesn't care.
  fs.writeFileSync(path.join(sockets, `${agent}.sock`), "");
}

describe("agent-chat gc --aggressive", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("orphan socket (no matching live session) → reaped by gc --aggressive", () => {
    // Live agent is keystone. Plant an orphan socket for ghost.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeOrphanSocket(tmp, "ghost");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["gc", "--aggressive"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("orphan socket for ghost");
    expect(fs.existsSync(path.join(tmp, ".sockets", "ghost.sock"))).toBe(false);
  });

  test("stale heartbeat (no matching live session) → reaped by gc --aggressive", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, "ghost");  // ghost has no session
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", ["gc", "--aggressive"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("stale heartbeat for ghost");
    expect(fs.existsSync(path.join(tmp, ".heartbeats", "ghost.heartbeat"))).toBe(false);
  });

  test("live agent's heartbeat survives gc --aggressive", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, AGENT);  // keystone is the live session
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["gc", "--aggressive"], env);
    // Live agent's heartbeat must NOT be unlinked.
    expect(fs.existsSync(path.join(tmp, ".heartbeats", `${AGENT}.heartbeat`))).toBe(true);
  });

  test("default gc (no --aggressive) does NOT touch other agents' state", () => {
    // Plant an orphan heartbeat. Default gc shouldn't touch it.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeHeartbeat(tmp, "ghost");
    writeOrphanSocket(tmp, "ghost");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["gc"], env);
    // The orphan heartbeat + socket must SURVIVE default gc — only
    // --aggressive sweeps cross-session state.
    expect(fs.existsSync(path.join(tmp, ".heartbeats", "ghost.heartbeat"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".sockets", "ghost.sock"))).toBe(true);
  });
});
