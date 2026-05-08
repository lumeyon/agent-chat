// ephemeral-peer-review.test.ts — covers the orion-driven peer review CLI.
//
// Two test groups:
//
//   1. composeReviewPrompt — pure-function tests, in-process. No
//      filesystem, no env, no module-load order concerns.
//
//   2. CLI integration — subprocess-based. CONVERSATIONS_DIR is frozen
//      at module load, so we MUST spawn the CLI with the env var set
//      from a fresh process. Subprocess pattern matches cmd-run.test.ts.
//      AGENT_CHAT_MOCK_PEER_RESPONSE is the test-only seam that lets the
//      CLI run without hitting the real LLM.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, freshEnv, fakeSessionId } from "./helpers.ts";
import { composeReviewPrompt } from "../scripts/ephemeral-peer-review.ts";

// ─── 1. composeReviewPrompt — pure-function tests ───────────────────────────

describe("composeReviewPrompt", () => {
  test("includes peer role, file, source, task", () => {
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: "Architecture and systems analyst.",
      modulePath: "/some/path/foo.ts",
      moduleSource: "export const x = 42;",
      task: "Find the bug in line 1.",
      capBytes: 30 * 1024,
    });
    expect(prompt).toContain("Architecture and systems analyst");
    expect(prompt).toContain("FILE: /some/path/foo.ts");
    expect(prompt).toContain("export const x = 42");
    expect(prompt).toContain("Find the bug in line 1");
    expect(prompt).toContain("You are lumeyon");
  });

  test("truncates oversize source with byte count", () => {
    const big = "A".repeat(100);
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: undefined,
      modulePath: "/x.ts",
      moduleSource: big,
      task: "Review.",
      capBytes: 50,
    });
    expect(prompt).toContain("[... truncated, 50 bytes elided ...]");
    expect(prompt).not.toContain("A".repeat(60));
  });

  test("omits role block when peer has no role declared", () => {
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: undefined,
      modulePath: "/x.ts",
      moduleSource: "x",
      task: "Review.",
      capBytes: 1024,
    });
    expect(prompt).not.toContain("Your role as lumeyon");
    expect(prompt).toContain("You are lumeyon");
  });
});

// ─── 2. CLI integration — subprocess pattern ────────────────────────────────

let CONVO_DIR: string;

function bootstrapOrionSession(convDir: string, sessionId: string): void {
  const rec = {
    agent: "orion",
    topology: "petersen",
    session_key: sessionId,
    claude_session_id: sessionId,
    host: os.hostname(),
    pid: process.pid,
    started_at: "2026-05-07T19:00:00Z",
    cwd: convDir,
  };
  fs.mkdirSync(path.join(convDir, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(convDir, ".presence"), { recursive: true });
  fs.writeFileSync(path.join(convDir, ".sessions", `${sessionId}.json`), JSON.stringify(rec));
  fs.writeFileSync(path.join(convDir, ".presence", "orion.json"), JSON.stringify(rec));
  // Seed the petersen edges orion needs.
  for (const peer of ["lumeyon", "keystone", "carina"]) {
    const edgeId = ["orion", peer].sort().join("-");
    const edgeDir = path.join(convDir, "petersen", edgeId);
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.writeFileSync(
      path.join(edgeDir, "CONVO.md"),
      `# CONVO — orion ↔ ${peer}\n\nProtocol: agent-chat\n`,
    );
    fs.writeFileSync(path.join(edgeDir, "CONVO.md.turn"), "parked");
  }
}

function orionEnv(extra: Record<string, string> = {}): Record<string, string> {
  const sessionId = extra.CLAUDE_SESSION_ID ?? fakeSessionId("orion");
  return freshEnv({
    AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR,
    CLAUDE_SESSION_ID: sessionId,
    ...extra,
  }) as Record<string, string>;
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
});

afterEach(() => {
  rmTmp(CONVO_DIR);
});

