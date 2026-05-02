// End-to-end tests for `agent-chat record-turn` (slice 3 — keystone).
//
// These are LOAD-BEARING tests: each one invokes the real CLI against a real
// CONVO.md + .turn + lock file in a tmpdir, with sidecar absent (file-direct
// fallback). The vanguard-designed test set + 3 negative cases.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  mkTmpConversations, rmTmp, freshEnv, runScript, sessionEnv, fakeSessionId,
} from "./helpers.ts";

const TOPO = "org";
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
  return fs.readFileSync(path.join(dir, "org", edgeId, "CONVO.md"), "utf8");
}

function readTurn(dir: string, edgeId: string): string {
  return fs.readFileSync(path.join(dir, "org", edgeId, "CONVO.md.turn"), "utf8").trim();
}

function lockExists(dir: string, edgeId: string): boolean {
  return fs.existsSync(path.join(dir, "org", edgeId, "CONVO.md.turn.lock"));
}

function readLedger(dir: string, edgeId: string): any[] {
  const f = path.join(dir, "org", edgeId, "recorded_turns.jsonl");
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
    writeCurrentSpeaker(tmp, key, "eyon");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "hello orion", "--assistant", "hi eyon",
    ], env);
    expect(r.exitCode).toBe(0);

    const convo = readConvo(tmp, "eyon-keystone");
    expect(convo).toMatch(/## eyon — user turn \(UTC \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/);
    expect(convo).toMatch(/## keystone — assistant response \(UTC /);
    expect(convo).toContain("hello orion");
    expect(convo).toContain("hi eyon");

    expect(readTurn(tmp, "eyon-keystone")).toBe("eyon");
    expect(lockExists(tmp, "eyon-keystone")).toBe(false);

    const ledger = readLedger(tmp, "eyon-keystone");
    expect(ledger.length).toBe(1);
    expect(ledger[0].speaker).toBe("eyon");
    expect(ledger[0].agent).toBe("keystone");
    expect(ledger[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("2. idempotent retry: same payload twice → one section pair, one ledger entry", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "eyon");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["record-turn", "--user", "u1", "--assistant", "a1"], env);
    const r2 = runScript("agent-chat.ts", ["record-turn", "--user", "u1", "--assistant", "a1"], env);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/idempotent skip/);

    const convo = readConvo(tmp, "eyon-keystone");
    const userTurnCount = (convo.match(/## eyon — user turn/g) ?? []).length;
    expect(userTurnCount).toBe(1);
    const ledger = readLedger(tmp, "eyon-keystone");
    expect(ledger.length).toBe(1);
  });

  test("3. speaker-switch handoff: old edge gets handoff section + parked, new edge gets pair", () => {
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    // First turn: eyon
    writeCurrentSpeaker(tmp, key, "eyon");
    runScript("agent-chat.ts", ["record-turn", "--user", "from eyon", "--assistant", "to eyon"], env);

    // Switch speaker to john
    writeCurrentSpeaker(tmp, key, "john");
    runScript("agent-chat.ts", ["record-turn", "--user", "from john", "--assistant", "to john"], env);

    // OLD edge has handoff section + .turn=parked
    const oldConvo = readConvo(tmp, "eyon-keystone");
    expect(oldConvo).toMatch(/## eyon — handoff to john \(UTC /);
    expect(oldConvo).toContain("Heading out; john is taking over");
    // The handoff section ends with "→ parked" (verify the LAST occurrence is the handoff arrow)
    const handoffIdx = oldConvo.lastIndexOf("## eyon — handoff to john");
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(oldConvo.slice(handoffIdx)).toMatch(/→ parked/);
    expect(readTurn(tmp, "eyon-keystone")).toBe("parked");

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
    writeCurrentSpeaker(tmp, key1, "eyon");
    writeCurrentSpeaker(tmp, key2, "eyon");
    const env1 = sessionEnv(tmp, "keystone", TOPO, key1);
    const env2 = sessionEnv(tmp, "rhino", TOPO, key2);

    runScript("agent-chat.ts", ["record-turn", "--user", "hi keystone", "--assistant", "hi back"], env1);
    runScript("agent-chat.ts", ["record-turn", "--user", "hi rhino", "--assistant", "hi back too"], env2);

    const ksConvo = readConvo(tmp, "eyon-keystone");
    const rhConvo = readConvo(tmp, "eyon-rhino");
    expect(ksConvo).toContain("hi keystone");
    expect(ksConvo).not.toContain("hi rhino");
    expect(rhConvo).toContain("hi rhino");
    expect(rhConvo).not.toContain("hi keystone");
    // Neither edge has a handoff section (NOT a speaker switch).
    expect(ksConvo).not.toMatch(/handoff to/);
    expect(rhConvo).not.toMatch(/handoff to/);
  });

  test("5. sidecar-equivalent re-parse: the parser cursor logic finds the right last-self-section", () => {
    // This validates that the sections are emitted with correct headers
    // (lowercase, second-precision UTC stamp, real author name) — the same
    // shape the round-3 parser bug fixed. We don't need a live sidecar; we
    // just need to assert that `parseSections` + `sectionMeta` from lib.ts
    // see the right author for both sections.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "eyon");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    runScript("agent-chat.ts", ["record-turn", "--user", "u", "--assistant", "a"], env);
    const convo = readConvo(tmp, "eyon-keystone");

    // Force a re-import of lib.ts under the test env so it picks up the
    // tmpdir's CONVERSATIONS_DIR.
    const { parseSections, sectionMeta } = require("../scripts/lib.ts");
    const { sections } = parseSections(convo);
    // sections is a string[]; sectionMeta extracts {author, ts} from the
    // raw section text. The ensureEdgeFiles preamble is not a section.
    const meta = sections.map((s: string) => sectionMeta(s));
    expect(meta.length).toBeGreaterThanOrEqual(2);
    const last2 = meta.slice(-2);
    expect(last2[0].author).toBe("eyon");
    expect(last2[1].author).toBe("keystone");
    expect(last2[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("record-turn — negative cases (vanguard's design)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpConversations(); });
  afterEach(() => { rmTmp(tmp); });

  test("64: missing current_speaker → exit 64, message, nothing written", () => {
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
    expect(fs.existsSync(path.join(tmp, "org"))).toBe(false);
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
    expect(r.stderr).toMatch(/eyon/);
    expect(r.stderr).toMatch(/john/);
  });

  test("66: AI-to-AI misroute (speaker has no human-shape) → exit 66", () => {
    // Speaker is another AI (orion). In agents.org.yaml's degree distribution:
    // orion has degree 5 (3 AI peers + 2 humans = 5), keystone has degree 5 too.
    // So orion's degree (5) is NOT > keystone's degree (5) — refused.
    const key = fakeSessionId("ks");
    writeSessionRecord(tmp, key, AGENT, TOPO);
    writeCurrentSpeaker(tmp, key, "orion");
    const env = sessionEnv(tmp, AGENT, TOPO, key);

    const r = runScript("agent-chat.ts", [
      "record-turn", "--user", "u", "--assistant", "a",
    ], env, { allowFail: true });
    expect(r.exitCode).toBe(66);
    expect(r.stderr).toMatch(/refuse|no edge|human/i);
  });
});
