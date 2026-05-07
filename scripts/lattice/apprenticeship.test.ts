// apprenticeship.test.ts — Phase 7 tests for the apprenticeship-substrate
// forcing functions layered on top of the LatticeStore.
//
// Tests cover three of the four substrate forcing functions:
//   #1 Dual-output every turn          → recordAnswer
//   #4 Cross-domain push                → pushContext
//   #3 Selection pressure / re-ranking  → reRankAnswers

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { LatticeStore, makeAnswerId } from "./sqlite-store.ts";
import { recordAnswer, pushContext, reRankAnswers } from "./apprenticeship.ts";
import type { Question } from "./types.ts";

let store: LatticeStore;

beforeEach(() => {
  store = new LatticeStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: "v1:q-default",
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

describe("recordAnswer — dual-output enforcement (forcing function 1)", () => {
  test("rejects empty explanation", () => {
    store.putQuestion(makeQuestion());
    expect(() => recordAnswer(store, {
      question_id: "v1:q-default",
      body: "Friday at 5pm.",
      by_agent: "orion",
      explanation: "",
    })).toThrow(/dual-output/);
  });

  test("rejects whitespace-only explanation", () => {
    store.putQuestion(makeQuestion());
    expect(() => recordAnswer(store, {
      question_id: "v1:q-default",
      body: "Friday at 5pm.",
      by_agent: "orion",
      explanation: "   \n  \t  ",
    })).toThrow(/dual-output/);
  });

  test("rejects non-string explanation (defensive)", () => {
    store.putQuestion(makeQuestion());
    expect(() => recordAnswer(store, {
      question_id: "v1:q-default",
      body: "x",
      by_agent: "orion",
      explanation: undefined as any,
    })).toThrow(/dual-output/);
  });

  test("accepts non-empty explanation and stores the answer", () => {
    store.putQuestion(makeQuestion());
    const a = recordAnswer(store, {
      question_id: "v1:q-default",
      body: "Friday at 5pm.",
      by_agent: "orion",
      explanation: "From the project plan, the milestone date is Friday.",
    });
    expect(a.id).toMatch(/^ans:/);
    expect(a.explanation).toBe("From the project plan, the milestone date is Friday.");
    const fetched = store.getAnswer(a.id);
    expect(fetched?.explanation).toBe(a.explanation);
  });

  test("default predictive_lift=0, default status='proposed', default quality_tier=5", () => {
    store.putQuestion(makeQuestion());
    const a = recordAnswer(store, {
      question_id: "v1:q-default",
      body: "x",
      by_agent: "orion",
      explanation: "y",
    });
    expect(a.predictive_lift).toBe(0);
    expect(a.status).toBe("proposed");
    expect(a.quality_tier).toBe(5);
    expect(a.validator_id).toBeNull();
  });

  test("overrides for predictive_lift, status, quality_tier, validator_id pass through", () => {
    store.putQuestion(makeQuestion());
    const a = recordAnswer(store, {
      question_id: "v1:q-default",
      body: "x",
      by_agent: "orion",
      explanation: "y",
      predictive_lift: 0.8,
      status: "accepted",
      quality_tier: 1,
      validator_id: "human:alice",
    });
    expect(a.predictive_lift).toBe(0.8);
    expect(a.status).toBe("accepted");
    expect(a.quality_tier).toBe(1);
    expect(a.validator_id).toBe("human:alice");
  });
});

describe("pushContext — cross-domain push retrieval (forcing function 4)", () => {
  beforeEach(() => {
    // Seed a small set of varied answered questions.
    const qs: Question[] = [
      makeQuestion({ id: "v1:q-deadline",  framing: "What is the deadline?",         status: "answered", posed_at: 100 }),
      makeQuestion({ id: "v1:q-config",    framing: "Where is the config file?",     status: "answered", posed_at: 200 }),
      makeQuestion({ id: "v1:q-deploy",    framing: "How do I deploy to production?", status: "answered", posed_at: 300 }),
      makeQuestion({ id: "v1:q-build",     framing: "Why is the build slow?",        status: "answered", posed_at: 400 }),
      makeQuestion({ id: "v1:q-open",      framing: "How do I run tests?",            status: "open",      posed_at: 500 }),
    ];
    for (const q of qs) store.putQuestion(q);

    // Each answered question gets one accepted answer.
    for (const q of qs.filter((q) => q.status === "answered")) {
      const a = recordAnswer(store, {
        question_id: q.id,
        body: `Answer to: ${q.framing}`,
        by_agent: "orion",
        explanation: `Because of ${q.framing.toLowerCase()}.`,
        predictive_lift: 0.7,
        status: "accepted",
        quality_tier: 2,
      });
      store.setQuestionStatus(q.id, "answered", a.id);
    }
  });

  test("returns top-K most-similar answered questions", async () => {
    const hits = await pushContext(store, "When's the deadline?", { k: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.length).toBeGreaterThan(0);
    // Top hit should be the deadline question (semantic match).
    expect(hits[0].question.id).toBe("v1:q-deadline");
    expect(hits[0].cosine).toBeGreaterThan(0.5);
    // Best answer attached.
    expect(hits[0].best_answer).not.toBeNull();
    expect(hits[0].best_answer?.body).toContain("deadline");
    expect(hits[0].best_answer?.explanation).toBeDefined();
  }, 60_000);

  test("answered_only=true (default) excludes open questions", async () => {
    const hits = await pushContext(store, "tests", { k: 5 });
    for (const h of hits) {
      expect(h.question.status).not.toBe("open");
    }
  }, 60_000);

  test("answered_only=false includes open questions", async () => {
    const hits = await pushContext(store, "tests", { k: 5, answered_only: false });
    const openHit = hits.find((h) => h.question.id === "v1:q-open");
    expect(openHit).toBeDefined();
  }, 60_000);

  test("hits sorted by cosine DESC", async () => {
    const hits = await pushContext(store, "production deployment", { k: 4 });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].cosine).toBeLessThanOrEqual(hits[i - 1].cosine);
    }
  }, 60_000);

  test("k limits the result count", async () => {
    const hits = await pushContext(store, "anything", { k: 1 });
    expect(hits.length).toBe(1);
  }, 60_000);

  test("no candidates → empty result", async () => {
    const empty = new LatticeStore(":memory:");
    try {
      const hits = await pushContext(empty, "anything", { k: 5 });
      expect(hits).toEqual([]);
    } finally {
      empty.close();
    }
  });
});

