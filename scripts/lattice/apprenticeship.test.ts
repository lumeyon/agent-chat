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
    // Seed all as "open" first; the setQuestionStatus call below promotes
    // each to "answered" once its accepted answer exists (per the joint
    // status / best_answer_id invariant added in iter-5).
    const qs: Question[] = [
      makeQuestion({ id: "v1:q-deadline",  framing: "What is the deadline?",         status: "open", posed_at: 100 }),
      makeQuestion({ id: "v1:q-config",    framing: "Where is the config file?",     status: "open", posed_at: 200 }),
      makeQuestion({ id: "v1:q-deploy",    framing: "How do I deploy to production?", status: "open", posed_at: 300 }),
      makeQuestion({ id: "v1:q-build",     framing: "Why is the build slow?",        status: "open", posed_at: 400 }),
      makeQuestion({ id: "v1:q-open",      framing: "How do I run tests?",            status: "open", posed_at: 500 }),
    ];
    for (const q of qs) store.putQuestion(q);

    // Each question except the explicit "stay-open" one gets one accepted
    // answer + status promotion to "answered".
    for (const q of qs.filter((q) => q.id !== "v1:q-open")) {
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

  // Regression for lumeyon's iter-1 (new-loop) L1+L2 findings:
  // pushContext was bypassing quality_tier_min/predictive_lift_min on
  // the best_answer_id path — filters were only applied in the fallback
  // path. High-stakes callers passing `quality_tier_min: 1` could still
  // receive tier-5 answers via the best_answer_id pointer.
  // Also: best_answer_id was treated as authoritative even if its
  // pointed-to answer was no longer accepted (e.g., status superseded).
  test("L1: pushContext respects quality_tier_min on the best_answer_id path", async () => {
    // Seed a question whose best_answer_id points at a tier-5 (raw)
    // accepted answer. With quality_tier_min: 1, the caller should NOT
    // receive that tier-5 answer back via best_answer.
    const tinyStore = new LatticeStore(":memory:");
    try {
      const q = makeQuestion({ id: "v1:q-tier-test", framing: "Important deadline?" });
      tinyStore.putQuestion(q);
      const lowQualA = recordAnswer(tinyStore, {
        question_id: q.id,
        body: "raw low-quality answer",
        by_agent: "orion",
        explanation: "low quality",
        predictive_lift: 0.0,
        status: "accepted",
        quality_tier: 5,  // raw
      });
      tinyStore.setQuestionStatus(q.id, "answered", lowQualA.id);
      // Filter for tier-1-or-better (high-stakes). best_answer should
      // NOT be the tier-5 raw answer — it should fall back to find a
      // higher-tier accepted answer (none exists, so null).
      const hits = await pushContext(tinyStore, "Important deadline?", {
        k: 1,
        quality_tier_min: 1,
      });
      expect(hits.length).toBe(1);
      expect(hits[0].best_answer).toBeNull();  // tier-5 filtered out, no higher-tier alt
    } finally {
      tinyStore.close();
    }
  }, 30_000);

  test("L2: pushContext rejects best_answer_id pointing at non-accepted answer", async () => {
    // Set up a question where best_answer_id points at an answer whose
    // status is NOT "accepted" (e.g., superseded). pushContext should
    // recognize the stale pointer and fall back to searching for a
    // currently-accepted alternative.
    const tinyStore = new LatticeStore(":memory:");
    try {
      const q = makeQuestion({ id: "v1:q-stale-ptr", framing: "Stale pointer test?" });
      tinyStore.putQuestion(q);
      // Create an accepted answer FIRST (so we can set status=answered
      // with valid FK, then later supersede it).
      const a1 = recordAnswer(tinyStore, {
        question_id: q.id,
        body: "first answer",
        by_agent: "orion",
        explanation: "x",
        predictive_lift: 0.5,
        status: "accepted",
        quality_tier: 2,
      });
      tinyStore.setQuestionStatus(q.id, "answered", a1.id);
      // Now supersede the answer (e.g., a better one was found).
      tinyStore.setAnswerStatus(a1.id, "superseded");
      // Add a fresh accepted answer for fallback.
      const a2 = recordAnswer(tinyStore, {
        question_id: q.id,
        body: "fresh accepted answer",
        by_agent: "lumeyon",
        explanation: "y",
        predictive_lift: 0.7,
        status: "accepted",
        quality_tier: 2,
      });
      // best_answer_id still points at a1 (now superseded).
      const hits = await pushContext(tinyStore, "Stale pointer test?", { k: 1 });
      expect(hits.length).toBe(1);
      // The post-fix behavior: pushContext should detect the stale pointer
      // and fall back to a2 (the currently-accepted answer).
      expect(hits[0].best_answer?.id).toBe(a2.id);
    } finally {
      tinyStore.close();
    }
  }, 30_000);
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

  // Regression for keystone's NL5 / lumeyon's NL1 L4 finding: exact-margin
  // wins fail under raw IEEE 754 float subtraction. The spec says
  // "winner must beat next-best by margin OR MORE", so a delta of exactly
  // `margin` should promote. But `0.30 - 0.25` evaluates to
  // 0.04999999999999998, which is < 0.05; the condition `< margin`
  // wrongly triggers "no promotion."
  test("L4: exact-margin wins promote (epsilon-tolerant float comparison)", () => {
    // Top - runner-up = exactly 0.05 in mathematical terms; in IEEE 754
    // 0.30 - 0.25 = 0.04999999999999998. Pre-fix this fails to promote.
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "lower", by_agent: "orion",  explanation: "x", predictive_lift: 0.25 });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "top",   by_agent: "lumeyon", explanation: "y", predictive_lift: 0.30 });
    const result = reRankAnswers(store, "v1:q1", { margin: 0.05 });
    expect(result.promoted_to_accepted).toBe(a2.id);
  });

  test("L4: another float-precision case — 0.45 vs 0.40 with margin 0.05", () => {
    // 0.45 - 0.40 = 0.04999999999999998 (same representation issue).
    const a1 = recordAnswer(store, { question_id: "v1:q1", body: "lower", by_agent: "orion",  explanation: "x", predictive_lift: 0.40 });
    const a2 = recordAnswer(store, { question_id: "v1:q1", body: "top",   by_agent: "lumeyon", explanation: "y", predictive_lift: 0.45 });
    const result = reRankAnswers(store, "v1:q1", { margin: 0.05 });
    expect(result.promoted_to_accepted).toBe(a2.id);
  });

  test("L4: still respects margin — 0.50 vs 0.48 with margin 0.05 stays as no-promotion", () => {
    // Real near-tie below margin (0.02 < 0.05). Should NOT promote.
    // Verifies the epsilon fix doesn't regress the "below margin" case.
    recordAnswer(store, { question_id: "v1:q1", body: "lower", by_agent: "orion",  explanation: "x", predictive_lift: 0.48 });
    recordAnswer(store, { question_id: "v1:q1", body: "top",   by_agent: "lumeyon", explanation: "y", predictive_lift: 0.50 });
    const result = reRankAnswers(store, "v1:q1", { margin: 0.05 });
    expect(result.promoted_to_accepted).toBeNull();
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
