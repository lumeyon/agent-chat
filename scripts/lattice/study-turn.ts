// study-turn.ts — Apprenticeship Substrate forcing function 2.
//
// Per docs/apprenticeship-substrate.md §2: every Nth turn an agent's
// next turn is a STUDY TURN — they read top-K relevant peer explanations,
// predict what those agents would have answered for similar questions,
// the prediction is graded against the actual answer, and predictive_lift
// is updated based on the grade.
//
// This module:
//   - selectStudyQuestions  — sample candidates from the lattice
//   - buildStudyPrompt      — format the study challenge as a prompt string
//   - gradePrediction       — embedding-cosine grader (fast, deterministic)
//   - applyGradeToLift      — update predictive_lift on the answer
//   - runStudyTurn          — orchestrate one batch of study turns
//   - claudePredictor / codexPredictor — built-in LLM-backed predictors
//   - Predictor (type)      — injectable for testing with a mock
//
// LLM cost: each study turn = 1 LLM call (the predictor) + 0 grader calls
// (cosine grader uses the local MiniLM, no API). Cosine grading keeps
// grading cheap so we can run many study turns without LLM budget pressure.

import { embed, cosineSimilarity } from "../../plugins/agent-chat/scripts/embed.ts";
import type { LatticeStore } from "./sqlite-store.ts";
import type { Answer, Question, QualityTier } from "./types.ts";

// ─── Predictor injection ────────────────────────────────────────────────────

export interface StudyChallenge {
  question_framing: string;
  /** Peer explanations the predictor may consult. The original answer is HIDDEN. */
  peer_explanations: string[];
  /** Optional context block (e.g. citation graph snippets). */
  context?: string;
}

/** A function that produces a predicted answer for a study challenge.
 *  Caller wires this to a real LLM (claude -p, codex exec, etc.) or a mock. */
export type Predictor = (challenge: StudyChallenge) => Promise<string>;

// ─── Built-in LLM-backed predictors ─────────────────────────────────────────

function buildPromptForPredictor(challenge: StudyChallenge): string {
  const peerBlock = challenge.peer_explanations.length > 0
    ? challenge.peer_explanations
        .map((e, i) => `Peer explanation ${i + 1}:\n${e}`)
        .join("\n\n")
    : "(No peer explanations available — answer from your own understanding.)";
  const ctx = challenge.context ? `\n\nContext:\n${challenge.context}\n` : "";
  return [
    "You are participating in an Apprenticeship Substrate study turn.",
    "Your task: predict what an experienced peer agent would have answered to this question, given the peer explanations available.",
    "Answer concisely (~3-6 sentences). Do not preface with 'I think' or 'My answer is' — just give the answer directly.",
    ctx,
    `Question: ${challenge.question_framing}`,
    "",
    peerBlock,
    "",
    "Predicted answer:",
  ].join("\n");
}

/** Predictor that shells out to claude -p via the existing runtime adapter. */
export async function claudePredictor(challenge: StudyChallenge): Promise<string> {
  const adapter = await import("../../plugins/agent-chat/scripts/runtimes/claude.ts");
  const r = await adapter.dispatch({
    prompt: buildPromptForPredictor(challenge),
    timeoutMs: 90_000,
  });
  return (r.stdout ?? "").trim();
}

/** Predictor that shells out to codex exec via the existing runtime adapter. */
export async function codexPredictor(challenge: StudyChallenge): Promise<string> {
  const adapter = await import("../../plugins/agent-chat/scripts/runtimes/codex.ts");
  const r = await adapter.dispatch({
    prompt: buildPromptForPredictor(challenge),
    timeoutMs: 90_000,
  });
  return (r.stdout ?? "").trim();
}

// ─── Selection ──────────────────────────────────────────────────────────────

export interface SelectStudyQuestionsOptions {
  k?: number;
  must_be_answered?: boolean;
  quality_tier_min?: QualityTier;
  exclude_agent?: string;
  posed_at_after?: number;
  /** When true (default), candidates must have an answer with an
   *  authored (non-auto-imported) explanation. When false, accept any
   *  non-empty explanation including auto-imported placeholders —
   *  useful for verifying wiring against an import-only lattice where
   *  no agent has written real explanations yet. */
  require_authored_explanation?: boolean;
}

