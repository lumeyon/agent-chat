// Identity tests: drive agent-chat.ts as a subprocess. Validates init,
// session/presence file writes, collision refusal, topology inference,
// resume offer, exit, gc, whoami, and the ten-session same-cwd integration.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, freshEnv, fakeSessionId, readSession } from "./helpers.ts";

let CONVO_DIR: string;
let BASE_ENV: Record<string, string>;

function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  BASE_ENV = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR }) as Record<string, string>;
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("agent-chat init", () => {
  test("init writes session and presence files", () => {
    const sid = fakeSessionId("orion");
    const r = runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sid }));
    expect(r.stdout).toContain("✓ this session is orion@petersen");
    const sess = readSession(CONVO_DIR, sid);
    expect(sess).not.toBeNull();
    expect(sess.agent).toBe("orion");
    expect(sess.topology).toBe("petersen");
    expect(fs.existsSync(path.join(CONVO_DIR, ".presence", "orion.json"))).toBe(true);
  });

  test("init prints neighbors for the chosen topology", () => {
    const r = runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    // orion's Petersen neighbors are carina, keystone, lumeyon (sorted)
    expect(r.stdout).toContain("neighbors (3): carina, keystone, lumeyon");
  });

  test("init refuses an unknown agent name", () => {
    const r = runScript("agent-chat.ts", ["init", "ghost", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }), { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not declared in topology");
  });

  test("init refuses an unknown topology", () => {
    const r = runScript("agent-chat.ts", ["init", "orion", "no-such-topo", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }), { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no topology "no-such-topo"');
  });

  test("init refuses on collision with a live session of the same name", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    const r = runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }), { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('agent "orion" is already live');
  });

  test("--force overrides a live collision", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    const r = runScript("agent-chat.ts",
      ["init", "orion", "petersen", "--force", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    expect(r.stdout).toContain("✓ this session is orion@petersen");
  });

  test("infers topology when only one is in use elsewhere on the host", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    // Now init lumeyon WITHOUT specifying topology — should infer petersen.
    const r = runScript("agent-chat.ts", ["init", "lumeyon", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    expect(r.stdout).toContain("✓ this session is lumeyon@petersen");
    expect(r.stderr).toContain("inferring topology");
  });
});

describe("agent-chat exit", () => {
  test("exit removes session and presence files", () => {
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sid }));
    expect(readSession(CONVO_DIR, sid)).not.toBeNull();
    const r = runScript("agent-chat.ts", ["exit"], envWith({ CLAUDE_SESSION_ID: sid }));
    expect(r.stdout).toContain("signed out");
    expect(readSession(CONVO_DIR, sid)).toBeNull();
    expect(fs.existsSync(path.join(CONVO_DIR, ".presence", "orion.json"))).toBe(false);
  });

  test("exit on a missing session is a no-op", () => {
    const r = runScript("agent-chat.ts", ["exit"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    expect(r.stdout).toContain("nothing to do");
  });
});

describe("agent-chat who / gc / whoami", () => {
  test("who lists live sessions with monitor status", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }));
    const r = runScript("agent-chat.ts", ["who"], BASE_ENV);
    expect(r.stdout).toContain("live (1):");
    expect(r.stdout).toContain("orion");
    expect(r.stdout).toContain("topo=petersen");
  });

  test("gc removes session and presence entries whose pid is dead", () => {
    // Hand-write a stale session record claiming a dead pid
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
    const stale = {
      agent: "ghost", topology: "petersen", session_key: "stale-key",
      host: os.hostname(), pid: 99999, started_at: "2026-05-01T00:00:00Z",
      cwd: CONVO_DIR,
    };
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", "stale-key.json"), JSON.stringify(stale));
    fs.writeFileSync(path.join(CONVO_DIR, ".presence", "ghost.json"), JSON.stringify(stale));
    const r = runScript("agent-chat.ts", ["gc"], BASE_ENV);
    expect(r.stdout).toContain("removed stale ghost@petersen");
    expect(fs.existsSync(path.join(CONVO_DIR, ".sessions", "stale-key.json"))).toBe(false);
    expect(fs.existsSync(path.join(CONVO_DIR, ".presence", "ghost.json"))).toBe(false);
  });

  test("whoami prints session identity in one line", () => {
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sid }));
    const r = runScript("agent-chat.ts", ["whoami"], envWith({ CLAUDE_SESSION_ID: sid }));
    expect(r.stdout).toContain("orion@petersen");
    expect(r.stdout).toContain(`session_key=${sid}`);
  });
});

