// lattice-context.test.ts — ALT-A-2 — verify pushContext block composition
// and the most-recent-peer-body extractor used to feed it.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LatticeStore } from "../../../scripts/lattice/sqlite-store.ts";
import { recordAnswer } from "../../../scripts/lattice/apprenticeship.ts";
import {
  composePushedContextBlock,
  extractMostRecentPeerBody,
} from "../scripts/lattice-context.ts";
import type { Question } from "../../../scripts/lattice/types.ts";

let dbPath: string;
let dbDir: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-context-"));
  dbPath = path.join(dbDir, "lattice.db");
});

afterEach(() => {
  if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
});

function seedQuestion(store: LatticeStore, overrides: Partial<Question> = {}): Question {
  // Natural starting state per the iter-5 joint-consistency invariant
  // (sqlite-store.ts:enforceQuestionStatusInvariant). Tests that need
  // status="answered" must call setQuestionStatus(id, "answered", ans.id)
  // after the answer is recorded.
  const q: Question = {
    id: `v1:q-${Math.random().toString(36).slice(2, 10)}`,
    framing: "What is the deadline?",
    status: "open",
    best_answer_id: null,
    posed_at: 1000,
    posed_by: "boss",
    posed_in_context: "/petersen/boss-orion",
    depth: 0,
    ...overrides,
  };
  store.putQuestion(q);
  return q;
}

describe("extractMostRecentPeerBody", () => {
  test("returns the most recent peer section's body", () => {
    const sections = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)\n\nWhat is X?\n\n→ orion\n",
      "## orion — assistant response (UTC 2026-05-07T10:00:00Z)\n\nIt's X.\n\n→ boss\n",
      "## boss — user turn (UTC 2026-05-07T10:01:00Z)\n\nHow do I deploy?\n\n→ orion\n",
    ];
    const body = extractMostRecentPeerBody(sections, "orion");
    expect(body).toBe("How do I deploy?");
  });

  test("skips this agent's own sections", () => {
    const sections = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)\n\nWhat is X?\n\n→ orion\n",
      "## orion — assistant response (UTC 2026-05-07T10:00:00Z)\n\nIt's X.\n\n→ boss\n",
    ];
    // Asking from orion's perspective — should pick up boss's question, not orion's response.
    const body = extractMostRecentPeerBody(sections, "orion");
    expect(body).toBe("What is X?");
  });

  test("returns empty string when only own sections exist", () => {
    const sections = [
      "## orion — autonomous note (UTC 2026-05-07T10:00:00Z)\n\nReminder to self.\n",
    ];
    expect(extractMostRecentPeerBody(sections, "orion")).toBe("");
  });

  test("returns empty string for malformed sections", () => {
    const sections = ["not a section", "still not"];
    expect(extractMostRecentPeerBody(sections, "orion")).toBe("");
  });

  test("AI-to-AI dialog: most recent peer is the OTHER agent", () => {
    const sections = [
      "## orion — kickoff (UTC 2026-05-07T10:00:00Z)\n\nQ for lumeyon.\n\n→ lumeyon\n",
      "## lumeyon — response (UTC 2026-05-07T10:01:00Z)\n\nA for orion.\n\n→ orion\n",
    ];
    expect(extractMostRecentPeerBody(sections, "orion")).toBe("A for orion.");
  });

  // Regression for carina's NL12 LC5 finding: extractMostRecentPeerBody
  // used `/m` flag on the trailing-marker regexes — same bug class as
  // K-imp-2 in import-from-kg.ts. With `/m`, `$` matches end-of-LINE,
  // so internal lines ending with `→ word` or `---` got stripped from
  // body content. Drop /m so only the TRUE trailing markers strip.
  test("LC5: internal '→ name' lines preserved (not stripped by trailing-marker regex)", () => {
    const sections = [
      "## lumeyon — review (UTC 2026-05-07T10:00:00Z)\n\nFirst line.\nWe routed it → orion\nThen we continued.\n\n→ orion\n",
    ];
    const body = extractMostRecentPeerBody(sections, "orion");
    // Pre-fix: the internal line "We routed it → orion" gets stripped
    // because $ with /m matches end-of-line.
    // Post-fix: only the TRUE trailing "→ orion" arrow strips; the
    // internal arrow on line 2 stays.
    expect(body).toContain("We routed it → orion");
    expect(body).toContain("Then we continued");
  });

  test("LC5: internal '---' separator preserved (only trailing stripped)", () => {
    const sections = [
      "## lumeyon — review (UTC 2026-05-07T10:00:00Z)\n\nSection A.\n---\nSection B after rule.\n\n---\n",
    ];
    const body = extractMostRecentPeerBody(sections, "orion");
    // The body has TWO `---` lines: one internal (between A and B) and
    // one trailing. Pre-fix the regex strips the FIRST match (internal
    // line) due to /m. Post-fix it strips only the TRAILING one.
    // Stronger assertion: structure of the body should be
    //   Section A.\n---\nSection B after rule.
    // NOT a hyphen-collapsed version that lost the internal rule.
    expect(body).toBe("Section A.\n---\nSection B after rule.");
  });
});