export interface StudyCandidate {
  question: Question;
  /** The "actual answer" — what we'll grade the prediction against. */
  actual_answer: Answer;
  /** Peer explanations on similar/related answers (for the predictor to consult). */
  peer_explanations: string[];
}

/** Sample K candidate questions from the lattice for a study turn.
 *  Each candidate has an actual answer (hidden from the predictor) and
 *  a set of peer explanations the predictor may consult.
 */
export function selectStudyQuestions(
  store: LatticeStore,
  options: SelectStudyQuestionsOptions = {},
): StudyCandidate[] {
  const k = options.k ?? 5;
  const mustBeAnswered = options.must_be_answered ?? true;

  const candidates = store.queryQuestions({
    status: mustBeAnswered ? ["answered", "closed"] : undefined,
    posed_at_after: options.posed_at_after,
    limit: 200,
  });

  if (candidates.length === 0) return [];

  const out: StudyCandidate[] = [];
  for (const q of candidates) {
    if (out.length >= k) break;
    const answers = store.queryAnswers({
      question_id: q.id,
      status: "accepted",
      quality_tier_min: options.quality_tier_min,
      order_by: "predictive_lift_desc",
      limit: 5,
    });
    const requireAuthored = options.require_authored_explanation !== false;
    const isAuthored = (e: string | null | undefined) =>
      !!e && e.trim().length > 0 && !/auto-imported/i.test(e);
    const isAcceptable = (e: string | null | undefined) =>
      requireAuthored ? isAuthored(e) : !!e && e.trim().length > 0;

    // C2 fix (NL16 / carina NL3 finding): require non-empty body.
    // An empty body grades as cosine 0 against any prediction → -0.10
    // spurious lift penalty (same shape as C1 fixed at NL3, but on the
    // data side rather than the predictor side). recordAnswer + putAnswer
    // don't enforce non-empty body (only explanation), so empty bodies
    // can land in the lattice — selection must filter them out.
    const actual = answers.find((a) =>
      typeof a.body === "string" && a.body.trim().length > 0
      && isAcceptable(a.explanation)
      && (!options.exclude_agent || a.by_agent !== options.exclude_agent),
    );
    if (!actual) continue;

    // Peer explanations always exclude auto-imported placeholders — those
    // would just be noise in the predictor's prompt.
    const peerExplanations: string[] = answers
      .filter((a) => a.id !== actual.id && isAuthored(a.explanation))
      .map((a) => a.explanation as string);

    out.push({ question: q, actual_answer: actual, peer_explanations: peerExplanations });
  }

  return out;
}

// ─── Prompt construction ────────────────────────────────────────────────────

export function buildStudyPrompt(candidate: StudyCandidate): StudyChallenge {
  return {
    question_framing: candidate.question.framing,
    peer_explanations: candidate.peer_explanations,
    context: undefined,
  };
}

// ─── Grading ────────────────────────────────────────────────────────────────

export interface GradeResult {
  cosine: number;
  passed: boolean;
  threshold: number;
  /** False when the prediction is empty/whitespace-only or the actual is
   *  empty — there's no signal to grade against. NL3 / carina C1 fix:
   *  runtime failures of the predictor (AGENT_CHAT_NO_LLM=1, codex
   *  missing, transient API error) used to propagate as cosine=0 →
   *  -0.10 penalty on the answer's predictive_lift, falsely signaling
   *  the lattice's content as low-quality. Ungradable results MUST be
   *  skipped by callers like runStudyTurn. */
  gradable: boolean;
}

export async function gradePrediction(
  prediction: string,
  actual: string,
  threshold: number = 0.85,
): Promise<GradeResult> {
  if (!prediction.trim() || !actual.trim()) {
    return { cosine: 0, passed: false, threshold, gradable: false };
  }
  const [pe, ae] = await Promise.all([embed(prediction), embed(actual)]);
  const cosine = cosineSimilarity(pe, ae);
  return { cosine, passed: cosine >= threshold, threshold, gradable: true };
}

