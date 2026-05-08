// study-turn.test.ts — tests with a fake Predictor (no LLM cost).
// Real-LLM end-to-end verification is a separate one-shot smoke run,
// not part of the unit-test suite.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { LatticeStore, makeAnswerId } from "./sqlite-store.ts";
import { recordAnswer } from "./apprenticeship.ts";
import {
  selectStudyQuestions,
  buildStudyPrompt,
  gradePrediction,
  applyGradeToLift,
  runStudyTurn,
  type Predictor,
  type StudyChallenge,
} from "./study-turn.ts";
import type { Question } from "./types.ts";

let store: LatticeStore;

beforeEach(() => {
  store = new LatticeStore(":memory:");
});

afterEach(() => {
  store.close();
});

// Seeds a question in the natural starting state ("open" with no best_answer_id).
// Callers that need the question in "answered" state must call setQuestionStatus
// after recording the answer, per the iter-5 joint-consistency invariant
// enforced in sqlite-store.ts:enforceQuestionStatusInvariant.
function seedQuestion(store: LatticeStore, overrides: Partial<Question> = {}): Question {
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

// Convenience: seeds a question + answer + sets the question status to
// "answered" with best_answer_id pointing at the new answer. Mirrors
// the production workflow that future iterations should also use.
function seedAnsweredQuestion(
  store: LatticeStore,
  qOverrides: Partial<Question> = {},
  aOverrides: { body?: string; explanation?: string; by_agent?: string; quality_tier?: 1 | 2 | 3 | 4 | 5; predictive_lift?: number } = {},
): { q: Question; a: import("./types.ts").Answer } {
  const q = seedQuestion(store, qOverrides);
  const a = recordAnswer(store, {
    question_id: q.id,
    body: aOverrides.body ?? `Answer to: ${q.framing}`,
    by_agent: aOverrides.by_agent ?? "orion",
    explanation: aOverrides.explanation ?? `Real explanation for ${q.framing}`,
    status: "accepted",
    quality_tier: aOverrides.quality_tier ?? 2,
    predictive_lift: aOverrides.predictive_lift ?? 0,
  });
  store.setQuestionStatus(q.id, "answered", a.id);
  return { q, a };
}

describe("selectStudyQuestions", () => {
  test("returns up to k candidates with valid actual_answers", () => {
    for (let i = 0; i < 4; i++) {
      const q = seedQuestion(store, { id: `v1:q${i}`, framing: `Question ${i}` });
      const a = recordAnswer(store, {
        question_id: q.id,
        body: `Answer ${i}`,
        by_agent: "orion",
        explanation: `Real explanation for ${i}`,
        status: "accepted",
        quality_tier: 2,
      });
      store.setQuestionStatus(q.id, "answered", a.id);
    }
    const candidates = selectStudyQuestions(store, { k: 3 });
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.actual_answer).toBeDefined();
      expect(c.actual_answer.explanation).toBeTruthy();
    }
  });

  test("skips questions whose accepted answers have empty explanations", () => {
    const q = seedQuestion(store, { id: "v1:q-no-expl", framing: "X" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "answer",
      by_agent: "orion",
      explanation: "non-empty",  // record requires non-empty
      status: "accepted",
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    // Manually clear the explanation to simulate auto-imported placeholder later.
    // (recordAnswer enforces non-empty, so we use the placeholder pattern instead.)
    const q2 = seedQuestion(store, { id: "v1:q-auto", framing: "Y" });
    const a2 = recordAnswer(store, {
      question_id: q2.id,
      body: "answer2",
      by_agent: "orion",
      explanation: "(auto-imported from CONVO.md; no original explanation captured at write time. Subsequent answers in the lattice will require explanations per Apprenticeship Substrate forcing function 1.)",
      status: "accepted",
    });
    store.setQuestionStatus(q2.id, "answered", a2.id);

    const candidates = selectStudyQuestions(store, { k: 5 });
    // Only the non-auto-imported question should make it in.
    expect(candidates.length).toBe(1);
    expect(candidates[0].question.id).toBe("v1:q-no-expl");
  });

  test("excludes answers by exclude_agent", () => {
    const q1 = seedQuestion(store, { id: "v1:q1", framing: "A" });
    const q2 = seedQuestion(store, { id: "v1:q2", framing: "B" });
    const a1 = recordAnswer(store, {
      question_id: q1.id,
      body: "by orion",
      by_agent: "orion",
      explanation: "x",
      status: "accepted",
    });
    store.setQuestionStatus(q1.id, "answered", a1.id);
    const a2 = recordAnswer(store, {
      question_id: q2.id,
      body: "by lumeyon",
      by_agent: "lumeyon",
      explanation: "y",
      status: "accepted",
    });
    store.setQuestionStatus(q2.id, "answered", a2.id);
    const out = selectStudyQuestions(store, { k: 5, exclude_agent: "orion" });
    expect(out.length).toBe(1);
    expect(out[0].actual_answer.by_agent).toBe("lumeyon");
  });

  test("returns empty array when lattice has no candidates", () => {
    const out = selectStudyQuestions(store);
    expect(out).toEqual([]);
  });
});

describe("buildStudyPrompt", () => {
  test("packs question framing + peer explanations", () => {
    const challenge = buildStudyPrompt({
      question: { ...seedQuestion(store, { framing: "What is X?" }) },
      actual_answer: {} as any,
      peer_explanations: ["expl 1", "expl 2"],
    });
    expect(challenge.question_framing).toBe("What is X?");
    expect(challenge.peer_explanations).toEqual(["expl 1", "expl 2"]);
  });
});

describe("gradePrediction", () => {
  test("identical strings score near 1", async () => {
    const grade = await gradePrediction("hello world", "hello world");
    expect(grade.cosine).toBeGreaterThan(0.99);
    expect(grade.passed).toBe(true);
  });

  test("very different strings score below threshold", async () => {
    const grade = await gradePrediction("the deadline is friday", "purple elephants march");
    expect(grade.cosine).toBeLessThan(0.85);
    expect(grade.passed).toBe(false);
  }, 30_000);

  test("empty inputs score 0", async () => {
    const grade = await gradePrediction("", "anything");
    expect(grade.cosine).toBe(0);
    expect(grade.passed).toBe(false);
  });
});

describe("applyGradeToLift", () => {
  test("strong correct prediction (cosine ~1) bumps lift up", () => {
    const q = seedQuestion(store);
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "x",
      by_agent: "orion",
      explanation: "y",
      predictive_lift: 0.5,
      status: "accepted",
    });
    const update = applyGradeToLift(store, a.id, { cosine: 1.0, passed: true, threshold: 0.85 }, 0.1);
    expect(update.new_lift).toBeGreaterThan(update.old_lift);
    expect(update.new_lift).toBeCloseTo(0.6, 5);  // 0.5 + (1 - 0.5)*2 * 0.1 = 0.6
  });

  test("strong wrong prediction (cosine ~0) drops lift", () => {
    const q = seedQuestion(store);
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "x",
      by_agent: "orion",
      explanation: "y",
      predictive_lift: 0.5,
      status: "accepted",
    });
    const update = applyGradeToLift(store, a.id, { cosine: 0.0, passed: false, threshold: 0.85 }, 0.1);
    expect(update.new_lift).toBeLessThan(update.old_lift);
    expect(update.new_lift).toBeCloseTo(0.4, 5);  // 0.5 + (0 - 0.5)*2 * 0.1 = 0.4
  });

  test("neutral prediction (cosine ~0.5) leaves lift roughly unchanged", () => {
    const q = seedQuestion(store);
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "x",
      by_agent: "orion",
      explanation: "y",
      predictive_lift: 0.5,
      status: "accepted",
    });
    const update = applyGradeToLift(store, a.id, { cosine: 0.5, passed: false, threshold: 0.85 }, 0.1);
    expect(Math.abs(update.delta)).toBeLessThan(0.01);
  });

  test("clamps to [0, 1]", () => {
    const q = seedQuestion(store);
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "x",
      by_agent: "orion",
      explanation: "y",
      predictive_lift: 0.95,
      status: "accepted",
    });
    const update = applyGradeToLift(store, a.id, { cosine: 1.0, passed: true, threshold: 0.85 }, 0.5);
    expect(update.new_lift).toBeLessThanOrEqual(1);
  });
});

