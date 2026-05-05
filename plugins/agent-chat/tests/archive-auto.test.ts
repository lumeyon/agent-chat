// archive-auto.test.ts — load-bearing end-to-end test for the long-term-memory
// pipeline: synthetic long CONVO.md → `archive.ts auto` (seal + auto-summary
// + commit in one shot) → `search.ts grep` finds the archived edge by
// extracted keywords → `search.ts expand` returns the verbatim BODY.md.
//
// Why this test exists:
//   - The archive layer (lossless-claw-inspired DAG of summaries with fresh-tail
//     protection) is the substrate for long-term memory across both AI-AI and
//     human-AI conversations. Without auto-archive, sealing required manual
//     intervention and the searchable index never compounded.
//   - `archive.ts auto` lands the seal+commit chain in one non-interactive
//     CLI call, with a deterministic synthesizer that produces validator-
//     passing SUMMARY.md content from section metadata.
//   - This test exercises the full chain mechanically (no LLM in the loop)
//     so it can run in CI on every commit, validating that the pipeline
//     stays end-to-end correct as the codebase evolves.
//
// Re-runnable: every test gets its own tmpdir via mkTmpConversations() and
// is cleaned via afterEach's rmTmp. No state leaks between runs.
//
// Companion gated test (RUN_LLM_TESTS=1) lives at tests/archive-auto-llm.test.ts:
// spawns `claude -p` against an archived edge and verifies the LLM can
// answer recall questions via search.ts grep. That test costs API budget,
// is non-deterministic, and is excluded from the default CI sweep — its
// purpose is "does Claude actually find the archived facts when asked?"
// after this test confirms "is the pipeline mechanically correct?"

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mkTmpConversations, rmTmp, runScript, sessionEnv,
} from "./helpers.ts";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;
let SESSION_KEY: string;
let EDGE_DIR: string;

const PEER = "lumeyon";
const EDGE_ID = "lumeyon-orion";   // alphabetical canonicalization

// Distinctive deterministic facts the test will search for. The synthesizer
// extracts top-12 frequency-counted alphanumeric tokens (length ≥4) from
// section bodies and emits them as `## Keywords`. Including specific
// identifiers ("kafkamigration", "stagingdeploy", "rollback") at high
// frequency guarantees they surface in keywords AND in the verbatim BODY.md.
const FACT_TOKENS = [
  "kafkamigration", "stagingdeploy", "rollbackplan",
  "alertbudget", "queuedrain", "shardrebalance",
];
const FACT_PATHS = [
  "scripts/migrate.ts",
  "config/deploy.yaml",
  "dashboards/sla.json",
];

