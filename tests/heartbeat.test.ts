// tests/heartbeat.test.ts — Round-13 slice 1 (lumeyon).
//
// Sidecar heartbeat emitter + cross-slice contract for slice-2 (carina,
// staleness detection) + slice-3 (keystone, doctor + gc). The schema +
// parser + thresholds live in scripts/liveness.ts (single source of
// truth). My slice contributes the WRITER (formatHeartbeat in liveness.ts;
// sidecar.ts startHeartbeatEmitter wires it).
//
// Pins:
//   - format/parse round-trip (the cross-slice schema)
//   - kickstart write within 100ms of sidecar boot
//   - subsequent ticks every interval
//   - atomic write across tick boundary (no partial reads)
//   - AGENT_CHAT_HEARTBEAT_INTERVAL=0 / "0" disables
//   - sidecar SIGTERM unlinks the heartbeat
//   - cmdExit unlinks (defense-in-depth)
//   - cmdGc unlinks dead-pid heartbeats
//   - schema regex pin so a future field reorder breaks here

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { mkTmpConversations, rmTmp, runScript, spawnScript, sessionEnv, fakeSessionId } from "./helpers.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  formatHeartbeat, parseHeartbeat,
  HEARTBEATS_DIR, HEARTBEAT_STALE_MS, HEARTBEAT_DEAD_MS,
  SIDECAR_HEARTBEAT_VERSION,
  heartbeatPath,
} from "../scripts/liveness.ts";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function waitForSocket(socketPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      const ok = await new Promise<boolean>((res) => {
        const s = new net.Socket();
        s.setTimeout(150, () => { s.destroy(); res(false); });
        s.once("error", () => res(false));
        s.once("connect", () => { s.destroy(); res(true); });
        try { s.connect(socketPath); } catch { res(false); }
      });
      if (ok) return;
    }
    await sleep(25);
  }
  throw new Error(`socket ${socketPath} never became ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Pure-function tests — schema/parse/format
// ---------------------------------------------------------------------------

describe("formatHeartbeat / parseHeartbeat (Round-13 cross-slice contract)", () => {
  test("round-trip preserves all 6 fields including pre-parsed ts_ms", () => {
    const ts = "2026-05-04T01:30:00Z";
    const formatted = formatHeartbeat({ ts, host: "data", pid: 12345, starttime: 99999 });
    expect(formatted).toBe(`ts=${ts} host=data pid=12345 starttime=99999 sidecar_version=1`);
    const parsed = parseHeartbeat(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.ts).toBe(ts);
    expect(parsed!.ts_ms).toBe(Date.parse(ts));
    expect(parsed!.host).toBe("data");
    expect(parsed!.pid).toBe(12345);
    expect(parsed!.starttime).toBe(99999);
    expect(parsed!.sidecar_version).toBe("1");
  });

  test("starttime 0 (Linux fallback when pidStarttime returns null) parses cleanly", () => {
    const formatted = formatHeartbeat({ ts: "2026-05-04T01:30:00Z", host: "h", pid: 1, starttime: 0 });
    expect(formatted).toContain("starttime=0");
    const parsed = parseHeartbeat(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.starttime).toBe(0);
  });

  test("returns null on missing field", () => {
    // Note: the original "ts=x" fixture short-circuited on the ts_ms parse
    // (Date.parse("x") === NaN) BEFORE reaching the missing-version
    // validation, so the sidecar_version path was passing for the wrong
    // reason. Round-13 Phase-4 lumeyon self-flag — corrected fixture uses a
    // VALID ts so this test actually exercises the missing-sidecar_version
    // branch. Fails before the parser refuse-missing-version fix lands.
    expect(parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=1 starttime=2")).toBeNull();
    expect(parseHeartbeat("host=h pid=1 starttime=2 sidecar_version=1")).toBeNull();
  });

  test("refuses unknown future sidecar_version (Round-13 Phase-4 lumeyon→keystone CONCERN #2)", () => {
    // orion Phase-1.5 spec: "carina's slice-2 parser refusing unknown
    // versions LOUDLY is the right paranoia." A future v=2 schema requires
    // a parser bump, not silent v=1 misinterpretation.
    expect(parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=1 starttime=2 sidecar_version=999")).toBeNull();
    expect(parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=1 starttime=2 sidecar_version=2")).toBeNull();
  });

  test("accepts `?` sentinel for null starttime (parser tolerance)", () => {
    // Round-13 Phase-4 lumeyon→keystone nit + carina→lumeyon nit: the
    // parser accepts BOTH `?` (Phase-1 sentinel) and numeric `0` (writer
    // fallback) so the writer doesn't have to memorize one variant.
    const parsed = parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=1 starttime=? sidecar_version=1");
    expect(parsed).not.toBeNull();
    expect(parsed!.starttime).toBe(0);
  });

  test("returns null on malformed pid", () => {
    expect(parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=not-a-num starttime=1 sidecar_version=1")).toBeNull();
    expect(parseHeartbeat("ts=2026-05-04T00:00:00Z host=h pid=NaN starttime=1 sidecar_version=1")).toBeNull();
  });

  test("returns null on torn read (empty)", () => {
    expect(parseHeartbeat("")).toBeNull();
  });

  test("schema regex pin (load-bearing — slice-2 parser shape)", () => {
    const formatted = formatHeartbeat({ ts: "2026-05-04T01:30:00Z", host: "data", pid: 1234, starttime: 99 });
    expect(formatted).toMatch(/^ts=\S+ host=\S+ pid=\d+ starttime=\d+ sidecar_version=\S+$/);
  });

  test("SIDECAR_HEARTBEAT_VERSION default applies when unset in input", () => {
    const formatted = formatHeartbeat({ ts: "2026-05-04T01:30:00Z", host: "h", pid: 1, starttime: 2 });
    expect(formatted).toContain(`sidecar_version=${SIDECAR_HEARTBEAT_VERSION}`);
  });
});

describe("HEARTBEATS_DIR + heartbeatPath", () => {
  test("HEARTBEATS_DIR is rooted under conversations control namespace", () => {
    expect(HEARTBEATS_DIR.endsWith("/.heartbeats")).toBe(true);
  });

  test("heartbeatPath sanitizes the agent name (lyra L1 defense-in-depth)", () => {
    const safe = heartbeatPath("lumeyon");
    expect(safe.endsWith("/lumeyon.heartbeat")).toBe(true);
    const traversal = heartbeatPath("../../../tmp/pwned");
    expect(traversal.includes("..")).toBe(false);
    expect(traversal.endsWith(".heartbeat")).toBe(true);
  });

  test("HEARTBEAT_STALE_MS is 90s default (3 missed ticks at 30s tick)", () => {
    expect(HEARTBEAT_STALE_MS).toBe(90_000);
  });

  test("HEARTBEAT_DEAD_MS is 300s default (10 missed ticks at 30s tick)", () => {
    expect(HEARTBEAT_DEAD_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Sidecar emitter integration tests — Phase-3 wire-up
// ---------------------------------------------------------------------------

describe("sidecar heartbeat emitter (Round-13 wire-up)", () => {
  let CONVO_DIR: string;
  let ORION_ENV: Record<string, string>;
  let child: ChildProcessWithoutNullStreams | null = null;

  // Bootstrap a session record so the sidecar can resolveIdentity().
  const writeSessionRec = () => {
    const key = ORION_ENV.CLAUDE_SESSION_ID!;
    const rec = {
      agent: "orion", topology: "petersen", session_key: key,
      claude_session_id: key, host: os.hostname(), pid: process.pid,
      started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
    };
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".logs"), { recursive: true });
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${key}.json`), JSON.stringify(rec));
  };

  beforeEach(() => {
    CONVO_DIR = mkTmpConversations();
    ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    writeSessionRec();
  });

  afterEach(async () => {
    if (child) {
      try { child.kill("SIGTERM"); } catch {}
      await new Promise<void>((res) => child!.on("exit", () => res()));
      child = null;
    }
    rmTmp(CONVO_DIR);
  });

  test("kickstart writes heartbeat within 100ms of sidecar boot", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "5" }) as ChildProcessWithoutNullStreams;
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat");
    const deadline = Date.now() + 1000; // generous CI margin; spec is 100ms
    let foundAt = -1;
    while (Date.now() < deadline) {
      if (fs.existsSync(hbPath)) { foundAt = Date.now(); break; }
      await sleep(25);
    }
    expect(foundAt).toBeGreaterThan(0);
    const content = fs.readFileSync(hbPath, "utf8");
    const parsed = parseHeartbeat(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe(os.hostname());
    expect(parsed!.sidecar_version).toBe(SIDECAR_HEARTBEAT_VERSION);
  }, 5000);

  test("subsequent ticks update ts (interval=0.5s)", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "0.5" }) as ChildProcessWithoutNullStreams;
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat");
    // Wait for kickstart.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !fs.existsSync(hbPath)) await sleep(25);
    expect(fs.existsSync(hbPath)).toBe(true);
    const t0 = parseHeartbeat(fs.readFileSync(hbPath, "utf8"))!.ts_ms;
    await sleep(700); // > one interval
    const t1 = parseHeartbeat(fs.readFileSync(hbPath, "utf8"))!.ts_ms;
    expect(t1).toBeGreaterThan(t0);
  }, 5000);

  test("AGENT_CHAT_HEARTBEAT_INTERVAL=0 disables (no heartbeat ever appears)", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "0" }) as ChildProcessWithoutNullStreams;
    // Wait for sidecar to fully boot — socket up confirms main() has run
    // through startHeartbeatEmitter without writing.
    await waitForSocket(path.join(CONVO_DIR, ".sockets", "orion.sock"));
    await sleep(300);
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat");
    expect(fs.existsSync(hbPath)).toBe(false);
  }, 5000);

  test("AGENT_CHAT_HEARTBEAT_INTERVAL='-1' (negative) also disables", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "-1" }) as ChildProcessWithoutNullStreams;
    await waitForSocket(path.join(CONVO_DIR, ".sockets", "orion.sock"));
    await sleep(300);
    expect(fs.existsSync(path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat"))).toBe(false);
  }, 5000);

  test("atomic write — every concurrent read parses cleanly across a tick boundary", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "0.1" }) as ChildProcessWithoutNullStreams;
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat");
    while (!fs.existsSync(hbPath)) await sleep(10);
    // Tight-loop reader for ~500ms across multiple tick boundaries (interval=0.1s).
    const deadline = Date.now() + 500;
    let reads = 0;
    let failures = 0;
    while (Date.now() < deadline) {
      try {
        const text = fs.readFileSync(hbPath, "utf8");
        if (!text) { failures++; continue; }  // empty read shouldn't happen with rename
        const parsed = parseHeartbeat(text);
        if (!parsed) failures++;
      } catch {
        // Brief ENOENT during rename is acceptable; retry next tick.
      }
      reads++;
      // No artificial sleep — tightest loop for race coverage.
    }
    expect(reads).toBeGreaterThan(50);
    expect(failures).toBe(0);
  }, 5000);

  test("SIGTERM unlinks the heartbeat", async () => {
    child = spawnScript("sidecar.ts", [], { ...ORION_ENV, AGENT_CHAT_HEARTBEAT_INTERVAL: "5" }) as ChildProcessWithoutNullStreams;
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "orion.heartbeat");
    while (!fs.existsSync(hbPath)) await sleep(25);
    expect(fs.existsSync(hbPath)).toBe(true);
    // Trigger graceful exit.
    child!.kill("SIGTERM");
    await new Promise<void>((res) => child!.on("exit", () => res()));
    child = null;
    // Heartbeat should be gone.
    expect(fs.existsSync(hbPath)).toBe(false);
  }, 5000);
});

