// Round-15a slice 2 — ephemeral-mode test surface (carina, Phase-3).
//
// Test plan negotiated with orion on the carina-orion edge:
//   - Contract A (synthetic SessionRecord pre-write so dispatched ephemeral
//     children round-trip through `record-turn`) DEFERS to Round-15c.
//   - Lumeyon's slice 1 cmdRun handles AI-to-AI ephemeral via turn.ts
//     primitives directly, bypassing record-turn — so the AI-to-AI round-trip
//     surface is HIS test domain (cmd-run.test.ts), not this file's.
//   - This file pins four invariants that DO live at carina's surface:
//       1. cmdRun graceful-no-op when NO_LLM=1 (lifecycle pin, mirrors
//          lumeyon's pattern + adds the runClaude.reason=not-found assertion).
//       2. record-turn under an ephemeral SessionRecord WITHOUT a pre-written
//          speaker file → exit 64 (Round-15c kickoff regression-pin; flips to
//          a success assertion when Contract A lands).
//       3. record-turn under ephemeral with a non-users.yaml speaker → exit 66
//          (security gate uniform across modes).
//       4. parallel record-turn on two interactive sessions → no contamination
//          (session-key file-isolation invariant; load-bearing regardless of
//          ephemeral mode).
//
// See conversations/petersen/carina-orion/CONVO.md for the full negotiation
// thread (Phase-1 Contract A proposal → Phase-2 pivot → Phase-3 (b)+(d)
// green-light).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mkTmpConversations, rmTmp, runScript, sessionEnv, fakeSessionId,
} from "./helpers.ts";

const TOPO = "petersen";