// Build a synthetic long CONVO.md: sectionCount sections, each containing
// every FACT_TOKEN multiple times so the keyword extractor surely picks
// them up, plus one FACT_PATH per section for the artifacts extractor.
function buildSyntheticConvo(sectionCount: number): string {
  const header = `# CONVO — lumeyon ↔ orion\n\nProtocol: agent-chat\nParticipants: lumeyon, orion\n`;
  const sections: string[] = [];
  for (let i = 1; i <= sectionCount; i++) {
    const author = i % 2 === 0 ? "orion" : "lumeyon";
    const next = author === "orion" ? "lumeyon" : "orion";
    const ts = `2026-05-03T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`;
    const tokens = FACT_TOKENS.join(" ");
    const pathRef = FACT_PATHS[i % FACT_PATHS.length];
    sections.push(
      `## ${author} — section ${i} (UTC ${ts})\n\n` +
      `Discussion of ${tokens}. References ${pathRef}. ` +
      `Token reinforcement: ${tokens} ${tokens}\n\n` +
      `→ ${next}`,
    );
  }
  return header + "\n---\n\n" + sections.join("\n\n---\n\n") + "\n";
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  SESSION_KEY = ORION_ENV.CLAUDE_SESSION_ID!;
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".logs"), { recursive: true });
  // Pre-stage the session record so resolveIdentity hits the file path
  // (matches sidecar/speaker/append-turn test fixtures exactly).
  fs.writeFileSync(
    path.join(CONVO_DIR, ".sessions", `${SESSION_KEY}.json`),
    JSON.stringify({
      agent: "orion", topology: "petersen", session_key: SESSION_KEY,
      claude_session_id: SESSION_KEY, host: os.hostname(), pid: process.pid,
      started_at: "2026-05-03T00:00:00Z", cwd: CONVO_DIR,
    }),
  );
  EDGE_DIR = path.join(CONVO_DIR, "petersen", EDGE_ID);
  fs.mkdirSync(EDGE_DIR, { recursive: true });
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("archive auto — long-term-memory pipeline (mechanical)", () => {

  test("auto-archives a 50-section synthetic CONVO.md (parked) into a sealed leaf", () => {
    // Plant the synthetic conversation + parked .turn.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    // Run auto-archive.
    const r = runScript("archive.ts", ["auto", PEER], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/auto-archived arch_L_/);
    // Pull the archive id out of the stdout for downstream checks.
    const archIdMatch = r.stdout.match(/auto-archived (arch_L_\S+)/);
    expect(archIdMatch).not.toBeNull();
    const archId = archIdMatch![1];

    // Archive directory exists with all three sealed artifacts.
    const aDir = path.join(EDGE_DIR, "archives", "leaf", archId);
    expect(fs.existsSync(path.join(aDir, "BODY.md"))).toBe(true);
    expect(fs.existsSync(path.join(aDir, "SUMMARY.md"))).toBe(true);
    expect(fs.existsSync(path.join(aDir, "META.yaml"))).toBe(true);

    // META is sealed (not pending-commit) because auto skips the dance.
    const meta = fs.readFileSync(path.join(aDir, "META.yaml"), "utf8");
    expect(meta).toMatch(/status:\s*"?sealed"?/);
    expect(meta).toMatch(/synthesis:\s*"?auto"?/);

    // SUMMARY.md contains the FACT_TOKENS as keywords (high-frequency
    // surface guaranteed by buildSyntheticConvo).
    const summary = fs.readFileSync(path.join(aDir, "SUMMARY.md"), "utf8");
    for (const token of FACT_TOKENS) {
      expect(summary.toLowerCase()).toContain(token);
    }
    // SUMMARY.md contains the FACT_PATHS as artifacts.
    for (const p of FACT_PATHS) {
      expect(summary).toContain(p);
    }

    // BODY.md is the verbatim archived sections (everything but the fresh tail).
    const body = fs.readFileSync(path.join(aDir, "BODY.md"), "utf8");
    expect(body).toContain("kafkamigration");
    // Fresh tail (last 4 sections) preserved in CONVO.md.
    const newConvo = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md"), "utf8");
    expect(newConvo).toContain("archive breadcrumb:");
    expect(newConvo).toContain(archId);
    // Section 50 (the latest) MUST be in the fresh tail of CONVO.md, not in BODY.md.
    expect(newConvo).toContain("section 50");
    // Section 1 (the oldest) MUST be in BODY.md, not in CONVO.md.
    expect(body).toContain("section 1");
    // (The split is at index sectionCount - freshTail = 50 - 4 = 46,
    // so sections 1-46 archive, sections 47-50 stay fresh.)

    // Index has exactly one entry.
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .split("\n").filter(Boolean);
    expect(idx).toHaveLength(1);
    const indexEntry = JSON.parse(idx[0]);
    expect(indexEntry.id).toBe(archId);
    expect(indexEntry.kind).toBe("leaf");
    expect(indexEntry.depth).toBe(0);
    // Keywords array on the index entry — the surface search.ts grep walks.
    for (const token of FACT_TOKENS) {
      expect(indexEntry.keywords.map((k: string) => k.toLowerCase())).toContain(token);
    }
  }, 10000);

  test("search.ts grep finds the archived edge by FACT_TOKEN keyword", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");
    runScript("archive.ts", ["auto", PEER], ORION_ENV);

    // Pick a distinctive token; it must appear in the index entry's
    // keywords (asserted in the prior test) and search.ts grep must
    // surface this archive when queried for it.
    const r = runScript("search.ts", ["grep", "kafkamigration"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(EDGE_ID);
    expect(r.stdout).toMatch(/arch_L_/);
  }, 10000);

  test("search.ts describe returns the SUMMARY.md content for the archived edge", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");
    const archR = runScript("archive.ts", ["auto", PEER], ORION_ENV);
    const archId = archR.stdout.match(/auto-archived (arch_L_\S+)/)![1];

    const r = runScript("search.ts", ["describe", archId], ORION_ENV);
    expect(r.exitCode).toBe(0);
    // describe surfaces TL;DR + Keywords + Expand-for-details.
    expect(r.stdout).toContain("TL;DR");
    expect(r.stdout.toLowerCase()).toContain("kafkamigration");
    expect(r.stdout).toMatch(/Auto-archive of \d+ section/);
  }, 10000);

  test("search.ts expand returns the verbatim BODY.md for an archived edge", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");
    const archR = runScript("archive.ts", ["auto", PEER], ORION_ENV);
    const archId = archR.stdout.match(/auto-archived (arch_L_\S+)/)![1];

    const r = runScript("search.ts", ["expand", archId], ORION_ENV);
    expect(r.exitCode).toBe(0);
    // BODY.md contains every archived section verbatim — section 1 through 46.
    expect(r.stdout).toContain("section 1");
    expect(r.stdout).toContain("section 46");
    // Sections 47-50 are in the fresh tail and NOT in BODY.md.
    expect(r.stdout).not.toContain("section 47");
  }, 10000);

  test("non-parked edge refuses auto-archive (--force overrides)", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    // turn=orion, not parked → refuse
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "orion");

    const r = runScript("archive.ts", ["auto", PEER], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/refuse to auto-archive/);

    // --force overrides the parked check.
    const r2 = runScript("archive.ts", ["auto", PEER, "--force"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/auto-archived/);
  }, 10000);

  test("re-running auto on an already-archived edge with no new sections refuses cleanly", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");
    runScript("archive.ts", ["auto", PEER], ORION_ENV);

    // After the first archive, CONVO.md is just header + breadcrumb + 4
    // fresh-tail sections. Running auto again with default freshTail=4
    // means there are zero archivable sections — refuses.
    const r = runScript("archive.ts", ["auto", PEER], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/nothing to archive/);

    // Index still has exactly one entry (no double-archive).
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .split("\n").filter(Boolean);
    expect(idx).toHaveLength(1);
  }, 10000);

  test("a second auto-archive after new sections accumulate produces a second leaf entry", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");
    runScript("archive.ts", ["auto", PEER], ORION_ENV);

    // Append more sections that push the fresh-tail-overflowed count past 4.
    const moreSections: string[] = [];
    for (let i = 51; i <= 60; i++) {
      const author = i % 2 === 0 ? "orion" : "lumeyon";
      const next = author === "orion" ? "lumeyon" : "orion";
      const ts = `2026-05-03T01:${String(i % 60).padStart(2, "0")}:00Z`;
      moreSections.push(
        `## ${author} — section ${i} (UTC ${ts})\n\n` +
        `Newer batch covering ${FACT_TOKENS.slice(0, 3).join(" ")}.\n\n` +
        `→ ${next}`,
      );
    }
    fs.appendFileSync(path.join(EDGE_DIR, "CONVO.md"), "\n\n---\n\n" + moreSections.join("\n\n---\n\n") + "\n");

    const r = runScript("archive.ts", ["auto", PEER], ORION_ENV);
    expect(r.exitCode).toBe(0);

    // Index now has two entries.
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .split("\n").filter(Boolean);
    expect(idx).toHaveLength(2);
  }, 10000);
});