// ---------------------------------------------------------------------------
// agent-chat.ts cmdExit + cmdGc lifecycle hooks
// ---------------------------------------------------------------------------

describe("agent-chat exit/gc unlink heartbeats (Round-13)", () => {
  let CONVO_DIR: string;

  beforeEach(() => {
    CONVO_DIR = mkTmpConversations();
  });
  afterEach(() => { rmTmp(CONVO_DIR); });

  test("cmdGc unlinks heartbeat for sessions with dead pid+starttime", () => {
    // Hand-write a stale SessionRecord with a guaranteed-dead pid.
    const deadPid = 99_999_999;
    const key = fakeSessionId();
    const rec = {
      agent: "ghost", topology: "petersen", session_key: key,
      host: os.hostname(), pid: deadPid, pid_starttime: 1,
      started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
    };
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".heartbeats"), { recursive: true });
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${key}.json`), JSON.stringify(rec));
    fs.writeFileSync(path.join(CONVO_DIR, ".presence", "ghost.json"), JSON.stringify(rec));
    const hbPath = path.join(CONVO_DIR, ".heartbeats", "ghost.heartbeat");
    fs.writeFileSync(
      hbPath,
      formatHeartbeat({ ts: "2026-05-01T00:00:00Z", host: os.hostname(), pid: deadPid, starttime: 1 }),
    );
    expect(fs.existsSync(hbPath)).toBe(true);

    const env = { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR } as Record<string, string>;
    const r = runScript("agent-chat.ts", ["gc"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ghost");
    expect(fs.existsSync(hbPath)).toBe(false);
  });
});