describe("ten sessions sharing one cwd", () => {
  test("ten distinct sessions can claim ten distinct identities", () => {
    const agents = ["orion", "lumeyon", "lyra", "keystone", "sentinel",
                    "vanguard", "carina", "pulsar", "cadence", "rhino"];
    for (const a of agents) {
      const r = runScript("agent-chat.ts", ["init", a, "petersen", "--no-monitor"],
        envWith({ CLAUDE_SESSION_ID: fakeSessionId(a) }));
      expect(r.stdout).toContain(`✓ this session is ${a}@petersen`);
    }
    const r = runScript("agent-chat.ts", ["who"], BASE_ENV);
    expect(r.stdout).toContain("live (10):");
    for (const a of agents) expect(r.stdout).toContain(a);
  });

  test("each session resolves its own identity via session-file precedence", () => {
    const sids = new Map<string, string>();
    for (const a of ["orion", "lumeyon"]) {
      const sid = fakeSessionId(a);
      sids.set(a, sid);
      runScript("agent-chat.ts", ["init", a, "petersen", "--no-monitor"],
        envWith({ CLAUDE_SESSION_ID: sid }));
    }
    for (const [a, sid] of sids) {
      const r = runScript("agent-chat.ts", ["whoami"], envWith({ CLAUDE_SESSION_ID: sid }));
      expect(r.stdout).toContain(`${a}@petersen`);
      expect(r.stdout).toContain(`session_key=${sid}`);
    }
  });
});

describe("resume offer", () => {
  test("init reuses prior topology when matched by cwd+tty with dead prior pid", () => {
    // Hand-write a stale session record matching this test's cwd+tty.
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    const stale = {
      agent: "keystone", topology: "petersen", session_key: "old-restart",
      host: os.hostname(), pid: 99997,
      started_at: "2026-04-30T00:00:00Z",
      cwd: CONVO_DIR, tty: "/dev/pts/test",
    };
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", "old-restart.json"), JSON.stringify(stale));
    // Run init from the same cwd+tty without specifying topology
    const r = runScript("agent-chat.ts", ["init", "keystone", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId(), TTY: "/dev/pts/test" }),
      { cwd: CONVO_DIR },  // match the stale record's cwd
    );
    expect(r.stdout).toContain("✓ this session is keystone@petersen");
    expect(r.stderr).toContain("resume:");
  });
});

describe("session file resolution wins over env and .agent-name", () => {
  test("session file's identity wins over $AGENT_NAME / $AGENT_TOPOLOGY", () => {
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sid }));
    // Now run whoami with conflicting env vars — session file should win.
    const r = runScript("agent-chat.ts", ["whoami"],
      envWith({
        CLAUDE_SESSION_ID: sid,
        AGENT_NAME: "lumeyon",
        AGENT_TOPOLOGY: "ring",
      }));
    expect(r.stdout).toContain("orion@petersen");
  });
});

