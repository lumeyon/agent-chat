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
});
