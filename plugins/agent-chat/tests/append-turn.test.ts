// End-to-end tests for `agent-chat record-turn` (slice 3 — keystone).
//
// These are LOAD-BEARING tests: each one invokes the real CLI against a real
// CONVO.md + .turn + lock file in a tmpdir. The vanguard-designed test set
// + 3 negative cases.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  mkTmpConversations, rmTmp, freshEnv, runScript, sessionEnv, fakeSessionId,
} from "./helpers.ts";

// Switched from "org" to "petersen" after the overlay refactor: lumeyon's
// load-time validation rejects topology+users.yaml name collisions, and
// agents.org.yaml still bakes in boss/john from yesterday's commit. Using
// petersen makes the load-bearing assertion stronger anyway — `boss-orion`
// exists ONLY because of the users.yaml overlay, not because petersen.yaml
// declares it. (orion's spec for the auto-resolve load-bearing test.)
const TOPO = "petersen";
const AGENT = "keystone";

function writeCurrentSpeaker(dir: string, key: string, name: string | null): void {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const file = path.join(dir, ".sessions", `${safe}.current_speaker.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (name === null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  // Match carina's CurrentSpeaker schema (name + set_at). The reader
  // (lib.ts:readCurrentSpeaker) rejects records missing either field.
  fs.writeFileSync(file, JSON.stringify({ name, set_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }));
  fs.chmodSync(file, 0o600);
}

function writeSessionRecord(dir: string, key: string, agent: string, topology: string, extra: any = {}): void {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const file = path.join(dir, ".sessions", `${safe}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = {
    agent, topology, session_key: key,
    host: require("node:os").hostname(),
    pid: process.pid, pid_starttime: 0,
    started_at: new Date().toISOString(),
    cwd: process.cwd(),
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}

function readConvo(dir: string, edgeId: string): string {
  return fs.readFileSync(path.join(dir, TOPO, edgeId, "CONVO.md"), "utf8");
}

function readTurn(dir: string, edgeId: string): string {
  return fs.readFileSync(path.join(dir, TOPO, edgeId, "CONVO.md.turn"), "utf8").trim();
}

function lockExists(dir: string, edgeId: string): boolean {
  return fs.existsSync(path.join(dir, TOPO, edgeId, "CONVO.md.turn.lock"));
}

function readLedger(dir: string, edgeId: string): any[] {
  const f = path.join(dir, TOPO, edgeId, "recorded_turns.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("record-turn — load-bearing", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("1. fresh-edge round-trip: creates files, writes both sections, ledger entry", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "hello orion", "--assistant", "hi boss",
    ], env);
    expect(r.exitCode).toBe(0);

    const convo = readConvo(tmp, "boss-keystone");
    expect(convo).toMatch(/## boss — user turn \(UTC \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/);
    expect(convo).toMatch(/## keystone — assistant response \(UTC /);
    expect(convo).toContain("hello orion");
    expect(convo).toContain("hi boss");

    expect(readTurn(tmp, "boss-keystone")).toBe("boss");
    expect(lockExists(tmp, "boss-keystone")).toBe(false);

    const ledger = readLedger(tmp, "boss-keystone");
    expect(ledger.length).toBe(1);
    expect(ledger[0].speaker).toBe("boss");
    expect(ledger[0].agent).toBe("keystone");
    expect(ledger[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("2. idempotent retry: same payload twice → one section pair, one ledger entry", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["record-turn", "--user", "u1", "--assistant", "a1"], env);
    const r2 = runScript("agent-chat.ts", ["record-turn", "--user", "u1", "--assistant", "a1"], env);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/idempotent skip/);

    const convo = readConvo(tmp, "boss-keystone");
    const userTurnCount = (convo.match(/## boss — user turn/g) ?? []).length;
    expect(userTurnCount).toBe(1);
    const ledger = readLedger(tmp, "boss-keystone");
    expect(ledger.length).toBe(1);
  });

  test("3. speaker-switch handoff: old edge gets handoff section + parked, new edge gets pair", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    // First turn: boss
    writeCurrentSpeaker(tmp, key, "boss");
    runScript("agent-chat.ts", ["record-turn", "--user", "from boss", "--assistant", "to boss"], env);

    // Switch speaker to john
    writeCurrentSpeaker(tmp, key, "john");
    runScript("agent-chat.ts", ["record-turn", "--user", "from john", "--assistant", "to john"], env);

    // OLD edge has handoff section + .turn=parked
    const oldConvo = readConvo(tmp, "boss-keystone");
    expect(oldConvo).toMatch(/## boss — handoff to john \(UTC /);
    expect(oldConvo).toContain("Heading out; john is taking over");
    // The handoff section ends with "→ parked" (verify the LAST occurrence is the handoff arrow)
    const handoffIdx = oldConvo.lastIndexOf("## boss — handoff to john");
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(oldConvo.slice(handoffIdx)).toMatch(/→ parked/);
    expect(readTurn(tmp, "boss-keystone")).toBe("parked");

    // NEW edge has the john user+assistant pair
    const newConvo = readConvo(tmp, "john-keystone");
    expect(newConvo).toMatch(/## john — user turn/);
    expect(newConvo).toMatch(/## keystone — assistant response/);
    expect(newConvo).toContain("from john");
    expect(readTurn(tmp, "john-keystone")).toBe("john");
  });

  test("4. independent edges: same speaker recorded by two AI agents → no cross-contamination", () => {
    // We simulate "two AI agents recording for the same speaker" by running
    // the CLI twice with different AGENT identities on independent session keys.
    const key1 = fakeSessionId("ks");
    const key2 = fakeSessionId("rh");
    writeSessionRecord(tmp, key1, "keystone", TOPO);
    writeSessionRecord(tmp, key2, "rhino", TOPO);
    writeCurrentSpeaker(tmp, key1, "boss");
    writeCurrentSpeaker(tmp, key2, "boss");
    const env1 = sessionEnv(tmp, "keystone", TOPO, key1);
    const env2 = sessionEnv(tmp, "rhino", TOPO, key2);

    runScript("agent-chat.ts", ["record-turn", "--user", "hi keystone", "--assistant", "hi back"], env1);
    runScript("agent-chat.ts", ["record-turn", "--user", "hi rhino", "--assistant", "hi back too"], env2);

    const ksConvo = readConvo(tmp, "boss-keystone");
    const rhConvo = readConvo(tmp, "boss-rhino");
    expect(ksConvo).toContain("hi keystone");
    expect(ksConvo).not.toContain("hi rhino");
    expect(rhConvo).toContain("hi rhino");
    expect(rhConvo).not.toContain("hi keystone");
    // Neither edge has a handoff section (NOT a speaker switch).
    expect(ksConvo).not.toMatch(/handoff to/);
    expect(rhConvo).not.toMatch(/handoff to/);
  });

  test("5. parser cursor logic finds the right last-self-section", () => {
    // This validates that the sections are emitted with correct headers
    // (lowercase, second-precision UTC stamp, real author name) — the same
    // shape the round-3 parser bug fixed. We just need to assert that
    // `parseSections` + `sectionMeta` from lib.ts
    // see the right author for both sections.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["record-turn", "--user", "u", "--assistant", "a"], env);
    const convo = readConvo(tmp, "boss-keystone");

    // Force a re-import of lib.ts under the test env so it picks up the
    // tmpdir's CONVERSATIONS_DIR.
    const { parseSections, sectionMeta } = require("../scripts/lib.ts");
    const { sections } = parseSections(convo);
    // sections is a string[]; sectionMeta extracts {author, ts} from the
    // raw section text. The ensureEdgeFiles preamble is not a section.
    const meta = sections.map((s: string) => sectionMeta(s));
    expect(meta.length).toBeGreaterThanOrEqual(2);
    const last2 = meta.slice(-2);
    expect(last2[0].author).toBe("boss");
    expect(last2[1].author).toBe("keystone");
    expect(last2[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("record-turn — negative cases (vanguard's design)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("64: missing current_speaker → exit 64, message, nothing written", () => {
    // Round-15a Phase-1 break-point pin (interactive mode). The ephemeral
    // counterpart with `ephemeral: true` SessionRecord lives in
    // tests/ephemeral.test.ts test #2 — pinning the SAME exit-64 invariant
    // under ephemeral fixtures. Both tests stay green forever: Round-15c's
    // Contract A adds cmdRun's pre-write of the synthetic SessionRecord +
    // speaker file, but does NOT change record-turn's reject-on-missing-
    // speaker behavior at agent-chat.ts:1238-1239. The fixture in test #2
    // would have to change (invoke cmdRun rather than directly invoking
    // record-turn with manually-skipped speaker file) for the exit-64
    // assertion to flip — and that's what Round-15c's success-path test
    // would do as a separate test. The exit-64 invariant pinned here and
    // in ephemeral.test.ts #2 stays load-bearing across rounds.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    // intentionally no writeCurrentSpeaker
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/no current speaker/);
    // No CONVO files anywhere (no edge mkdir'd).
    expect(fs.existsSync(path.join(tmp, TOPO))).toBe(false);
  });

  test("65: unknown speaker name → exit 65, message lists valid agents", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "alice");  // not in topology
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toMatch(/speaker 'alice' is not a member/);
    expect(r.stderr).toMatch(/boss/);
    expect(r.stderr).toMatch(/john/);
  });

  test("66: human-to-human refused (catches asymmetric refactor — agent-side check must also fire)", () => {
    // Speaker=boss (human ✓), agent=AI session role overridden to john (human).
    // The membership check is `users.includes(speaker) && !users.includes(agent)`
    // — both conditions must hold. If a future refactor drops the !users.includes(agent)
    // half, this test catches the regression.
    const key = fakeSessionId("hh");
    writeSessionRecord(tmp, key, "john", TOPO);  // john is in users.yaml = human
    writeCurrentSpeaker(tmp, key, "boss");       // also human
    const env = sessionEnv(tmp, "john", TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "hi", "--assistant", "back",
    ], env, { allowFail: true });
    // Either exit 66 (caught by membership check) OR an earlier topology
    // failure if `john` somehow isn't a valid id.name in petersen+overlay
    // (the merge adds users to topo.agents, so this should resolve fine).
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/human|refuse|user/i);
  });

  test("66: AI-to-AI misroute (orion is not in users.yaml) → exit 66", () => {
    // Speaker is another AI (orion). orion is in petersen.yaml's agents
    // list but NOT in agents.users.yaml — so the membership check
    // `users.includes(speaker)` returns false and the request is refused.
    // This replaces the b11db98 degree heuristic with the schema-driven
    // membership check (orion's Phase-2 resolution).
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "orion");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(66);
    expect(r.stderr).toMatch(/human→AI only|refuse/i);
    expect(r.stderr).toContain("orion");
  });
});

// -----------------------------------------------------------------------
// Auto-resolve overlay tests (Phase-3 refactor — orthogonal users.yaml).
//
// These exercise the full chain: agents.users.yaml → loadTopology merges
// users into topo.agents → record-turn lands on an edge that exists ONLY
// because of the overlay (not because petersen.yaml declares it). The
// load-bearing assertion is that `boss-keystone/CONVO.md` is a real file
// after the test, despite boss being absent from petersen.yaml.
//
// Note these tests rely on carina's slice 2 having shipped the auto-write
// of current_speaker.json on init. If carina's slice hasn't landed yet,
// these tests can be replicated by writing current_speaker.json directly
// (which is what we do here for hermeticity — not depending on init's
// auto-write means slice 3 tests are independent of slice 2 timing).
// -----------------------------------------------------------------------

describe("record-turn — overlay auto-resolve flow (vanguard's Phase-1 design)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("boss (in users.yaml, not in petersen.yaml) records on petersen+overlay edge", () => {
    // The load-bearing test: boss-keystone exists ONLY because users.yaml
    // overlays boss onto petersen at loadTopology time.
    const key = fakeSessionId("ovr1");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "from boss overlay", "--assistant", "hi boss",
    ], env);
    expect(r.exitCode).toBe(0);

    // Edge dir lives under petersen/, NOT under any users-only namespace.
    const convoPath = path.join(tmp, "petersen", "boss-keystone", "CONVO.md");
    expect(fs.existsSync(convoPath)).toBe(true);
    const convo = fs.readFileSync(convoPath, "utf8");
    expect(convo).toMatch(/## boss — user turn/);
    expect(convo).toMatch(/## keystone — assistant response/);
    expect(convo).toContain("from boss overlay");
  });

  test("john (also in users.yaml) records on a different overlay edge cleanly", () => {
    // Second user, different edge id. Confirms multi-user overlay isn't
    // collapsing distinct users to the same edge.
    const key = fakeSessionId("ovr2");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "john");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "from john", "--assistant", "hi john",
    ], env);
    expect(r.exitCode).toBe(0);
    const convoPath = path.join(tmp, "petersen", "john-keystone", "CONVO.md");
    expect(fs.existsSync(convoPath)).toBe(true);
    expect(fs.readFileSync(convoPath, "utf8")).toContain("from john");
    // boss-keystone NOT created in this test.
    expect(fs.existsSync(path.join(tmp, "petersen", "boss-keystone", "CONVO.md"))).toBe(false);
  });

  test("explicit speaker override wins over a previously-set default", () => {
    // Backward-compat: yesterday's slice-2 explicit `agent-chat speaker`
    // path must keep working. We simulate two writes (default → explicit
    // override) by writing current_speaker.json twice.
    const key = fakeSessionId("expl");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");  // initial (would be auto-resolved default)
    writeCurrentSpeaker(tmp, key, "john");  // explicit override
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmp, "petersen", "john-keystone", "CONVO.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "petersen", "boss-keystone", "CONVO.md"))).toBe(false);
  });

  test("backward-compat: speaker switch from auto-resolved default produces handoff section", () => {
    // Yesterday's slice-3 handoff test, but starting from an auto-resolved
    // default speaker rather than an explicit `agent-chat speaker boss`.
    const key = fakeSessionId("hand");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "boss");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["record-turn", "--user", "u1", "--assistant", "a1"], env);
    writeCurrentSpeaker(tmp, key, "john");  // speaker switch
    runScript("agent-chat.ts", ["record-turn", "--user", "u2", "--assistant", "a2"], env);

    // OLD edge gets handoff section.
    const oldConvo = fs.readFileSync(path.join(tmp, "petersen", "boss-keystone", "CONVO.md"), "utf8");
    expect(oldConvo).toMatch(/## boss — handoff to john/);
    expect(fs.readFileSync(path.join(tmp, "petersen", "boss-keystone", "CONVO.md.turn"), "utf8").trim()).toBe("parked");

    // NEW edge gets the new pair.
    const newConvo = fs.readFileSync(path.join(tmp, "petersen", "john-keystone", "CONVO.md"), "utf8");
    expect(newConvo).toMatch(/## john — user turn/);
    expect(newConvo).toContain("u2");
  });
});
