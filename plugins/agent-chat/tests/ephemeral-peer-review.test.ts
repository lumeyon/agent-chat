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

  // Regression for lumeyon's NL4 E7 finding: composeReviewPrompt's module-
  // source truncation used JS .length (UTF-16 code units) and .slice (also
  // UTF-16). For non-ASCII module content (CJK comments, emoji in test
  // fixtures, accented Latin docs) this:
  //   - under-counted: payloads with multi-byte UTF-8 chars slipped past
  //     the byte budget unchanged (length < capBytes even when bytes >>
  //     capBytes), so cap-bytes failed to enforce its named contract;
  //   - mis-reported the elided-byte count when truncation did fire (it
  //     reported `length - capBytes` UTF-16 units, not bytes);
  //   - could split surrogate pairs mid-character.
  //
  // NL24 fix: same template as LC4 (NL23). Refactored to use a shared
  // truncateToUtf8Bytes utility from utf8.ts that counts and slices in
  // UTF-8 bytes, walking back to a non-continuation-byte boundary so
  // multi-byte sequences are preserved.
  test("E7: truncates by UTF-8 BYTES, not UTF-16 length (CJK content slips past pre-fix budget check)", () => {
    // 20 CJK chars × 3 UTF-8 bytes each = 60 bytes; UTF-16 length = 20.
    const cjkSource = "中".repeat(20);
    expect(cjkSource.length).toBe(20);                              // UTF-16
    expect(new TextEncoder().encode(cjkSource).length).toBe(60);    // UTF-8

    // capBytes = 30. Pre-fix: moduleSource.length (20) > capBytes (30)
    // is FALSE → no truncation; the full 60-byte CJK payload lands in
    // the prompt unchanged, despite the byte budget. Post-fix: byte-aware
    // comparison fires the truncation.
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: undefined,
      modulePath: "/x.ts",
      moduleSource: cjkSource,
      task: "Review.",
      capBytes: 30,
    });

    // Post-fix: prompt MUST contain the truncation marker (it didn't
    // pre-fix because the budget check used UTF-16 units).
    expect(prompt).toContain("[... truncated,");
    // Post-fix: prompt MUST NOT contain the full 60-byte payload.
    expect(prompt).not.toContain(cjkSource);
  });

  test("E7: surrogate-pair emoji content respects byte budget at character boundary", () => {
    // Each emoji is 4 UTF-8 bytes / 2 UTF-16 code units. 15 emoji = 60
    // bytes / 30 code units.
    const emojiSource = "🎉".repeat(15);
    expect(emojiSource.length).toBe(30);                            // UTF-16
    expect(new TextEncoder().encode(emojiSource).length).toBe(60);  // UTF-8

    // capBytes = 21 (deliberately ODD). Pre-fix: length (30) > capBytes
    // (21) → slice(0, 21) takes 21 UTF-16 code units = 10 emoji + 1 lone
    // high surrogate; the prompt contains 10 emoji visible to humans but
    // an orphaned surrogate at position 21 — when the model re-encodes,
    // it sees 10 valid emoji + a U+FFFD replacement. Post-fix: byte-
    // aware truncation walks back to a UTF-8 character boundary, leaving
    // exactly 5 emoji (20 bytes, fits in 21-byte budget).
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: undefined,
      modulePath: "/x.ts",
      moduleSource: emojiSource,
      task: "Review.",
      capBytes: 21,
    });

    // Pre-fix would put 10 emoji into the prompt's source block (plus
    // an orphan); post-fix puts at most 5 (20 bytes, ≤ 21-byte cap).
    expect(prompt).not.toContain("🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉");  // 10 emoji
    // Truncation marker should be present.
    expect(prompt).toContain("[... truncated,");
  });

  test("E7: ASCII content under cap unchanged (sanity / backwards compat)", () => {
    const ascii = "A".repeat(40);
    const prompt = composeReviewPrompt({
      peer: "lumeyon",
      peerRole: undefined,
      modulePath: "/x.ts",
      moduleSource: ascii,
      task: "Review.",
      capBytes: 100,  // bigger than length AND bytes → no truncation
    });
    expect(prompt).toContain(ascii);
    expect(prompt).not.toContain("[... truncated");
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

  // Regression for lumeyon's NL4 E4 finding: when dispatch fails AFTER
  // orion's request section was appended (CONVO tail ends with "→ <peer>")
  // but BEFORE the peer's response section was written, the catch block
  // parks the edge (.turn=parked) but leaves the CONVO tail's arrow
  // pointing at the peer. Result: a Monitor or peer reading CONVO.md
  // sees "the floor was just handed to <peer>" while the actual .turn
  // says parked — protocol invariant violated.
  //
  // NL28 fix: on dispatch failure (or any post-orion-request, pre-peer-
  // response failure inside the locked critical section), append an
  // "ephemeral peer review aborted" section with `→ parked` arrow
  // BEFORE the catch's park call. CONVO tail's arrow then matches
  // the .turn=parked end state.
  test("E4: CONVO tail arrow says 'parked' after dispatch failure (matches .turn state)", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    const turnPath = path.join(CONVO_DIR, "petersen", "keystone-orion", "CONVO.md.turn");
    const convoPath = path.join(CONVO_DIR, "petersen", "keystone-orion", "CONVO.md");

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "keystone", "--module", moduleFile, "--no-import"],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        // No mock response → freshEnv's AGENT_CHAT_NO_LLM=1 forces
        // dispatch reason=not-found → CLI throws inside the locked
        // critical section AFTER orion's request was appended.
      }),
      { allowFail: true },
    );

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("dispatch failed");

    // Sanity: .turn matches what the CONVO tail's arrow should say.
    expect(fs.readFileSync(turnPath, "utf8").trim()).toBe("parked");

    // Read CONVO and find the trailing protocol arrow. The arrow line
    // pattern is `^→ <name>$` on its own line.
    const convo = fs.readFileSync(convoPath, "utf8");
    const arrowMatches = convo.match(/^→\s+(\S+)\s*$/gm);
    expect(arrowMatches).not.toBeNull();
    const lastArrow = arrowMatches![arrowMatches!.length - 1];

    // Pre-fix: lastArrow is "→ keystone" (orion's request section's
    // trailing arrow remained because dispatch failed before peer's
    // response section was written). Post-fix: an abort section is
    // appended ending with "→ parked" — the CONVO tail then agrees
    // with .turn=parked.
    expect(lastArrow.trim()).toBe("→ parked");
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