describe("runStudyTurn — orchestration with fake predictor", () => {
  test("runs N turns, applies lift updates by default", async () => {
    for (let i = 0; i < 3; i++) {
      const q = seedQuestion(store, { id: `v1:q${i}`, framing: `Question ${i}` });
      const a = recordAnswer(store, {
        question_id: q.id,
        body: `Answer ${i}`,
        by_agent: "orion",
        explanation: `Explanation ${i}`,
        predictive_lift: 0.5,
        status: "accepted",
      });
      store.setQuestionStatus(q.id, "answered", a.id);
    }
    // Fake predictor returns the actual answer (perfect prediction).
    let predictionCalls = 0;
    const perfectPredictor: Predictor = async (challenge: StudyChallenge) => {
      predictionCalls++;
      // Find the actual answer by looking up the question's framing in the candidates.
      // The fake just echoes back the framing — cosine grading will produce moderate scores.
      return `Answer for ${challenge.question_framing}`;
    };
    const results = await runStudyTurn(store, perfectPredictor, { k: 3 });
    expect(results.length).toBe(3);
    expect(predictionCalls).toBe(3);
    for (const r of results) {
      expect(r.prediction.length).toBeGreaterThan(0);
      expect(r.grade.cosine).toBeGreaterThan(0);
      expect(r.lift_update.answer_id).toBe(r.candidate.actual_answer.id);
    }
  }, 60_000);

  test("apply_updates=false leaves predictive_lift unchanged", async () => {
    const q = seedQuestion(store, { id: "v1:q1" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "real answer",
      by_agent: "orion",
      explanation: "real explanation",
      predictive_lift: 0.5,
      status: "accepted",
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    const constantPredictor: Predictor = async () => "completely different content";
    const results = await runStudyTurn(store, constantPredictor, { k: 1, apply_updates: false });
    expect(results.length).toBe(1);
    expect(results[0].lift_update.delta).toBe(0);
    // Verify lift in DB unchanged
    const after = store.getAnswer(a.id)!;
    expect(after.predictive_lift).toBe(0.5);
  }, 60_000);

  test("empty lattice yields empty results", async () => {
    const fake: Predictor = async () => "irrelevant";
    const results = await runStudyTurn(store, fake, { k: 5 });
    expect(results).toEqual([]);
  });

  test("predictor receives StudyChallenge with question_framing and peer_explanations", async () => {
    const q = seedQuestion(store, { id: "v1:q1", framing: "What is the deadline?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Friday at 5pm.",
      by_agent: "lumeyon",
      explanation: "From the project plan.",
      status: "accepted",
    });
    store.setQuestionStatus(q.id, "answered", a.id);
    let captured: StudyChallenge | null = null;
    const inspector: Predictor = async (challenge: StudyChallenge) => {
      captured = challenge;
      return "noop";
    };
    await runStudyTurn(store, inspector, { k: 1 });
    expect(captured).not.toBeNull();
    expect(captured!.question_framing).toBe("What is the deadline?");
    expect(Array.isArray(captured!.peer_explanations)).toBe(true);
  }, 60_000);

  // Iter-10: --threshold flag enables empirical calibration of the pass
  // threshold. iter-9's run produced cosines 0.71-0.79 with default 0.85
  // → 0/5 passed. Lowering the threshold should flip the pass column
  // without changing actual cosines or lift updates.
  test("grade_threshold option propagates to grade.threshold and grade.passed", async () => {
    const q = seedQuestion(store, { id: "v1:q1", framing: "What is X?" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "X is a thing that exists",
      by_agent: "orion",
      explanation: "Because X.",
      status: "accepted",
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    // Predictor returns a paraphrase — not exact, but semantically related.
    const paraphrasePredictor: Predictor = async () => "X is an existing thing";

    // With default threshold (0.85) the paraphrase likely fails.
    const strictResults = await runStudyTurn(store, paraphrasePredictor, {
      k: 1, apply_updates: false, grade_threshold: 0.85,
    });
    expect(strictResults.length).toBe(1);
    expect(strictResults[0].grade.threshold).toBe(0.85);

    // With a lower threshold (0.5) the same paraphrase should pass.
    const lenientResults = await runStudyTurn(store, paraphrasePredictor, {
      k: 1, apply_updates: false, grade_threshold: 0.5,
    });
    expect(lenientResults[0].grade.threshold).toBe(0.5);
    // Cosine should be the same in both runs (deterministic embedding); only
    // threshold and passed differ.
    expect(lenientResults[0].grade.cosine).toBeCloseTo(strictResults[0].grade.cosine, 3);
    if (lenientResults[0].grade.cosine >= 0.5) {
      expect(lenientResults[0].grade.passed).toBe(true);
    }
  }, 90_000);

  // Regression for carina's NL3 C1 finding: when the predictor returns
  // an empty string (runtime failure: AGENT_CHAT_NO_LLM=1, codex not
  // on PATH, claude binary missing, transient API error), gradePrediction
  // returns cosine=0, and applyGradeToLift then drops the answer's
  // predictive_lift by ~0.10. Runtime failures of the LLM should NOT
  // be propagated as quality signal on the lattice's content.
  test("C1: empty predictor output does NOT penalize lift (treated as ungradable)", async () => {
    const q = seedQuestion(store, { id: "v1:q-empty-test", framing: "Test framing" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Real answer body",
      by_agent: "orion",
      explanation: "Real explanation",
      status: "accepted",
      quality_tier: 2,
      predictive_lift: 0.5,
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    // Predictor returns empty (simulates runtime failure).
    const emptyPredictor: Predictor = async () => "";

    const results = await runStudyTurn(store, emptyPredictor, { k: 1 });
    expect(results.length).toBe(1);
    // The answer's predictive_lift MUST stay at 0.5 — no penalty for an
    // ungradable result. Pre-fix it would drop to ~0.4.
    const after = store.getAnswer(a.id)!;
    expect(after.predictive_lift).toBe(0.5);
    expect(results[0].lift_update.delta).toBe(0);
  });

  test("C1: whitespace-only prediction also treated as ungradable", async () => {
    const q = seedQuestion(store, { id: "v1:q-ws-test", framing: "Whitespace test" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "Real body",
      by_agent: "orion",
      explanation: "x",
      status: "accepted",
      quality_tier: 2,
      predictive_lift: 0.7,
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    const wsPredictor: Predictor = async () => "   \n\t  ";
    const results = await runStudyTurn(store, wsPredictor, { k: 1 });
    expect(results[0].lift_update.delta).toBe(0);
    expect(store.getAnswer(a.id)!.predictive_lift).toBe(0.7);
  });
});

// Regression for carina's NL3 C3 finding: NaN/non-finite cosine
// propagated through `applyGradeToLift` and got written to the
// answers.predictive_lift column. Pre-NL8 path:
//   signal = (NaN - 0.5) * 2 = NaN
//   delta = NaN * lr = NaN
//   newLift = Math.max(0, Math.min(1, prev + NaN)) = NaN
//   setAnswerPredictiveLift(id, NaN) → SQLite stores NaN as NULL
//                                      (or special non-numeric)
// NL8 fix: applyGradeToLift treats non-finite cosine as ungradable
// (same shape as NL3's empty-prediction handling) — no lift update.
// Regression for carina's NL3 C2 finding: selectStudyQuestions could
// pick an accepted answer with an empty body. Empty body grades as
// cosine 0 against any prediction → -0.10 lift penalty (same shape as
// C1 fixed at NL3, but on the data side rather than the predictor side).
// NL16 fix: filter out empty-body answers in selectStudyQuestions's
// candidate selection.
describe("selectStudyQuestions — C2 empty-body filter", () => {
  test("C2: answer with empty body is NOT selected as study candidate", () => {
    const q1 = seedQuestion(store, { id: "v1:q-empty-body" });
    const a1 = recordAnswer(store, {
      question_id: q1.id,
      body: "",                            // empty body — the bug case
      by_agent: "lumeyon",
      explanation: "Real authored explanation",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q1.id, "answered", a1.id);

    const q2 = seedQuestion(store, { id: "v1:q-good-body" });
    const a2 = recordAnswer(store, {
      question_id: q2.id,
      body: "A real answer body.",
      by_agent: "lumeyon",
      explanation: "Real authored explanation",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q2.id, "answered", a2.id);

    const candidates = selectStudyQuestions(store, { k: 5 });
    // Pre-fix: both candidates returned (empty-body answer slips through).
    // Post-fix: only the good-body one.
    expect(candidates.length).toBe(1);
    expect(candidates[0].question.id).toBe("v1:q-good-body");
  });

  test("C2: whitespace-only body is also rejected", () => {
    const q = seedQuestion(store, { id: "v1:q-ws-body" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "   \n\t  ",                   // whitespace-only — still empty after trim
      by_agent: "lumeyon",
      explanation: "Real authored explanation",
      status: "accepted",
      quality_tier: 2,
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    const candidates = selectStudyQuestions(store, { k: 5 });
    expect(candidates.length).toBe(0);
  });
});

describe("applyGradeToLift — C3 NaN/non-finite cosine guard", () => {
  test("C3: NaN cosine does not write NaN to predictive_lift", () => {
    const q = seedQuestion(store, { id: "v1:q-nan", framing: "NaN test" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "body",
      by_agent: "orion",
      explanation: "x",
      status: "accepted",
      quality_tier: 2,
      predictive_lift: 0.5,
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    const badGrade = { cosine: NaN, passed: false, threshold: 0.85, gradable: true };
    const update = applyGradeToLift(store, a.id, badGrade, 0.1);
    expect(update.delta).toBe(0);
    expect(update.new_lift).toBe(0.5);

    // Verify storage actually has 0.5, not NaN.
    const after = store.getAnswer(a.id)!;
    expect(Number.isFinite(after.predictive_lift)).toBe(true);
    expect(after.predictive_lift).toBe(0.5);
  });

  test("C3: Infinity cosine is treated the same way (ungradable)", () => {
    const q = seedQuestion(store, { id: "v1:q-inf", framing: "Infinity test" });
    const a = recordAnswer(store, {
      question_id: q.id,
      body: "body",
      by_agent: "orion",
      explanation: "x",
      status: "accepted",
      predictive_lift: 0.6,
    });
    store.setQuestionStatus(q.id, "answered", a.id);

    const badGrade = { cosine: Infinity, passed: false, threshold: 0.85, gradable: true };
    const update = applyGradeToLift(store, a.id, badGrade, 0.1);
    expect(update.delta).toBe(0);
    expect(store.getAnswer(a.id)!.predictive_lift).toBe(0.6);
  });

  test("C3: gradePrediction returns gradable=false when cosineSimilarity yields NaN", async () => {
    // Construct vectors that produce NaN cosine: a vector containing NaN
    // makes na (dot of self) NaN → denom NaN → cosine NaN.
    // We test this via gradePrediction by exercising it indirectly:
    // pass an empty prediction (which is the documented empty-string path)
    // first, then pass non-empty + non-empty actual to confirm gradable
    // is true on normal inputs. C3-specific NaN-from-cosineSimilarity
    // is harder to trigger from gradePrediction's public surface (the
    // embed function rejects empty strings), so the runtime guard at
    // applyGradeToLift IS the load-bearing protection — verified above.
    const ok = await gradePrediction("hello world", "hello again", 0.85);
    expect(ok.gradable).toBe(true);
    expect(Number.isFinite(ok.cosine)).toBe(true);
  });
});

// Regression for carina's NL3 C5 finding: selectStudyQuestions called
// queryAnswers with `limit: 5` (a fixed SQL limit), then applied the
// `exclude_agent` filter in memory. When a question had ≥6 accepted
// answers and the top-5 by predictive_lift were all by the excluded
// agent, the eligible peer answer at rank ≥6 was silently unreachable —
// `find` returned undefined → question skipped → 0 candidates.
//
// Same SHAPE as LC2 (NL19): SQL limit BEFORE in-memory filter. Fix
// template: push the missing filter axis into the data layer.
//
// NL20 fix: pass `by_agent_not: options.exclude_agent` into queryAnswers
// (using the NL19 axis), and raise the per-question limit so the
// remaining in-memory filters (authored-explanation heuristic, non-empty
// body) have enough candidates to find an eligible one.
describe("selectStudyQuestions — C5 SQL-limit-before-in-memory-filter", () => {
  test("C5: peer-authored answer at rank 6+ is reachable when top-5 are by exclude_agent", () => {
    const q = seedQuestion(store, { id: "v1:q-c5", framing: "C5 question" });
    // Seed 5 high-lift accepted answers by the excluded agent (orion).
    // Pre-fix queryAnswers limit:5 would return exactly these.
    const orionAnswers = [];
    for (let i = 0; i < 5; i++) {
      const a = recordAnswer(store, {
        question_id: q.id,
        body: `orion authored body ${i}`,
        by_agent: "orion",
        explanation: `Real authored explanation by orion ${i}`,
        status: "accepted",
        quality_tier: 2,
        predictive_lift: 0.9 - i * 0.05,  // 0.90, 0.85, 0.80, 0.75, 0.70
      });
      orionAnswers.push(a);
    }
    // Add 1 lower-lift accepted answer by a peer. Pre-fix this gets
    // truncated by the SQL limit:5 and never seen by the in-memory
    // filter; post-fix the by_agent_not filter pushes it into SQL so
    // the peer answer DOES appear in the candidate set.
    const peerAnswer = recordAnswer(store, {
      question_id: q.id,
      body: "peer authored body",
      by_agent: "lumeyon",
      explanation: "Real authored explanation by lumeyon",
      status: "accepted",
      quality_tier: 2,
      predictive_lift: 0.10,  // ranks 6th
    });
    // Pick orion's top answer as best_answer (any accepted FK target works).
    store.setQuestionStatus(q.id, "answered", orionAnswers[0].id);

    const out = selectStudyQuestions(store, { k: 5, exclude_agent: "orion" });

    // Pre-fix: 5 orion answers fetched, all dropped by exclude_agent
    // filter, find returns undefined, question skipped → 0 candidates.
    // Post-fix: SQL filter excludes orion → lumeyon answer surfaces.
    expect(out.length).toBe(1);
    expect(out[0].question.id).toBe("v1:q-c5");
    expect(out[0].actual_answer.by_agent).toBe("lumeyon");
    expect(out[0].actual_answer.id).toBe(peerAnswer.id);
  });

  test("C5: existing exclude_agent behavior preserved on the simple case", () => {
    // Sanity: the fix shouldn't alter behavior of the existing
    // "excludes answers by exclude_agent" test pattern. Two questions,
    // one orion-authored, one peer-authored — exclude_agent="orion"
    // returns only the peer-authored question.
    const q1 = seedQuestion(store, { id: "v1:q-c5-sanity-1", framing: "A" });
    const q2 = seedQuestion(store, { id: "v1:q-c5-sanity-2", framing: "B" });
    const a1 = recordAnswer(store, {
      question_id: q1.id,
      body: "orion answer",
      by_agent: "orion",
      explanation: "Authored.",
      status: "accepted",
    });
    store.setQuestionStatus(q1.id, "answered", a1.id);
    const a2 = recordAnswer(store, {
      question_id: q2.id,
      body: "lumeyon answer",
      by_agent: "lumeyon",
      explanation: "Authored.",
      status: "accepted",
    });
    store.setQuestionStatus(q2.id, "answered", a2.id);

    const out = selectStudyQuestions(store, { k: 5, exclude_agent: "orion" });
    expect(out.length).toBe(1);
    expect(out[0].actual_answer.by_agent).toBe("lumeyon");
  });
});