describe("reRankAnswers — selection pressure (forcing function 3)", () => {
  beforeEach(() => {
    store.putQuestion(makeQuestion({ id: "v1:q1" }));
    store.putQuestion(makeQuestion({ id: "v1:q2" }));
  });

  test("promotes the highest-lift answer when margin is met", () => {
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "answer a", by_agent: "orion",  explanation: "ex a", predictive_lift: 0.3 });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "answer b", by_agent: "lumeyon", explanation: "ex b", predictive_lift: 0.9 });

    const result = reRankAnswers(store, "v1:q1");
    expect(result.promoted_to_accepted).toBe(a2.id);
    expect(result.demoted_to_superseded).toEqual([]);

    const updated = store.getAnswer(a2.id);
    expect(updated?.status).toBe("accepted");
    const q = store.getQuestion("v1:q1");
    expect(q?.status).toBe("answered");
    expect(q?.best_answer_id).toBe(a2.id);
  });

  test("does not promote when margin is not met (near-tie)", () => {
    recordAnswer(store, { question_id: "v1:q1", body: "answer a", by_agent: "orion",  explanation: "ex a", predictive_lift: 0.50 });
    recordAnswer(store, { question_id: "v1:q1", body: "answer b", by_agent: "lumeyon", explanation: "ex b", predictive_lift: 0.51 });
    const result = reRankAnswers(store, "v1:q1", { margin: 0.05 });
    expect(result.promoted_to_accepted).toBeNull();
    expect(result.demoted_to_superseded).toEqual([]);
  });

  test("demotes prior 'accepted' when a clear winner emerges", () => {
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "old", by_agent: "orion",   explanation: "x", predictive_lift: 0.5, status: "accepted" });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "new", by_agent: "lumeyon", explanation: "y", predictive_lift: 0.95 });

    const result = reRankAnswers(store, "v1:q1");
    expect(result.promoted_to_accepted).toBe(a2.id);
    expect(result.demoted_to_superseded).toEqual([a1.id]);

    expect(store.getAnswer(a1.id)?.status).toBe("superseded");
    expect(store.getAnswer(a2.id)?.status).toBe("accepted");
  });

  test("ignores 'refuted' answers when comparing", () => {
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "refuted-high", by_agent: "x", explanation: "e", predictive_lift: 0.99, status: "refuted" });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "accepted-mid", by_agent: "y", explanation: "e", predictive_lift: 0.6 });

    const result = reRankAnswers(store, "v1:q1", { single_answer_promotes: true });
    // a1 (highest lift) is refuted, so a2 is the only LIVE answer; with
    // single_answer_promotes=true and lift > 0, a2 gets promoted.
    expect(result.promoted_to_accepted).toBe(a2.id);
    expect(store.getAnswer(a1.id)?.status).toBe("refuted");
    expect(store.getAnswer(a2.id)?.status).toBe("accepted");
  });

  test("single proposed answer with lift=0 stays proposed (no signal)", () => {
    recordAnswer(store, { question_id: "v1:q1", body: "x", by_agent: "orion", explanation: "e", predictive_lift: 0 });
    const result = reRankAnswers(store, "v1:q1", { single_answer_promotes: true });
    expect(result.promoted_to_accepted).toBeNull();
  });

  test("idempotent — running twice produces same state", () => {
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "a", by_agent: "x", explanation: "e", predictive_lift: 0.3 });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "b", by_agent: "y", explanation: "e", predictive_lift: 0.9 });
    reRankAnswers(store, "v1:q1");
    const result2 = reRankAnswers(store, "v1:q1");
    // Second run finds nothing new to promote/demote.
    expect(result2.promoted_to_accepted).toBeNull();
    expect(result2.demoted_to_superseded).toEqual([]);
  });

  test("question with no answers — no-op", () => {
    const result = reRankAnswers(store, "v1:q1");
    expect(result).toEqual({ question_id: "v1:q1", promoted_to_accepted: null, demoted_to_superseded: [] });
  });
});