// Regression for lumeyon's NL4 E5 finding: importEdgeIntoLattice
// resolved the lattice importer path via a hard-coded relative path
// (`../../scripts/lattice/import-from-kg.ts` from SKILL_ROOT). This
// works in the dev repo layout but in a packaged plugin layout (npm
// package, published artifact, plugin-only deployment) the relative
// path resolves to a non-existent file; pre-fix `fs.existsSync(path)`
// returned false and importEdgeIntoLattice silently returned null.
// No log of the path that was tried — the import was just MISSING with
// no diagnostic. NL30 fix: (a) AGENT_CHAT_LATTICE_IMPORTER_PATH env
// override, and (b) clear stderr message when the resolved importer
// path doesn't exist.
describe("ephemeral-peer-review CLI — E5 importer-path portability", () => {
  test("E5: stderr logs the missing path when importer is not found", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    // Force the importer-path resolver to use a non-existent file via
    // the new env override. Pre-fix this env var was IGNORED (the code
    // hardcoded the relative path), so the dev-layout heuristic still
    // found the real importer at the repo location and the import
    // silently succeeded — no "missing importer" log was emitted. Pre-
    // fix the test fails because the expected stderr message is absent.
    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile],  // NO --no-import → import path fires
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Reviewed.\n\n→ orion",
        AGENT_CHAT_LATTICE_IMPORTER_PATH: "/definitely/nonexistent/path/to/import-from-kg.ts",
      }),
    );

    // CLI itself should still succeed — lattice import is non-blocking.
    expect(r.exitCode).toBe(0);
    // Stderr should clearly name the path that was tried so an operator
    // can see why import was skipped.
    expect(r.stderr).toContain("lattice importer not found at");
    expect(r.stderr).toContain("/definitely/nonexistent/path/to/import-from-kg.ts");
  });

  test("E5: AGENT_CHAT_LATTICE_IMPORTER_PATH env override is honored when set to a real script", () => {
    const sid = fakeSessionId("orion");
    bootstrapOrionSession(CONVO_DIR, sid);
    const moduleFile = path.join(CONVO_DIR, "x.ts");
    fs.writeFileSync(moduleFile, "x");

    // Build a tiny stub importer that emits the canonical importer
    // output format ephemeral-peer-review parses. If the env override is
    // honored, ephemeral-peer-review's stdout will reflect the stub's
    // distinctive +7 / +13 numbers (different from what the real
    // importer would produce on this test's CONVO).
    const stubImporter = path.join(CONVO_DIR, "stub-importer.ts");
    fs.writeFileSync(
      stubImporter,
      [
        `console.log("# stub importer fired");`,
        `console.log("questions: +7 (already existed: 0)");`,
        `console.log("answers:   +13 (already existed: 0)");`,
        `process.exit(0);`,
      ].join("\n"),
    );

    const r = runScript(
      "ephemeral-peer-review.ts",
      ["--peer", "lumeyon", "--module", moduleFile],
      orionEnv({
        CLAUDE_SESSION_ID: sid,
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Reviewed.\n\n→ orion",
        AGENT_CHAT_LATTICE_IMPORTER_PATH: stubImporter,
      }),
    );

    expect(r.exitCode).toBe(0);
    // Pre-fix: env ignored; the real importer at the dev-layout path
    // runs against this temp CONVO; stdout shows the real (much smaller)
    // import counts (likely 1q/1a from the just-added Q/A pair).
    // Post-fix: stub fires; ephemeral-peer-review parses its output and
    // emits the stub's 7q/13a numbers.
    expect(r.stdout).toContain("lattice: questions_inserted=7 answers_inserted=13");
  });
});