describe("ephemeral-peer-review CLI — happy path", () => {
  test("writes orion request + peer response, parks the edge", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "target.ts");
    fs.writeFileSync(moduleFile, "export const meaning = 42;");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile, "--no-import", "--task", "Look for bugs."],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "MOCK PEER RESPONSE\n\nNo issues found.\n\n→ orion",
      }),
    );

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ephemeral peer review");
    expect(r.stdout).toContain("MOCK PEER RESPONSE");

    const convoPath = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    const convo = fs.readFileSync(convoPath, "utf8");
    expect(convo).toContain("## orion — ephemeral peer review request: target.ts");
    expect(convo).toContain("## lumeyon — ephemeral peer review response: target.ts");
    expect(convo).toContain("MOCK PEER RESPONSE");

    // Last arrow must be → parked, not → orion.
    const arrows = convo.match(/→\s+\S+/g) ?? [];
    expect(arrows[arrows.length - 1]).toBe("→ parked");

    const turnPath = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md.turn");
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    const lockPath = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md.turn.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("strips a trailing → orion from the peer response and adds → parked", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "keystone", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Looks fine.\n\n→ orion",
      }),
    );

    const convoPath = path.join(CONVO_DIR, "petersen", "keystone-orion", "CONVO.md");
    const convo = fs.readFileSync(convoPath, "utf8");
    const arrows = convo.match(/→\s+\S+/g) ?? [];
    expect(arrows[arrows.length - 1]).toBe("→ parked");
  });
});

describe("ephemeral-peer-review CLI — validation", () => {
  test("rejects a peer not adjacent to orion in petersen", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "vanguard", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored",
      }),
      { allowFail: true },
    );

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not adjacent to orion");
  });

  test("rejects a missing module file", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", "/nonexistent/file.ts", "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored",
      }),
      { allowFail: true },
    );

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("module not found");
  });

  test("requires --peer and --module", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon"],
      orionEnv({ CLAUDE_SESSION_ID: sid }),
      { allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("required");
  });

  // Regression for lumeyon's NL4 E6 finding: --review-cap-bytes accepted
  // NaN (no truncation, advertised cap silently ignored) and negative
  // values (misleading "bytes elided" count). Validation added.
  test("E6: rejects non-numeric --review-cap-bytes", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile, "--no-import", "--review-cap-bytes", "abc"],
      orionEnv({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored" }),
      { allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/review-cap-bytes/i);
  });

  test("E6: rejects negative --review-cap-bytes", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile, "--no-import", "--review-cap-bytes", "-100"],
      orionEnv({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored" }),
      { allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/review-cap-bytes/i);
  });

  test("E6: rejects zero --review-cap-bytes", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile, "--no-import", "--review-cap-bytes", "0"],
      orionEnv({ CLAUDE_SESSION_ID: sid, AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored" }),
      { allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/review-cap-bytes/i);
  });
});

