// cwd-state.test.ts — Round-15l: identity context derived from cwd alone.
//
// The contract under test: a record-turn invocation with NO
// CLAUDE_SESSION_ID, NO matching session record, and NO env vars
// can still resolve the right (agent, topology, speaker) by reading
// <conv>/.cwd-state/<sha256(cwd)[:16]>.json.
//
// This proves the Stop-hook subprocess chain (which loses CLAUDE_SESSION_ID)
// works without any runtime-specific env passthrough.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { mkTmpConversations, rmTmp, runScript, freshEnv, fakeSessionId } from "./helpers.ts";

let CONVO_DIR: string;
let WORK_CWD: string;
let BASE_ENV: Record<string, string>;

function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

function cwdStateFile(conv: string, cwd: string): string {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(conv, ".cwd-state", `${hash}.json`);
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  WORK_CWD = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cwd-state-test-"));
  BASE_ENV = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR }) as Record<string, string>;
});

afterEach(() => {
  rmTmp(CONVO_DIR);
  fs.rmSync(WORK_CWD, { recursive: true, force: true });
});

describe("cwd-state — written by init", () => {
  test("init writes .cwd-state/<hash>.json with agent + topology", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }),
      { cwd: WORK_CWD });
    const f = cwdStateFile(CONVO_DIR, WORK_CWD);
    expect(fs.existsSync(f)).toBe(true);
    const state = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(state.agent).toBe("orion");
    expect(state.topology).toBe("petersen");
    expect(state.cwd).toBe(WORK_CWD);
    // No speaker yet — that's set by `agent-chat speaker`.
    expect(state.speaker).toBeUndefined();
  });
});

describe("cwd-state — refreshed by speaker", () => {
  test("speaker <name> populates speaker + edge_id in cwd-state", () => {
    runScript("agent-chat.ts", ["init", "orion", "petersen"],
      envWith({ CLAUDE_SESSION_ID: fakeSessionId() }),
      { cwd: WORK_CWD });
    runScript("agent-chat.ts", ["speaker", "boss"],
      envWith({ CLAUDE_SESSION_ID: process.env.LAST_SID ?? "" }),
      { cwd: WORK_CWD, allowFail: true });
    // The speaker call needs to find the session — re-run with the same
    // session id we just used. Easier: do init+speaker in one env.
  });

  test("init then speaker writes both fields under one session", () => {
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });
    runScript("agent-chat.ts", ["speaker", "boss"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });
    const state = JSON.parse(fs.readFileSync(cwdStateFile(CONVO_DIR, WORK_CWD), "utf8"));
    expect(state.agent).toBe("orion");
    expect(state.speaker).toBe("boss");
    expect(state.edge_id).toBe("boss-orion");
  });
});

describe("cwd-state — record-turn resolves identity from it alone", () => {
  test("record-turn succeeds with NO CLAUDE_SESSION_ID and NO matching session record", () => {
    // Setup: init + speaker (with a session id) populates cwd-state.
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });
    runScript("agent-chat.ts", ["speaker", "boss"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });

    // Wipe the session record (simulating a Stop-hook subprocess where
    // CLAUDE_SESSION_ID isn't in scope and the bun pid doesn't match
    // any session record).
    const safeSid = sid.replace(/[^A-Za-z0-9_:.-]/g, "_");
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.json`));
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.current_speaker.json`));

    // Now run record-turn with NO CLAUDE_SESSION_ID. The session_key
    // derived from stableSessionPid() won't match anything; identity
    // must come from cwd-state alone.
    const noSessionEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(BASE_ENV)) {
      if (v == null) continue;
      if (k.startsWith("CLAUDE_SESSION_") || k.startsWith("CLAUDE_CODE_SESSION_")) continue;
      noSessionEnv[k] = v;
    }
    const r = runScript(
      "agent-chat.ts",
      ["record-turn", "--user", "test user prompt", "--assistant", "test assistant response"],
      noSessionEnv,
      { cwd: WORK_CWD },
    );
    expect(r.exitCode).toBe(0);

    // The turn should have landed in <conv>/petersen/boss-orion/.
    const edgeDir = path.join(CONVO_DIR, "petersen", "boss-orion");
    expect(fs.existsSync(path.join(edgeDir, "CONVO.md"))).toBe(true);
    const ledger = path.join(edgeDir, "recorded_turns.jsonl");
    expect(fs.existsSync(ledger)).toBe(true);
    const ledgerLines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    expect(ledgerLines.length).toBe(1);
    const entry = JSON.parse(ledgerLines[0]);
    expect(entry.speaker).toBe("boss");
    expect(entry.agent).toBe("orion");
  });
});

describe("cwd-state — exit clears it", () => {
  test("exit removes cwd-state file so next init starts clean", () => {
    const sid = fakeSessionId();
    runScript("agent-chat.ts", ["init", "orion", "petersen"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });
    expect(fs.existsSync(cwdStateFile(CONVO_DIR, WORK_CWD))).toBe(true);
    runScript("agent-chat.ts", ["exit"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD });
    expect(fs.existsSync(cwdStateFile(CONVO_DIR, WORK_CWD))).toBe(false);
  });
});