describe("agent-chat exit / gc — auto-archive integration", () => {

  test("agent-chat exit auto-archives parked-and-bloated edges before teardown", () => {
    // Plant the synthetic conversation as parked + bloated.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    // Run exit (auto-archive default-on, --no-monitor avoids spawning a real monitor).
    // Note: cmdExit's auto-archive shells out to archive.ts auto which calls
    // resolveIdentity — which needs the session record on disk. Pre-staged
    // by beforeEach.
    const r = runScript("agent-chat.ts", ["exit"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/auto-archived 1 parked edge\(s\) before exit/);
    expect(r.stderr).toMatch(/auto-archived lumeyon edge \(\d+ lines\)/);

    // Archive directory exists (a leaf was sealed).
    const archiveDirs = fs.readdirSync(path.join(EDGE_DIR, "archives", "leaf"));
    expect(archiveDirs.length).toBe(1);
    expect(archiveDirs[0]).toMatch(/^arch_L_/);
    // Index has the entry.
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .split("\n").filter(Boolean);
    expect(idx).toHaveLength(1);
  }, 12000);

  test("agent-chat exit --no-auto-archive skips the auto-archive sweep", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    const r = runScript("agent-chat.ts", ["exit", "--no-auto-archive"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/auto-archived/);

    // No archive directory created.
    const leafDir = path.join(EDGE_DIR, "archives", "leaf");
    expect(fs.existsSync(leafDir)).toBe(false);
  }, 12000);

  test("agent-chat exit skips short edges (under threshold)", () => {
    // Only 5 sections — well under the 200-line threshold.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(5));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    const r = runScript("agent-chat.ts", ["exit"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    // No "auto-archived N parked edge(s)" line because none were over threshold.
    expect(r.stdout).not.toMatch(/auto-archived \d+ parked edge/);

    const leafDir = path.join(EDGE_DIR, "archives", "leaf");
    expect(fs.existsSync(leafDir)).toBe(false);
  }, 12000);

  test("agent-chat exit skips non-parked edges", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    // turn=orion, NOT parked — auto-archive should skip.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "orion");

    const r = runScript("agent-chat.ts", ["exit"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/auto-archived \d+ parked edge/);

    const leafDir = path.join(EDGE_DIR, "archives", "leaf");
    expect(fs.existsSync(leafDir)).toBe(false);
  }, 12000);

  test("agent-chat gc --auto-archive archives parked-and-bloated edges in the current session", () => {
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    const r = runScript("agent-chat.ts", ["gc", "--auto-archive"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/gc: auto-archived 1 parked edge\(s\) for orion@petersen/);

    // Confirm the leaf was sealed AND the index entry exists, just like exit.
    const archiveDirs = fs.readdirSync(path.join(EDGE_DIR, "archives", "leaf"));
    expect(archiveDirs.length).toBe(1);
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .split("\n").filter(Boolean);
    expect(idx).toHaveLength(1);

    // Key property: this is the SAME session — gc didn't tear down the
    // session record (that's what `exit` does).
    const sessionPath = path.join(CONVO_DIR, ".sessions", `${SESSION_KEY}.json`);
    expect(fs.existsSync(sessionPath)).toBe(true);
  }, 12000);

  test("agent-chat gc --auto-archive --archive-threshold=N respects the override", () => {
    // 10 sections. Default threshold (200 lines) would NOT archive; explicit
    // threshold of 1 line guarantees the edge qualifies.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(10));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    // First: confirm default threshold leaves it alone.
    const r1 = runScript("agent-chat.ts", ["gc", "--auto-archive"], ORION_ENV);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toMatch(/no parked edges over 200/);
    expect(fs.existsSync(path.join(EDGE_DIR, "archives", "leaf"))).toBe(false);

    // Now: with low threshold, it archives.
    const r2 = runScript("agent-chat.ts", ["gc", "--auto-archive", "--archive-threshold=1"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/auto-archived 1 parked edge/);
  }, 12000);
});
