// Phase 7 — Apprenticeship Substrate forcing functions, layered on the
// LatticeStore.
//
// Per docs/apprenticeship-substrate.md the substrate has five forcing
// functions; this module is where the protocol-level enforcement lives:
//
//   1. Dual-output every turn        → recordAnswer() requires explanation
//   2. Mandatory study turns         → runStudyTurn() (deferred — needs agent runtime)
//   3. Selection pressure on explanations → reRankAnswers() (in this module)
//   4. Cross-domain push             → pushContext() (in this module)
//   5. Every artifact training-data-shaped → already in the schema (Phase 5/6)
//
// What's in this iteration:
//   - recordAnswer  — dual-output enforcement (function 1)
//   - pushContext   — cross-domain push retrieval (function 4)
//   - reRankAnswers — selection pressure / status promotion (function 3)
//
// Deferred to a later iteration:
//   - runStudyTurn  — needs agent-runtime integration (claude/codex shell-out)

import {
  embed,
  cosineSimilarity,
} from "../../plugins/agent-chat/scripts/embed.ts";
import type { Answer, Question, QualityTier } from "./types.ts";
import type { LatticeStore } from "./sqlite-store.ts";
import { makeAnswerId } from "./sqlite-store.ts";

// ─── Forcing function #1 — dual-output every turn ──────────────────────────

export interface RecordAnswerInput {
  question_id: string;
  body: string;
  by_agent: string;
  /** REQUIRED — the apprenticeship substrate's dual-output. The "WHY"
   *  written for a hypothetical novice peer. Must be non-empty. */
  explanation: string;
  predictive_lift?: number;
  status?: Answer["status"];
  quality_tier?: QualityTier;
  validator_id?: string | null;
  created_at?: number;
}

/**
 * The apprenticeship-substrate-aware way to add an answer to the lattice.
 * Enforces dual-output (every Answer ships with a non-empty explanation).
 *
 * Why this is enforced here and not in the SQL CHECK constraint:
 * SQL would reject NULL but allow empty strings or whitespace-only
 * explanations. The forcing function is about MEANINGFUL reflection,
 * which is closer to "non-trivial text" than "non-null." This wrapper
 * checks for that.
 */
export function recordAnswer(store: LatticeStore, input: RecordAnswerInput): Answer {
  const explanation = input.explanation;
  if (typeof explanation !== "string" || explanation.trim().length === 0) {
    throw new Error(
      "Apprenticeship Substrate forcing function 1 (dual-output): every Answer " +
      "must include a non-empty `explanation` describing WHY this answers " +
      "the question. See docs/apprenticeship-substrate.md §1 for the contract.",
    );
  }
  const answer: Answer = {
    id: makeAnswerId(input.question_id, input.body, input.by_agent),
    question_id: input.question_id,
    body: input.body,
    explanation,
    by_agent: input.by_agent,
    predictive_lift: input.predictive_lift ?? 0,
    status: input.status ?? "proposed",
    quality_tier: input.quality_tier ?? 5,
    created_at: input.created_at ?? Math.floor(Date.now() / 1000),
    validator_id: input.validator_id ?? null,
  };
  store.putAnswer(answer);
  return answer;
}

// ─── Forcing function #4 — cross-domain push ──────────────────────────────

export interface PushContextOptions {
  /** Top-K most-relevant answered priors to return. Default 5. */
  k?: number;
  /** Filter to answered questions only (default true). */
  answered_only?: boolean;
  /** Minimum quality tier for answers (1=gold, 5=raw). Default 5 (no filter). */
  quality_tier_min?: QualityTier;
  /** Minimum predictive_lift for answers. Default 0 (no filter). */
  predictive_lift_min?: number;
  /** Optionally restrict by who posed the question. */
  posed_by?: string;
  /** Optional embedding cache (precomputed) keyed by question.id, to skip
   *  re-embedding every question on every call. Useful when many pushes
   *  in a session reuse the same question pool. */
  question_embeddings?: Map<string, Float32Array>;
}

export interface PushContextHit {
  question: Question;
  /** The accepted Answer if status='answered'/'closed'; null if no accepted answer. */
  best_answer: Answer | null;
  /** Cosine similarity between query and question framing. */
  cosine: number;
}

/**
 * Cross-domain push: given a fresh query, return the top-K most-similar
 * prior answered questions and their best answers. The agent's prompt
 * pre-pends these so context is pushed automatically — no "remember to
 * query" affordance required.
 *
 * v1 implementation: linear scan over candidate questions with cosine
 * similarity. O(N) but adequate for hundreds-to-thousands of questions.
 * Future v2 swap: HNSW-backed index for sub-linear retrieval.
 */