describe("composePushedContextBlock", () => {
  test("returns empty string when lattice DB doesn't exist", async () => {
    const block = await composePushedContextBlock({
      query: "What is X?",
      latticeDbPath: "/nonexistent/path.db",
    });
    expect(block).toBe("");
  });

  test("returns empty string when query is empty", async () => {
    const store = new LatticeStore(dbPath);
    seedQuestion(store);
    store.close();
    const block = await composePushedContextBlock({
      query: "",
      latticeDbPath: dbPath,
    });
    expect(block).toBe("");
  });

  test("returns empty string when lattice has no relevant priors", async () => {
    const store = new LatticeStore(dbPath);
    store.close();  // empty DB
    const block = await composePushedContextBlock({
      query: "What is X?",
      latticeDbPath: dbPath,
    });
    expect(block).toBe("");
  }, 30_000);

  test("returns formatted block when lattice has relevant priors", async () => {
    const store = new LatticeStore(dbPath);
    const q = seedQuestion(store, { framing: "How do I deploy to production?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Run `bun deploy.ts`.",
      by_agent: "lumeyon",
      explanation: "Standard deploy script in the repo.",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    store.close();

    const block = await composePushedContextBlock({
      query: "How do I deploy to production?",
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
    });
    expect(block).toContain("Relevant prior knowledge from the lattice");
    expect(block).toContain("How do I deploy");
    expect(block).toContain("bun deploy.ts");
    expect(block).toContain("by lumeyon");
    expect(block).toMatch(/cosine \d+\.\d{2}/);
  }, 30_000);

  test("excludes answers by the current agent", async () => {
    const store = new LatticeStore(dbPath);
    const q = seedQuestion(store, { framing: "What is the deadline?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Friday, says orion.",
      by_agent: "orion",
      explanation: "Orion knows this.",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    store.close();

    const block = await composePushedContextBlock({
      query: "What is the deadline?",
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
    });
    // Orion's own answer should be filtered out → no other answers exist → empty block.
    expect(block).toBe("");
  }, 30_000);

  test("includes peer answer but excludes self answer when both present", async () => {
    const store = new LatticeStore(dbPath);
    const q1 = seedQuestion(store, { id: "v1:q-self", framing: "Question A" });
    const q2 = seedQuestion(store, { id: "v1:q-peer", framing: "Question B" });
    const a1 = recordAnswer(store, {
      question_id: q1.id,
      body: "Self answer",
      by_agent: "orion",
      explanation: "x",
      status: "accepted",
    });
    store.setQuestionStatus(q1.id, "answered", a1.id);
    const a2 = recordAnswer(store, {
      question_id: q2.id,
      body: "Peer answer",
      by_agent: "lumeyon",
      explanation: "y",
      status: "accepted",
    });
    store.setQuestionStatus(q2.id, "answered", a2.id);
    store.close();

    const block = await composePushedContextBlock({
      query: "Question",  // matches both fuzzily
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
    });
    expect(block).toContain("Peer answer");
    expect(block).not.toContain("Self answer");
  }, 30_000);

  test("auto-imported explanations are NOT shown (they're noise)", async () => {
    const store = new LatticeStore(dbPath);
    const q = seedQuestion(store, { framing: "What is X?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "It is X.",
      by_agent: "lumeyon",
      explanation: "(auto-imported from CONVO.md; no original explanation captured at write time. Subsequent answers in the lattice will require explanations per Apprenticeship Substrate forcing function 1.)",
      status: "accepted",
      quality_tier: 5,
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    store.close();

    const block = await composePushedContextBlock({
      query: "What is X?",
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
    });
    expect(block).toContain("It is X.");
    // The auto-imported placeholder explanation should NOT show up in the
    // prompt — it's noise and would crowd out signal.
    expect(block).not.toContain("auto-imported");
  }, 30_000);

  // Regression for carina's NL12 LC1 finding: composePushedContextBlock
  // emitted ALL top-K hits regardless of cosine. With sparse corpora
  // (production-corpus cosines all ≤0.31 per iter-4), low-relevance
  // content polluted cmdRun prompts. NL15 fix: add `min_cosine`
  // parameter; filter hits below the threshold.
  test("LC1: min_cosine filters out below-threshold hits", async () => {
    const store = new LatticeStore(dbPath);
    // Seed two questions: one closely matches the query, one is unrelated.
    const closeQ = seedQuestion(store, {
      id: "v1:q-close",
      framing: "How do I deploy to production?",
    });
    const closeA = recordAnswer(store, {
      question_id: closeQ.id,
      body: "Run `bun deploy.ts` from the repo root.",
      by_agent: "lumeyon",
      explanation: "Standard deploy.",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(closeQ.id, "answered", closeA.id);

    const farQ = seedQuestion(store, {
      id: "v1:q-far",
      framing: "What time is it in Tokyo?",
    });
    const farA = recordAnswer(store, {
      question_id: farQ.id,
      body: "It's currently 3 AM JST.",
      by_agent: "lumeyon",
      explanation: "Time-zone lookup.",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(farQ.id, "answered", farA.id);
    store.close();

    // Query targets the deploy question. Without min_cosine, both hits
    // would be emitted (the unrelated one polluting the prompt).
    // With min_cosine: 0.4, only the close-match should survive.
    const block = await composePushedContextBlock({
      query: "How do I deploy to production?",
      latticeDbPath: dbPath,
      k: 5,
      exclude_agent: "orion",
      min_cosine: 0.4,
    });
    expect(block).toContain("bun deploy.ts");
    // The unrelated Tokyo time hit should be filtered out.
    expect(block).not.toContain("Tokyo");
    expect(block).not.toContain("JST");
  }, 30_000);

  test("LC1: min_cosine: 0.99 filters out paraphrased matches (high-bar threshold)", async () => {
    const store = new LatticeStore(dbPath);
    const q = seedQuestion(store, { framing: "How do I deploy to production?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Run `bun deploy.ts`.",
      by_agent: "lumeyon",
      explanation: "Standard.",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    store.close();

    // Paraphrased query — cosine of paraphrased technical text typically
    // lands in [0.6, 0.85]; should not reach 0.99 unless strings are
    // essentially identical.
    const block = await composePushedContextBlock({
      query: "What's the procedure for shipping the app to prod?",
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
      min_cosine: 0.99,
    });
    expect(block).toBe("");  // paraphrase filtered out
  }, 30_000);

  test("LC1: omitting min_cosine preserves prior behavior (no filter)", async () => {
    const store = new LatticeStore(dbPath);
    const q = seedQuestion(store, { framing: "Random topic." });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Random body.",
      by_agent: "lumeyon",
      explanation: "x",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    store.close();

    // Different query — would have low cosine. Without min_cosine,
    // pre-NL15 behavior is to include the hit anyway.
    const block = await composePushedContextBlock({
      query: "Completely unrelated other topic about cooking.",
      latticeDbPath: dbPath,
      k: 3,
      exclude_agent: "orion",
      // min_cosine omitted
    });
    // Backwards compat: the hit is included even with low cosine.
    expect(block).toContain("Random body");
  }, 30_000);
});