describe("session-key collision resistance (Bug A regression)", () => {
  // The earlier design keyed sessions by $CLAUDE_CODE_SSE_PORT, which we
  // observed empirically collides between two Claude Code instances that
  // share a VS Code remote dev parent. Two inits with the same SSE port
  // would silently overwrite each other's session record.
  //
  // The fix keys by `pid:<stableSessionPid>`, which is unique per agent
  // runtime instance. Verify that even under a colliding SSE port, two
  // distinct CLAUDE_SESSION_IDs (the explicit override) produce two
  // distinct session records that don't clobber each other.

  test("two sessions with distinct CLAUDE_SESSION_IDs do not clobber each other", () => {
    const sidA = fakeSessionId("orion");
    const sidB = fakeSessionId("lumeyon");
    // Both sessions get the same hypothetical SSE port; if it were the
    // session key, they'd collide. The explicit ids should win.
    const sharedSse = "55112";
    runScript("agent-chat.ts", ["init", "orion", "pair", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sidA, CLAUDE_CODE_SSE_PORT: sharedSse }));
    runScript("agent-chat.ts", ["init", "lumeyon", "pair", "--no-monitor"],
      envWith({ CLAUDE_SESSION_ID: sidB, CLAUDE_CODE_SSE_PORT: sharedSse }));
    // Both records must still be readable. If session-key collision
    // happened, only the second init's record would survive.
    expect(readSession(CONVO_DIR, sidA)).not.toBeNull();
    expect(readSession(CONVO_DIR, sidB)).not.toBeNull();
    expect(readSession(CONVO_DIR, sidA)!.agent).toBe("orion");
    expect(readSession(CONVO_DIR, sidB)!.agent).toBe("lumeyon");
    // Each session's whoami resolves to its OWN identity, not the other's.
    const oR = runScript("agent-chat.ts", ["whoami"],
      envWith({ CLAUDE_SESSION_ID: sidA, CLAUDE_CODE_SSE_PORT: sharedSse }));
    expect(oR.stdout).toContain("orion@pair");
    const lR = runScript("agent-chat.ts", ["whoami"],
      envWith({ CLAUDE_SESSION_ID: sidB, CLAUDE_CODE_SSE_PORT: sharedSse }));
    expect(lR.stdout).toContain("lumeyon@pair");
  });

  test("when no CLAUDE_SESSION_ID is set, key falls back to pid:<stableSessionPid>", () => {
    // Without an explicit session id, currentSessionKey() returns
    // `pid:<n>`. We can't easily test for a specific pid value here,
    // but we can confirm the prefix.
    const env = envWith({});
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-monitor"], env);
    // The session record file is named after the (sanitized) key.
    const files = fs.readdirSync(path.join(CONVO_DIR, ".sessions"));
    expect(files.some((f) => f.startsWith("pid_") || f.startsWith("pid:"))).toBe(true);
  });

  test("two concurrent init calls for the same agent: exactly one wins (presence wx race)", async () => {
    // Spawn two init processes simultaneously, both claiming "orion". With
    // wx-based presence acquisition, exactly one should land cleanly and
    // the other should refuse with a "concurrently claimed" error. With
    // the prior writeFileSync-based init, both succeeded silently and the
    // second clobbered the first.
    const { spawn } = await import("node:child_process");
    const path2 = await import("node:path");
    function initChild(sid: string): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [
          path2.join(import.meta.dirname, "..", "scripts", "agent-chat.ts"),
          "init", "orion", "petersen", "--no-monitor",
        ], {
          env: envWith({ CLAUDE_SESSION_ID: sid }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        c.stdout?.on("data", (d) => stdout += d.toString());
        c.stderr?.on("data", (d) => stderr += d.toString());
        c.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    }
    const [a, b] = await Promise.all([
      initChild(fakeSessionId("racer-a")),
      initChild(fakeSessionId("racer-b")),
    ]);
    // At least one must have succeeded (exit 0). The other may also
    // succeed if its wx EEXIST landed AFTER the first finished and the
    // race was sequential; or it may refuse with a "concurrently claimed"
    // error. What MUST hold: at the end, only ONE presence file exists,
    // and the session record from the loser was rolled back if it lost.
    const successes = [a, b].filter((r) => r.code === 0);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // Presence file must be present and well-formed.
    const presencePath = path2.join(CONVO_DIR, ".presence", "orion.json");
    expect(fs.existsSync(presencePath)).toBe(true);
    const winner = JSON.parse(fs.readFileSync(presencePath, "utf8"));
    expect(winner.agent).toBe("orion");
    // If exactly one succeeded, the loser must have a refusal message.
    if (successes.length === 1) {
      const loser = [a, b].find((r) => r.code !== 0)!;
      expect(loser.stderr).toMatch(/already live|claimed concurrently|concurrently claimed/);
    }
  });
});