// ─── Lift update ────────────────────────────────────────────────────────────

export interface LiftUpdate {
  answer_id: string;
  old_lift: number;
  new_lift: number;
  delta: number;
}

/** Update predictive_lift on an answer based on a prediction's grade.
 *  Rule: lift moves toward (cosine - 0.5) * 2, scaled by learning rate.
 *  Clamped to [0, 1].
 */
export function applyGradeToLift(
  store: LatticeStore,
  answer_id: string,
  grade: GradeResult,
  learningRate: number = 0.1,
): LiftUpdate {
  const a = store.getAnswer(answer_id);
  if (!a) {
    return { answer_id, old_lift: 0, new_lift: 0, delta: 0 };
  }
  // C3 fix (NL8 / carina NL3 finding): non-finite cosine (NaN, ±Infinity)
  // must NOT propagate to predictive_lift. Pre-fix path: NaN cosine →
  // (NaN - 0.5) * 2 = NaN → delta NaN → newLift NaN → SQLite REAL bind
  // crashes on NaN (or stores Infinity as a 1.0-clamped poison value).
  // Treat non-finite cosine as ungradable: no-op, no storage write.
  // Mirrors NL3's empty-prediction ungradable pattern (function 1).
  if (!Number.isFinite(grade.cosine)) {
    return {
      answer_id,
      old_lift: a.predictive_lift,
      new_lift: a.predictive_lift,
      delta: 0,
    };
  }
  const signal = (grade.cosine - 0.5) * 2;
  const delta = signal * learningRate;
  const newLift = Math.max(0, Math.min(1, a.predictive_lift + delta));
  store.setAnswerPredictiveLift(answer_id, newLift);
  return { answer_id, old_lift: a.predictive_lift, new_lift: newLift, delta: newLift - a.predictive_lift };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface StudyTurnResult {
  candidate: StudyCandidate;
  prediction: string;
  grade: GradeResult;
  lift_update: LiftUpdate;
  elapsed_sec: number;
}

export interface RunStudyTurnOptions extends SelectStudyQuestionsOptions {
  grade_threshold?: number;
  learning_rate?: number;
  apply_updates?: boolean;
}

/** Run one full batch of study turns:
 *    1. Select K candidate questions
 *    2. For each, build prompt → call predictor → grade → optionally apply lift update
 *    3. Return per-candidate results
 */
export async function runStudyTurn(
  store: LatticeStore,
  predictor: Predictor,
  options: RunStudyTurnOptions = {},
): Promise<StudyTurnResult[]> {
  const candidates = selectStudyQuestions(store, options);
  const threshold = options.grade_threshold ?? 0.85;
  const lr = options.learning_rate ?? 0.1;
  const applyUpdates = options.apply_updates !== false;

  const results: StudyTurnResult[] = [];
  for (const candidate of candidates) {
    const t0 = Date.now();
    const challenge = buildStudyPrompt(candidate);
    const prediction = await predictor(challenge);
    const grade = await gradePrediction(prediction, candidate.actual_answer.body, threshold);
    let liftUpdate: LiftUpdate;
    // NL3 / carina C1 fix: ungradable results (empty prediction or empty
    // actual body) MUST NOT bump or penalize lift. Treat as a no-op.
    if (applyUpdates && grade.gradable) {
      liftUpdate = applyGradeToLift(store, candidate.actual_answer.id, grade, lr);
    } else {
      liftUpdate = {
        answer_id: candidate.actual_answer.id,
        old_lift: candidate.actual_answer.predictive_lift,
        new_lift: candidate.actual_answer.predictive_lift,
        delta: 0,
      };
    }
    const elapsed_sec = (Date.now() - t0) / 1000;
    results.push({ candidate, prediction, grade, lift_update: liftUpdate, elapsed_sec });
  }

  return results;
}