export async function pushContext(
  store: LatticeStore,
  query: string,
  options: PushContextOptions = {},
): Promise<PushContextHit[]> {
  const k = options.k ?? 5;
  const answeredOnly = options.answered_only ?? true;

  // Get the candidate question pool.
  const candidates = store.queryQuestions({
    status: answeredOnly ? ["answered", "closed"] : undefined,
    posed_by: options.posed_by,
    limit: 10_000,  // big upper bound; replace with HNSW for true scale
  });

  if (candidates.length === 0) return [];

  // Embed the query once.
  const queryEmb = await embed(query);

  // Embed candidate framings (or pull from precomputed cache).
  const cache = options.question_embeddings ?? new Map<string, Float32Array>();
  const ranked: { question: Question; cosine: number }[] = [];
  for (const q of candidates) {
    let qEmb = cache.get(q.id);
    if (!qEmb) {
      qEmb = await embed(q.framing);
      cache.set(q.id, qEmb);
    }
    const sim = cosineSimilarity(queryEmb, qEmb);
    ranked.push({ question: q, cosine: sim });
  }

  // Sort DESC by cosine and take top-K.
  ranked.sort((a, b) => b.cosine - a.cosine);
  const topK = ranked.slice(0, k);

  // Attach the best answer for each.
  return topK.map((hit) => {
    let best_answer: Answer | null = null;
    if (hit.question.best_answer_id) {
      best_answer = store.getAnswer(hit.question.best_answer_id);
    } else {
      // Fall back to the highest-predictive-lift accepted answer for this question.
      const accepted = store.queryAnswers({
        question_id: hit.question.id,
        status: "accepted",
        quality_tier_min: options.quality_tier_min,
        predictive_lift_min: options.predictive_lift_min,
        order_by: "predictive_lift_desc",
        limit: 1,
      });
      best_answer = accepted[0] ?? null;
    }
    return { question: hit.question, best_answer, cosine: hit.cosine };
  });
}

// ─── Forcing function #3 — selection pressure / re-ranking ─────────────────

export interface ReRankResult {
  question_id: string;
  promoted_to_accepted: string | null;  // answer.id, if any
  demoted_to_superseded: string[];      // answer.ids, possibly empty
}

/**
 * Re-rank the answers for a single question by predictive_lift and update
 * statuses to reflect competition outcomes.
 *
 * Rules:
 *   - The HIGHEST predictive_lift answer becomes status='accepted' if it
 *     beats any other answer's lift by `margin` or more.
 *   - Other 'accepted' answers (if any) become 'superseded'.
 *   - 'refuted' answers stay refuted regardless of lift.
 *   - Questions with only one proposed answer don't auto-promote unless
 *     `single_answer_promotes` is true.
 *
 * Returns a summary of what changed; idempotent — running twice is safe.
 */
export function reRankAnswers(
  store: LatticeStore,
  question_id: string,
  options: { margin?: number; single_answer_promotes?: boolean } = {},
): ReRankResult {
  const margin = options.margin ?? 0.05;

  // Sort all answers for this question by predictive_lift desc, ignore refuted.
  const all = store.queryAnswers({ question_id, order_by: "predictive_lift_desc" });
  const live = all.filter((a) => a.status !== "refuted");

  if (live.length === 0) {
    return { question_id, promoted_to_accepted: null, demoted_to_superseded: [] };
  }

  if (live.length === 1) {
    if (options.single_answer_promotes && live[0].status === "proposed") {
      // Single answer with a non-trivial predictive_lift — promote.
      // If lift is 0, leave as proposed (no signal).
      if (live[0].predictive_lift > 0) {
        promote(store, live[0]);
        return { question_id, promoted_to_accepted: live[0].id, demoted_to_superseded: [] };
      }
    }
    return { question_id, promoted_to_accepted: null, demoted_to_superseded: [] };
  }

  // Multiple live answers. Top one wins iff its lift exceeds runner-up by margin.
  const top = live[0];
  const runnerUp = live[1];
  if (top.predictive_lift - runnerUp.predictive_lift < margin) {
    // Tie or near-tie. No promotion; existing accepted (if any) stays.
    return { question_id, promoted_to_accepted: null, demoted_to_superseded: [] };
  }

  // Promote top, demote any other accepted.
  let promoted: string | null = null;
  const demoted: string[] = [];
  for (const a of live) {
    if (a.id === top.id) {
      if (a.status !== "accepted") {
        promote(store, a);
        promoted = a.id;
      }
    } else if (a.status === "accepted") {
      supersede(store, a);
      demoted.push(a.id);
    }
  }

  // Update the question's best_answer_id and lifecycle.
  const q = store.getQuestion(question_id);
  if (q && (q.best_answer_id !== top.id || q.status === "open")) {
    store.setQuestionStatus(question_id, "answered", top.id);
  }

  return { question_id, promoted_to_accepted: promoted, demoted_to_superseded: demoted };
}

function promote(store: LatticeStore, answer: Answer): void {
  store.setAnswerStatus(answer.id, "accepted");
}

function supersede(store: LatticeStore, answer: Answer): void {
  store.setAnswerStatus(answer.id, "superseded");
}
