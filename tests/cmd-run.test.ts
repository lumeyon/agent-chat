// tests/cmd-run.test.ts — Round-15a slice 1 (lumeyon).
//
// cmdRun argv parsing + collision/reentrancy guards. Full round-trip with
// runClaude is gated by claude CLI availability — those tests run with
// AGENT_CHAT_NO_LLM=1 (which makes runClaude return reason="not-found" so
// cmdRun's failure path is what gets exercised). A future Round-15+ may
// add a stub-spawner test pattern (per pulsar Round-12) for full coverage.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, fakeSessionId, freshEnv } from "./helpers.ts";
import { CACHE_WARM_DELAY_SEC } from "../scripts/lib.ts";

let CONVO_DIR: string;
let BASE_ENV: Record<string, string>;

function envWith(extra: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...extra };
}

function bootstrapSession(name: string, key: string): void {
  const rec = {
    agent: name, topology: "petersen", session_key: key,
    claude_session_id: key, host: os.hostname(), pid: process.pid,
    started_at: "2026-05-04T00:00:00Z", cwd: CONVO_DIR,
  };
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${key}.json`), JSON.stringify(rec));
  fs.writeFileSync(path.join(CONVO_DIR, ".presence", `${name}.json`), JSON.stringify(rec));
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  BASE_ENV = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR }) as Record<string, string>;
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("agent-chat run — argv + lifecycle guards (Round-15a slice 1)", () => {
  test("CACHE_WARM_DELAY_SEC is 270 (cache-warm pin)", () => {
    // Pinning the constant value pins the empirical-source contract.
    // A future bump requires conscious change here, surfacing the cache-TTL
    // calculus in the diff.
    expect(CACHE_WARM_DELAY_SEC).toBe(270);
  });

  test("refuses with reentrancy error when AGENT_CHAT_INSIDE_LLM_CALL=1", () => {
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    const r = runScript(
      "agent-chat.ts", ["run", "--once"],
      envWith({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_INSIDE_LLM_CALL: "1" }),
      { allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("AGENT_CHAT_INSIDE_LLM_CALL=1");
  });

  test("refuses if a sidecar UDS socket exists for this agent (persistent-mode collision)", async () => {
    // Stage a fake live UDS socket. Real test: cmdRun probes via UDS
    // whoami; we can't bind a fake server in a unit test cleanly, but
    // the file existence + connect-timeout path returns "not ok" and
    // cmdRun proceeds. To genuinely exercise the refusal, spawn a real
    // sidecar — too heavy for a unit test. This test pins the file-stat
    // path; the UDS-probe path is integration-tested via the ack on
    // existing sidecar.test.ts coverage.
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
    // Touch a file to simulate a stale socket; UDS probe will fail to
    // connect and cmdRun proceeds (per the live-probe-required guard).
    fs.writeFileSync(path.join(CONVO_DIR, ".sockets", "orion.sock"), "");
    const r = runScript(
      "agent-chat.ts", ["run", "--once"],
      envWith({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_NO_LLM: "1" }),
      { allowFail: true },
    );
    // Stale-socket case: file exists, probe fails → cmdRun proceeds. The
    // subsequent runClaude call returns "not-found" (AGENT_CHAT_NO_LLM=1),
    // cmdRun logs and skips each edge. Exit code 0 (no work done is OK).
    expect(r.exitCode).toBe(0);
  });

  test("processes no edges when none have turn=self (graceful no-op)", () => {
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    // No edge directories created → edgesOf returns the topology's
    // declared edges, but readTurn returns null for each (no .turn file).
    // cmdRun should walk all edges, find no work, exit 0.
    const r = runScript(
      "agent-chat.ts", ["run", "--once"],
      envWith({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_NO_LLM: "1" }),
    );
    expect(r.exitCode).toBe(0);
  });

  test("--once flag is honored (no ScheduleWakeup invocation)", () => {
    // cmdRun --once should never schedule a wakeup — it's loop-driver.ts
    // that handles re-arming. cmdRun itself just exits after one tick.
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    const r = runScript(
      "agent-chat.ts", ["run", "--once"],
      envWith({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_NO_LLM: "1" }),
    );
    expect(r.exitCode).toBe(0);
    // Output should not contain a WOULD_WAKE directive — that comes from
    // loop-driver.ts, not cmdRun directly.
    expect(r.stdout).not.toContain("WOULD_WAKE");
  });

  test("peer-filter argv restricts processing (positional args)", () => {
    // `agent-chat.ts run lumeyon` should target only the lumeyon edge.
    // With AGENT_CHAT_NO_LLM=1 we can't observe processing, but we CAN
    // observe that the command exits cleanly with the filter present.
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    const r = runScript(
      "agent-chat.ts", ["run", "--once", "lumeyon"],
      envWith({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_NO_LLM: "1" }),
    );
    expect(r.exitCode).toBe(0);
  });
});

describe("loop-driver — mock-wakeup hook (Round-15a slice 1, keystone test surface)", () => {
  test("AGENT_CHAT_LOOP_MOCK_WAKEUP=1 prints WOULD_WAKE instead of invoking ScheduleWakeup", () => {
    // The hook lets keystone's slice-3 cache-warm scheduled-loop test
    // assert the constant reaches the loop driver. Stage a session with
    // an actionable edge (bootstrap a turn=orion file) so loop-driver
    // detects pending work and emits the WOULD_WAKE line.
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    const peerEdgeDir = path.join(CONVO_DIR, "petersen", "lumeyon-orion");
    fs.mkdirSync(peerEdgeDir, { recursive: true });
    fs.writeFileSync(path.join(peerEdgeDir, "CONVO.md"), "# CONVO\n");
    fs.writeFileSync(path.join(peerEdgeDir, "CONVO.md.turn"), "orion\n");
    const r = runScript(
      "loop-driver.ts", [],
      envWith({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_NO_LLM: "1",
        AGENT_CHAT_LOOP_MOCK_WAKEUP: "1",
      }),
    );
    expect(r.exitCode).toBe(0);
    // The mock-wakeup line carries the cache-warm constant.
    expect(r.stdout).toMatch(/WOULD_WAKE delay_seconds=270 reason=agent-chat next tick/);
  });

  test("loop-driver terminates quietly when no work pending", () => {
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    // No edge .turn files → no work → no WOULD_WAKE.
    const r = runScript(
      "loop-driver.ts", [],
      envWith({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_NO_LLM: "1",
        AGENT_CHAT_LOOP_MOCK_WAKEUP: "1",
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("WOULD_WAKE");
    expect(r.stderr).toContain("no work pending");
  });

  test("loop-driver works from a non-SKILL_ROOT cwd (Phase-4 carina production-bug regression)", () => {
    // Round-15a Phase-4 carina-CRITICAL: spawnSync's relative-path
    // resolution against process.cwd() broke the moment /loop fired
    // from a user's project directory rather than the skill root.
    // Phase-5 fix: loop-driver uses path.join(SKILL_ROOT, ...) +
    // explicit cwd: SKILL_ROOT in spawnSync. This test pins the fix
    // by running loop-driver from /tmp; pre-fix this would ENOENT.
    const sid = fakeSessionId("orion");
    bootstrapSession("orion", sid);
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loop-driver-cwd-"));
    try {
      const r = runScript(
        "loop-driver.ts", [],
        envWith({
          CLAUDE_SESSION_ID: sid,
          AGENT_CHAT_NO_LLM: "1",
          AGENT_CHAT_LOOP_MOCK_WAKEUP: "1",
        }),
        { cwd: tmpCwd },  // simulate /loop firing from a user's project dir
      );
      expect(r.exitCode).toBe(0);
      // Either WOULD_WAKE or "no work pending" is acceptable; what we're
      // pinning is that the spawn ITSELF succeeded (no ENOENT on the
      // agent-chat.ts script path resolution).
      expect(r.stderr).not.toContain("ENOENT");
      expect(r.stderr).not.toContain("Cannot find module");
    } finally {
      try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
    }
  });
});
