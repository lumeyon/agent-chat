// sqlite-store.test.ts — Phase 6 tests for the multi-dim sqlite indices.
//
// Tests the contract from docs/inquiry-lattice.md "The multi-dimensional
// structure": multi-axis queries via index intersection, citation DAG
// traversal, cycle prevention, and the dual-audience-fusion-required
// fields (quality_tier, predictive_lift, validator_id).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { LatticeStore, makeAnswerId } from "./sqlite-store.ts";
import type { Question, Answer } from "./types.ts";

let store: LatticeStore;

beforeEach(() => {
  store = new LatticeStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: "v1:abc123def4567890",
    framing: "What is the deadline?",
    status: "open",
    best_answer_id: null,
    posed_at: 1000,
    posed_by: "boss",
    posed_in_context: "/petersen/boss-orion",
    depth: 0,
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: makeAnswerId("v1:abc123def4567890", "Friday at 5pm.", "orion"),
    question_id: "v1:abc123def4567890",
    body: "Friday at 5pm.",
    explanation: "Quoted directly from the project plan.",
    by_agent: "orion",
    predictive_lift: 0.5,
    status: "proposed",
    quality_tier: 3,
    created_at: 1010,
    validator_id: null,
    ...overrides,
  };
}

describe("LatticeStore — Question CRUD", () => {
  test("put + get round-trip", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    const fetched = store.getQuestion(q.id);
    expect(fetched).toEqual(q);
  });

  test("get unknown id returns null", () => {
    expect(store.getQuestion("v1:nonexistent")).toBeNull();
  });

  test("setQuestionStatus updates lifecycle", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    store.setQuestionStatus(q.id, "answered", "ans:abc123def4567890");
    const fetched = store.getQuestion(q.id);
    expect(fetched?.status).toBe("answered");
    expect(fetched?.best_answer_id).toBe("ans:abc123def4567890");
  });

  test("status check constraint rejects invalid values", () => {
    const q = makeQuestion();
    expect(() => {
      store.putQuestion({ ...q, status: "bogus" as any });
    }).toThrow();
  });
});

describe("LatticeStore — multi-axis question query", () => {
  beforeEach(() => {
    // Seed a varied set of questions for filtering tests.
    const seeds: Question[] = [
      makeQuestion({ id: "v1:q1", posed_at: 100, posed_by: "boss",  status: "open",     depth: 0 }),
      makeQuestion({ id: "v1:q2", posed_at: 200, posed_by: "boss",  status: "answered", depth: 1 }),
      makeQuestion({ id: "v1:q3", posed_at: 300, posed_by: "orion", status: "answered", depth: 2 }),
      makeQuestion({ id: "v1:q4", posed_at: 400, posed_by: "orion", status: "closed",   depth: 0 }),
      makeQuestion({ id: "v1:q5", posed_at: 500, posed_by: "john",  status: "reopened", depth: 1 }),
    ];
    for (const q of seeds) store.putQuestion(q);
  });

  test("filter by status (single)", () => {
    const out = store.queryQuestions({ status: "answered" });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q3"]);
  });

  test("filter by status (array)", () => {
    const out = store.queryQuestions({ status: ["closed", "reopened"] });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q4", "v1:q5"]);
  });

  test("filter by posed_by (agent index)", () => {
    const out = store.queryQuestions({ posed_by: "orion" });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q3", "v1:q4"]);
  });

  test("temporal range filter", () => {
    const out = store.queryQuestions({ posed_at_after: 200, posed_at_before: 500 });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q3", "v1:q4"]);
  });

  test("depth filter (depth_min, depth_max)", () => {
    const out = store.queryQuestions({ depth_min: 1, depth_max: 1 });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q5"]);
  });

  test("multi-axis intersection: answered AND posed by orion", () => {
    const out = store.queryQuestions({ status: "answered", posed_by: "orion" });
    expect(out.map((q) => q.id)).toEqual(["v1:q3"]);
  });

  test("multi-axis intersection: by boss in temporal window AND open", () => {
    const out = store.queryQuestions({
      posed_by: "boss",
      posed_at_after: 0,
      posed_at_before: 250,
      status: "open",
    });
    expect(out.map((q) => q.id)).toEqual(["v1:q1"]);
  });

  test("ordering: posed_at DESC by default", () => {
    const out = store.queryQuestions({});
    expect(out.map((q) => q.id)).toEqual(["v1:q5", "v1:q4", "v1:q3", "v1:q2", "v1:q1"]);
  });

  test("ordering: posed_at ASC explicit", () => {
    const out = store.queryQuestions({ order_by: "posed_at_asc" });
    expect(out.map((q) => q.id)).toEqual(["v1:q1", "v1:q2", "v1:q3", "v1:q4", "v1:q5"]);
  });

  test("limit caps result set", () => {
    const out = store.queryQuestions({ limit: 2 });
    expect(out.length).toBe(2);
  });
});