function writeCurrentSpeaker(dir: string, key: string, name: string): void {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const file = path.join(dir, ".sessions", `${safe}.current_speaker.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    name, set_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }));
  fs.chmodSync(file, 0o600);
}

// Synthetic ephemeral SessionRecord. The `ephemeral: true` flag is forward-
// compat documentation — Round-15c lands the contract that makes it
// load-bearing for cmdGc/monitor disambiguation. Today, cmdRecordTurn does
// not branch on this field, so test #2 + #3 exercise the same code paths
// they would under interactive mode (the regression-pin is in the absence
// of the speaker file, not in the field's presence).
function writeEphemeralSessionRecord(dir: string, key: string, agent: string): void {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const file = path.join(dir, ".sessions", `${safe}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = {
    agent, topology: TOPO, session_key: key,
    host: os.hostname(), pid: process.pid, pid_starttime: 0,
    started_at: new Date().toISOString(), cwd: process.cwd(),
    ephemeral: true,
    parent_session: "test-parent-fixture",
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}

function writeInteractiveSessionRecord(dir: string, key: string, agent: string): void {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const file = path.join(dir, ".sessions", `${safe}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = {
    agent, topology: TOPO, session_key: key,
    host: os.hostname(), pid: process.pid, pid_starttime: 0,
    started_at: new Date().toISOString(), cwd: process.cwd(),
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}

function readConvo(dir: string, edgeId: string): string {
  return fs.readFileSync(path.join(dir, TOPO, edgeId, "CONVO.md"), "utf8");
}
function readTurn(dir: string, edgeId: string): string {
  return fs.readFileSync(path.join(dir, TOPO, edgeId, "CONVO.md.turn"), "utf8").trim();
}
function readLedger(dir: string, edgeId: string): any[] {
  const f = path.join(dir, TOPO, edgeId, "recorded_turns.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("ephemeral mode — Round-15a slice 2 (carina Phase-3, post-pivot)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("1. cmdRun argv/lifecycle: NO_LLM=1 + .turn=self → graceful no-op, runClaude.reason=not-found", () => {
    // Lifecycle pin (mirrors lumeyon's cmd-run.test.ts pattern). Stages an
    // edge with .turn pointing at us so cmdRun's per-edge loop actually
    // reaches runClaude (not the "not our turn; skip" early continue), then
    // observes that the NO_LLM=1 short-circuit fires with the EXACT reason
    // string lumeyon's slice produces. Orion's Phase-2 refinement: pin to the
    // specific failure shape so a future refactor (e.g., reason="stub-disabled")
    // surfaces here instead of silently passing on a different "skip".
    const key = fakeSessionId("orion-run");
    writeInteractiveSessionRecord(tmp, key, "orion");
    // Stage carina-orion with .turn=orion so cmdRun (running as orion) hits
    // the runClaude path. Edge-id is alphabetical: carina-orion.
    const edgeDir = path.join(tmp, TOPO, "carina-orion");
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.writeFileSync(path.join(edgeDir, "CONVO.md"), "# CONVO\n");
    fs.writeFileSync(path.join(edgeDir, "CONVO.md.turn"), "orion\n");

    const env = sessionEnv(tmp, "orion", TOPO, key);
    const r = runScript("agent-chat.ts", ["run", "--once", "carina"], env);
    expect(r.exitCode).toBe(0);
    // The specific failure shape: runClaude returned reason="not-found"
    // (because AGENT_CHAT_NO_LLM=1, set globally by freshEnv). Cmdrun logs
    // `runClaude not-found on <edge-id>` before unlocking and continuing.
    expect(r.stderr).toMatch(/runClaude not-found on carina-orion/);
    // No edge mutation occurred: CONVO.md still has only the staged header,
    // .turn is still orion's (not flipped to carina), no lock leaked.
    const convo = fs.readFileSync(path.join(edgeDir, "CONVO.md"), "utf8");
    expect(convo).toBe("# CONVO\n");
    expect(fs.readFileSync(path.join(edgeDir, "CONVO.md.turn"), "utf8").trim()).toBe("orion");
    expect(fs.existsSync(path.join(edgeDir, "CONVO.md.turn.lock"))).toBe(false);
  });

  test("2. record-turn under ephemeral fixture WITHOUT pre-written speaker → exit 64 (Round-15c kickoff pin)", () => {
    // Round-15c kickoff regression-pin. The exit-64 fires at
    // agent-chat.ts:1238-1239 inside cmdRecordTurn:
    //   1238: const speaker = await fetchSpeaker(id.name, key);
    //   1239: if (!speaker) die("no current speaker; ...", 64);
    // When Contract A lands in Round-15c, the parent dispatcher's cmdRun
    // is required to pre-write `<key>.current_speaker.json` before
    // spawning the ephemeral child. If a future implementation forgets
    // that pre-write step, the dispatched child's record-turn dies with
    // exit 64 right here. THIS TEST PINS THE FAILURE MODE permanently —
    // Round-15c will add a SEPARATE success-path test (cmdRun pre-writes
    // the speaker, then the dispatched record-turn succeeds) rather than
    // flipping this test's assertion, because this test's fixture
    // intentionally skips the writeCurrentSpeaker step to lock the bare
    // failure mode.
    //
    // Symmetric counterpart: tests/append-turn.test.ts test #211 covers
    // the same exit-64 case under a non-ephemeral SessionRecord. Both
    // must hold for the transparency invariant to carry through dispatch.
    const key = fakeSessionId("eph-no-speaker");
    writeEphemeralSessionRecord(tmp, key, "keystone");
    // Intentionally NO writeCurrentSpeaker — that's the bug we're pinning.
    const env = sessionEnv(tmp, "keystone", TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/no current speaker/);
    // No edge dir created — record-turn must fail before any filesystem
    // mutation (idempotency invariant carries to ephemeral).
    expect(fs.existsSync(path.join(tmp, TOPO))).toBe(false);
  });

  test("3. record-turn under ephemeral with non-users.yaml speaker → exit 66 (security gate uniform across modes)", () => {
    // Proves the AI-to-AI-misroute defense is the same code path regardless
    // of the SessionRecord's `ephemeral` flag: a forged "speaker = orion"
    // (orion is in petersen.yaml but NOT in users.yaml) is refused at the
    // same `users.includes(speaker)` check that interactive sessions hit.
    // Same threat model, same defense, same exit code. Round-15c's Contract
    // A landing must NOT regress this — the speaker-membership check is
    // load-bearing for the human-only-speakers invariant.
    const key = fakeSessionId("eph-bad-speaker");
    writeEphemeralSessionRecord(tmp, key, "keystone");
    writeCurrentSpeaker(tmp, key, "orion");  // AI, not in users.yaml
    const env = sessionEnv(tmp, "keystone", TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(66);
    expect(r.stderr).toMatch(/human→AI only|refuse/i);
    expect(r.stderr).toContain("orion");
  });

  test("4. parallel record-turn on two interactive sessions → no cross-contamination (session-key isolation)", () => {
    // Stress-tests the file-keyed-by-session-key isolation: two simultaneous
    // record-turn invocations on independent sessions write to disjoint
    // edges. The invariant is load-bearing for any multi-session deployment
    // — interactive mode exercises it via the same primitive that ephemeral
    // mode would, so we pin it here regardless of Contract A's status.
    const k1 = fakeSessionId("ks-par");
    const k2 = fakeSessionId("rh-par");
    writeInteractiveSessionRecord(tmp, k1, "keystone");
    writeInteractiveSessionRecord(tmp, k2, "rhino");
    writeCurrentSpeaker(tmp, k1, "boss");
    writeCurrentSpeaker(tmp, k2, "boss");
    const env1 = sessionEnv(tmp, "keystone", TOPO, k1);
    const env2 = sessionEnv(tmp, "rhino", TOPO, k2);

    const r1 = runScript("agent-chat.ts", [
      "record-turn", "--user", "to keystone", "--assistant", "ks reply",
    ], env1);
    const r2 = runScript("agent-chat.ts", [
      "record-turn", "--user", "to rhino", "--assistant", "rh reply",
    ], env2);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const ks = readConvo(tmp, "boss-keystone");
    const rh = readConvo(tmp, "boss-rhino");
    expect(ks).toContain("to keystone");
    expect(ks).not.toContain("to rhino");
    expect(rh).toContain("to rhino");
    expect(rh).not.toContain("to keystone");
    // Neither edge sees a handoff section — both are first-turn fresh on
    // distinct session keys, so the speaker-switch path was never invoked.
    expect(ks).not.toMatch(/handoff to/);
    expect(rh).not.toMatch(/handoff to/);
    // Ledgers are independent.
    expect(readLedger(tmp, "boss-keystone").length).toBe(1);
    expect(readLedger(tmp, "boss-rhino").length).toBe(1);
    // .turn lands on the speaker (boss) on both edges, independently flipped.
    expect(readTurn(tmp, "boss-keystone")).toBe("boss");
    expect(readTurn(tmp, "boss-rhino")).toBe("boss");
  });

  // Round-15c — Contract A: prepareEphemeralIdentity helper test.
  //
  // The complement to Test #2's regression-pin: when the dispatcher
  // pre-writes synthetic state via prepareEphemeralIdentity(), the
  // dispatched ephemeral child's record-turn DOES succeed. This test
  // exercises the helper directly (no cmdRun shell-out) so we pin the
  // primitive behavior without depending on the cmdRun --speaker
  // integration end-to-end.
  test("5. prepareEphemeralIdentity round-trip — record-turn under synthetic fixture succeeds (Contract A)", async () => {
    const { prepareEphemeralIdentity } = await import("../scripts/lib.ts");
    const parentKey = fakeSessionId("orion-parent");
    writeInteractiveSessionRecord(tmp, parentKey, "orion");
    const parentRec = JSON.parse(fs.readFileSync(
      path.join(tmp, ".sessions", `${parentKey.replace(/[^A-Za-z0-9_:.-]/g, "_")}.json`), "utf8",
    ));

    // Pre-condition: we set AGENT_CHAT_CONVERSATIONS_DIR so the helper
    // writes into our tmp dir. The helper resolves CONVERSATIONS_DIR at
    // module-load time, so we re-import a fresh copy for this test.
    const prevDir = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      // Fresh import to pick up the env-overridden CONVERSATIONS_DIR.
      const lib = await import(`../scripts/lib.ts?t=${Date.now()}`);
      const { sessionKey, cleanup } = lib.prepareEphemeralIdentity({
        agent: "keystone",
        speaker: "boss",
        parent: parentRec,
      });

      // The synthetic SessionRecord exists with ephemeral: true.
      const sessFile = path.join(tmp, ".sessions", `${sessionKey.replace(/[^A-Za-z0-9_:.-]/g, "_")}.json`);
      expect(fs.existsSync(sessFile)).toBe(true);
      const synth = JSON.parse(fs.readFileSync(sessFile, "utf8"));
      expect(synth.ephemeral).toBe(true);
      expect(synth.agent).toBe("keystone");

      // The synthetic current_speaker file points at boss.
      const speakerFile = path.join(tmp, ".sessions", `${sessionKey.replace(/[^A-Za-z0-9_:.-]/g, "_")}.current_speaker.json`);
      expect(fs.existsSync(speakerFile)).toBe(true);
      const speaker = JSON.parse(fs.readFileSync(speakerFile, "utf8"));
      expect(speaker.name).toBe("boss");

      // Now invoke record-turn against this synthetic state — the SUCCESS
      // path that Test #2's regression-pin is the inverse of.
      const env = sessionEnv(tmp, "keystone", TOPO, sessionKey);
      const r = runScript("agent-chat.ts", [
        "record-turn", "--user", "test prompt", "--assistant", "test reply",
      ], env, { allowFail: true });
      expect(r.exitCode).toBe(0);
      // Edge dir created on the boss-keystone edge (alphabetical).
      expect(fs.existsSync(path.join(tmp, TOPO, "boss-keystone", "CONVO.md"))).toBe(true);

      // Cleanup unlinks both files.
      cleanup();
      expect(fs.existsSync(sessFile)).toBe(false);
      expect(fs.existsSync(speakerFile)).toBe(false);
    } finally {
      if (prevDir == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevDir;
    }
  });
});