describe("ephemeral-peer-review CLI — failure path parks the edge", () => {
  test("dispatch timeout leaves the edge parked, not stuck on orion", () => {
    // The mock-response env var only takes effect when set. To force the
    // dispatch to fail we use AGENT_CHAT_NO_LLM=1 which makes the runtime
    // adapter return reason=not-found; the CLI then errors. Pre-fix
    // (Round-15k early dog-food smoke), this left the edge on "orion".
    // Post-fix, the CLI parks the edge in its catch handler.
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "keystone-orion", "CONVO.md.turn");
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "keystone", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        // No mock response → adapter shells out → AGENT_CHAT_NO_LLM=1 from
        // freshEnv forces reason=not-found → CLI throws.
      }),
      { allowFail: true },
    );

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("dispatch failed");

    // Edge MUST be parked, not stuck on orion.
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");
    // Lock MUST be released.
    const lockPath = path.join(CONVO_DIR, "petersen", "keystone-orion", "CONVO.md.turn.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// Regression for lumeyon's NL4 E3 finding: lock acquisition was OUTSIDE
// the try block, so a lock-failure path left .turn stuck on "orion"
// (we'd resumed parked → orion before attempting the lock; failure
// raised before any cleanup ran). NL14 fix: revert .turn to its
// pre-resume state on lock failure.
describe("ephemeral-peer-review CLI — E3 lock-failure cleanup", () => {
  test("E3: foreign-owned stale lock causes lock failure; .turn reverts to parked", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md.turn");
    const lockPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md.turn.lock");
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    // Pre-create a stale lock owned by a different session/agent. The
    // CLI's `turn.ts lock` should refuse — it requires turn=id.name AND
    // either no lock or own-lock.
    fs.writeFileSync(
      lockPath,
      `lumeyon@otherhost:99999 starttime:0 ${new Date().toISOString()}\n`,
    );

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "carina", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "ignored",
      }),
      { allowFail: true },
    );

    // CLI should fail because lock acquisition failed.
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/lock failed|locked/i);

    // Pre-fix: .turn would be stuck at "orion" (we resumed but couldn't
    // park-on-failure since the catch never ran).
    // Post-fix: .turn must be back at "parked".
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    // The foreign-owned lock should still be there — we don't unlock
    // someone else's lock.
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe("ephemeral-peer-review CLI — resumes parked edges", () => {
  test("parked edge → orion request → peer response → parked", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md.turn");
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "carina", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Reviewed.\n\n→ orion",
      }),
    );

    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");
  });
});

// Regression for lumeyon's NL4 E1+E2 findings: the resume-write step
// in ephemeral-peer-review fired BEFORE the lock was acquired. Two
// related bugs:
//   E1 (line 206): the resume-write would flip `.turn` to orion even
//      when another agent (e.g., the peer mid-flow) currently held
//      the floor. The subsequent lock would then succeed (because
//      turn.ts lock requires .turn == self) and orion would proceed
//      to append+park, silently stealing the peer's floor.
//   E2 (line 206 + 213): two concurrent ephemeral-peer-review processes
//      could both flip .turn to orion before either acquired the lock;
//      the loser's E3 revert would then corrupt the winner's protocol
//      state by setting .turn back to "parked" while the winner held
//      the lock and was mid-write.
//
// NL21 fix: acquire the lock FIRST. The lock's existing invariant
// ("only the floor-holder can lock") covers the no-stealing requirement
// (orion's lock attempt fails when .turn is some other agent name);
// the resume-from-parked case writes .turn ONLY after the lock is held.
// Both races are eliminated structurally.
describe("ephemeral-peer-review CLI — E1 floor-stealing protection", () => {
  test("E1: refuses to ephemeral-peer-review when another agent holds .turn (no floor stealing)", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md.turn");
    const convoPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md");
    // Set .turn to carina (the peer for the carina-orion edge). carina
    // currently holds the floor; orion must NOT barge in.
    fs.writeFileSync(turnPath, "carina");
    const convoBefore = fs.readFileSync(convoPath, "utf8");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "carina", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Reviewed.\n\n→ orion",
      }),
      { allowFail: true },
    );

    // Pre-fix: orion would flip .turn to "orion", lock would then succeed
    // (since .turn matches), orion would append its request + the mocked
    // peer response, and park the edge. CONVO.md would have NEW content.
    // Post-fix: orion's lock attempt fails because .turn="carina" (turn.ts
    // lock refuses unless turn==self), no resume happens, no CONVO.md
    // changes occur, and .turn stays at "carina".
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/lock failed|refuse to lock|carina/i);

    // .turn must still be "carina" — orion didn't steal the floor.
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("carina");
    // CONVO.md must be unchanged — orion never wrote.
    expect(fs.readFileSync(convoPath, "utf8")).toBe(convoBefore);
  });

  test("E1: parked-edge happy path still works (only 'parked' or self resumes)", () => {
    // Sanity that the E1 fix doesn't break the legitimate resume-from-
    // parked flow. Same as the existing "resumes parked edges" test —
    // duplicated here to make this regression group self-contained.
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "carina-orion", "CONVO.md.turn");
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "carina", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Reviewed.\n\n→ orion",
      }),
    );

    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");
  });
});