describe("LatticeStore — Answer CRUD + multi-axis", () => {
  beforeEach(() => {
    store.putQuestion(makeQuestion({ id: "v1:q1" }));
    store.putQuestion(makeQuestion({ id: "v1:q2" }));
    const seeds: Answer[] = [
      makeAnswer({ id: "ans:a1", question_id: "v1:q1", by_agent: "orion",  status: "accepted",   predictive_lift: 0.9, quality_tier: 2 }),
      makeAnswer({ id: "ans:a2", question_id: "v1:q1", by_agent: "lumeyon", status: "proposed",  predictive_lift: 0.4, quality_tier: 4 }),
      makeAnswer({ id: "ans:a3", question_id: "v1:q2", by_agent: "orion",  status: "accepted",   predictive_lift: 0.7, quality_tier: 1, validator_id: "boss" }),
      makeAnswer({ id: "ans:a4", question_id: "v1:q2", by_agent: "carina", status: "refuted",    predictive_lift: 0.1, quality_tier: 5 }),
    ];
    for (const a of seeds) store.putAnswer(a);
  });

  test("filter by question_id", () => {
    const out = store.queryAnswers({ question_id: "v1:q1" });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a2"]);
  });

  test("filter by by_agent", () => {
    const out = store.queryAnswers({ by_agent: "orion" });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("filter by quality_tier_min (tier 1 is best)", () => {
    const out = store.queryAnswers({ quality_tier_min: 2 });
    // tier 1 and tier 2 answers
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("filter by predictive_lift_min", () => {
    const out = store.queryAnswers({ predictive_lift_min: 0.5 });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("ordering: predictive_lift DESC by default", () => {
    const out = store.queryAnswers({});
    expect(out.map((a) => a.id)).toEqual(["ans:a1", "ans:a3", "ans:a2", "ans:a4"]);
  });

  test("multi-axis: orion's accepted answers with predictive_lift > 0.5", () => {
    const out = store.queryAnswers({
      by_agent: "orion",
      status: "accepted",
      predictive_lift_min: 0.5,
    });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });
});

describe("LatticeStore — Citation DAG", () => {
  beforeEach(() => {
    store.putQuestion(makeQuestion());
    for (const id of ["ans:a", "ans:b", "ans:c", "ans:d"]) {
      store.putAnswer(makeAnswer({ id }));
    }
  });

  test("addCitation + getCitedAnswers + getCitingAnswers", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:a", "ans:c");
    store.addCitation("ans:b", "ans:d");

    expect(store.getCitedAnswers("ans:a").map((c) => c.child_answer_id).sort()).toEqual(
      ["ans:b", "ans:c"],
    );
    expect(store.getCitingAnswers("ans:d").map((c) => c.parent_answer_id)).toEqual(["ans:b"]);
  });

  test("cycle prevention — direct loop refused", () => {
    store.addCitation("ans:a", "ans:b");
    expect(() => store.addCitation("ans:b", "ans:a")).toThrow(/cycle/);
  });

  test("cycle prevention — transitive cycle refused", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:b", "ans:c");
    expect(() => store.addCitation("ans:c", "ans:a")).toThrow(/cycle/);
  });

  test("self-citation refused", () => {
    expect(() => store.addCitation("ans:a", "ans:a")).toThrow(/self/);
  });

  test("non-cyclic citations work after a near-cycle was rejected", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:b", "ans:c");
    expect(() => store.addCitation("ans:c", "ans:a")).toThrow();
    // ans:d isn't in the cycle path; (a, d) is fine.
    store.addCitation("ans:a", "ans:d");
    expect(store.getCitedAnswers("ans:a").length).toBe(2);
  });
});

describe("LatticeStore — Question DAG", () => {
  beforeEach(() => {
    for (const id of ["v1:q1", "v1:q2", "v1:q3"]) {
      store.putQuestion(makeQuestion({ id }));
    }
  });

  test("addQuestionParent + traversal", () => {
    store.addQuestionParent("v1:q1", "v1:q2");
    store.addQuestionParent("v1:q1", "v1:q3");
    expect(store.getQuestionChildren("v1:q1").map((p) => p.child_question_id).sort()).toEqual(
      ["v1:q2", "v1:q3"],
    );
    expect(store.getQuestionParents("v1:q2").map((p) => p.parent_question_id)).toEqual(["v1:q1"]);
  });

  test("cycle prevention on question DAG", () => {
    store.addQuestionParent("v1:q1", "v1:q2");
    store.addQuestionParent("v1:q2", "v1:q3");
    expect(() => store.addQuestionParent("v1:q3", "v1:q1")).toThrow(/cycle/);
  });
});

describe("LatticeStore — stats and constraints", () => {
  test("stats reports correct counts", () => {
    store.putQuestion(makeQuestion({ id: "v1:q1" }));
    store.putQuestion(makeQuestion({ id: "v1:q2" }));
    store.putAnswer(makeAnswer({ id: "ans:a", question_id: "v1:q1" }));
    store.putAnswer(makeAnswer({ id: "ans:b", question_id: "v1:q2" }));
    store.addCitation("ans:b", "ans:a");
    store.addQuestionParent("v1:q1", "v1:q2");

    const s = store.stats();
    expect(s.questions).toBe(2);
    expect(s.answers).toBe(2);
    expect(s.citations).toBe(1);
    expect(s.question_parents).toBe(1);
  });

  test("foreign key constraint rejects citation referencing non-existent answer", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:a" }));
    expect(() => store.addCitation("ans:a", "ans:does_not_exist")).toThrow(/FOREIGN KEY/);
  });
});

describe("LatticeStore — quality_tier semantics (dual-audience fusion)", () => {
  test("quality_tier 1 (gold) sorts above tier 5 (raw) under quality_tier_min filter", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:gold", quality_tier: 1, predictive_lift: 0.5 }));
    store.putAnswer(makeAnswer({ id: "ans:raw",  quality_tier: 5, predictive_lift: 0.5 }));

    // Filter for tier-1-only:
    const top = store.queryAnswers({ quality_tier_min: 1 });
    expect(top.map((a) => a.id)).toEqual(["ans:gold"]);

    // Filter for tier-3-or-better — only gold (tier 1) qualifies; raw (tier 5) is below.
    const above3 = store.queryAnswers({ quality_tier_min: 3 });
    expect(above3.map((a) => a.id)).toEqual(["ans:gold"]);

    // Filter for tier-5-or-better — both qualify.
    const above5 = store.queryAnswers({ quality_tier_min: 5 });
    expect(above5.map((a) => a.id).sort()).toEqual(["ans:gold", "ans:raw"]);
  });

  test("validator_id is preserved (gold-standard provenance)", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:gold", quality_tier: 1, validator_id: "human:alice" }));
    const fetched = store.getAnswer("ans:gold");
    expect(fetched?.validator_id).toBe("human:alice");
  });
});
