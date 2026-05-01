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
