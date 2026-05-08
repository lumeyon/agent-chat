// stats.test.ts — verify the lattice-stats output shape against a
// constructed fixture lattice.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LatticeStore } from "./sqlite-store.ts";
import { recordAnswer } from "./apprenticeship.ts";
import { getStats, formatHumanReadable } from "./stats.ts";

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
  dbPath = path.join(dbDir, "lattice.db");
});

afterEach(() => {
  if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("getStats — counts", () => {
  test("empty lattice produces zero counts", () => {
    new LatticeStore(dbPath).close();
    const s = getStats(dbPath);
    expect(s.questions.total).toBe(0);
    expect(s.answers.total).toBe(0);
    expect(s.citations.total).toBe(0);
    expect(s.question_parents.total).toBe(0);
  });

  test("counts question/answer/citation totals correctly", () => {
    const store = new LatticeStore(dbPath);
    for (let i = 0; i < 3; i++) {
      // Post-NL9 FK requires put-as-open-then-promote.
      store.putQuestion({
        id: `v1:q${i}`,
        framing: `Question ${i}`,
        status: "open",
        best_answer_id: null,
        posed_at: 1000 + i,
        posed_by: "boss",
        posed_in_context: null,
        depth: 0,
      });
      const a = recordAnswer(store, {
        question_id: `v1:q${i}`,
        body: `Answer ${i}`,
        by_agent: "orion",
        explanation: `Real explanation ${i}`,
        status: "accepted",
        quality_tier: 2,
      });
      store.setQuestionStatus(`v1:q${i}`, "answered", a.id);
    }
    store.close();
    const s = getStats(dbPath);
    expect(s.questions.total).toBe(3);
    expect(s.answers.total).toBe(3);
  });
});

describe("getStats — distributions", () => {
  test("by_status, by_posed_by, by_agent populated", () => {
    const store = new LatticeStore(dbPath);
    // Post-NL9 FK: put-as-open-then-promote.
    store.putQuestion({
      id: "v1:q1", framing: "Q1", status: "open",
      best_answer_id: null, posed_at: 100, posed_by: "boss",
      posed_in_context: null, depth: 0,
    });
    store.putQuestion({
      id: "v1:q2", framing: "Q2", status: "open",
      best_answer_id: null, posed_at: 200, posed_by: "orion",
      posed_in_context: null, depth: 1,
    });
    const a1 = recordAnswer(store, {
      question_id: "v1:q1", body: "A1", by_agent: "orion",
      explanation: "x", status: "accepted", quality_tier: 1,
    });
    const a2 = recordAnswer(store, {
      question_id: "v1:q2", body: "A2", by_agent: "lumeyon",
      explanation: "y", status: "accepted", quality_tier: 5,
    });
    store.setQuestionStatus("v1:q1", "answered", a1.id);
    store.setQuestionStatus("v1:q2", "answered", a2.id);
    store.close();

    const s = getStats(dbPath);
    expect(s.questions.by_status.answered).toBe(2);
    expect(s.questions.by_posed_by.boss).toBe(1);
    expect(s.questions.by_posed_by.orion).toBe(1);
    expect(s.answers.by_agent.orion).toBe(1);
    expect(s.answers.by_agent.lumeyon).toBe(1);
    expect(s.answers.by_quality_tier[1]).toBe(1);
    expect(s.answers.by_quality_tier[5]).toBe(1);
    expect(s.questions.depth_distribution[0]).toBe(1);
    expect(s.questions.depth_distribution[1]).toBe(1);
  });
});

describe("getStats — auto-imported vs authored", () => {
  test("counts auto-imported and authored separately", () => {
    const store = new LatticeStore(dbPath);
    // Post-NL9 FK: put-as-open-then-promote.
    store.putQuestion({
      id: "v1:q1", framing: "Q1", status: "open",
      best_answer_id: null, posed_at: 100, posed_by: "boss",
      posed_in_context: null, depth: 0,
    });
    store.putQuestion({
      id: "v1:q2", framing: "Q2", status: "open",
      best_answer_id: null, posed_at: 200, posed_by: "boss",
      posed_in_context: null, depth: 0,
    });
    recordAnswer(store, {
      question_id: "v1:q1", body: "A1", by_agent: "orion",
      explanation: "Real explanation, not a placeholder.",
      status: "accepted",
    });
    recordAnswer(store, {
      question_id: "v1:q2", body: "A2", by_agent: "orion",
      explanation: "(auto-imported from CONVO.md; no original explanation captured at write time. Subsequent answers in the lattice will require explanations per Apprenticeship Substrate forcing function 1.)",
      status: "accepted",
    });
    store.close();

    const s = getStats(dbPath);
    expect(s.answers.total).toBe(2);
    expect(s.answers.authored_count).toBe(1);
    expect(s.answers.auto_imported_count).toBe(1);
  });
});

describe("getStats — predictive_lift histogram", () => {
  test("min/max/mean/median computed correctly", () => {
    const store = new LatticeStore(dbPath);
    const lifts = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < lifts.length; i++) {
      store.putQuestion({
        id: `v1:q${i}`, framing: `Q${i}`, status: "open",
        best_answer_id: null, posed_at: 100 + i, posed_by: "boss",
        posed_in_context: null, depth: 0,
      });
      recordAnswer(store, {
        question_id: `v1:q${i}`, body: `A${i}`, by_agent: "orion",
        explanation: "x", status: "accepted",
        predictive_lift: lifts[i],
      });
    }
    store.close();

    const s = getStats(dbPath);
    const l = s.answers.predictive_lift;
    expect(l.min).toBeCloseTo(0.1, 5);
    expect(l.max).toBeCloseTo(0.9, 5);
    expect(l.mean).toBeCloseTo(0.5, 5);
    expect(l.median).toBeCloseTo(0.5, 5);
  });
});

describe("formatHumanReadable", () => {
  test("renders a markdown report with all sections", () => {
    new LatticeStore(dbPath).close();  // empty store
    const stats = getStats(dbPath);
    const text = formatHumanReadable(stats);
    expect(text).toContain("# Lattice stats");
    expect(text).toContain("## Questions: 0");
    expect(text).toContain("## Answers: 0");
    expect(text).toContain("## Graph structure");
  });

  test("includes percent-authored when answers exist", () => {
    const store = new LatticeStore(dbPath);
    store.putQuestion({
      id: "v1:q1", framing: "Q", status: "open",
      best_answer_id: null, posed_at: 100, posed_by: "boss",
      posed_in_context: null, depth: 0,
    });
    recordAnswer(store, {
      question_id: "v1:q1", body: "A", by_agent: "orion",
      explanation: "real", status: "accepted",
    });
    store.close();
    const stats = getStats(dbPath);
    const text = formatHumanReadable(stats);
    expect(text).toContain("Authored %:");
    expect(text).toContain("100.0%");
  });
});
