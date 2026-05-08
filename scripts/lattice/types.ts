// Shared types for the Inquiry Lattice's Question/Answer model.
//
// Per docs/inquiry-lattice.md §3 and the dual-audience fusion commitment,
// every artifact carries the SAME provenance and quality fields whether
// stored for agent retrieval or exported for buyer training corpora.
//
// canonical_id format: `v<N>:<hash>` (per docs/canonical-equivalence-spec.md
// §5). Produced by Candidate A in v1.

export type QuestionStatus = "open" | "answered" | "closed" | "reopened";
export type AnswerStatus = "proposed" | "accepted" | "superseded" | "refuted";

/** Quality tier per docs/inquiry-lattice.md "Dual-audience fusion".
 * 1 = top-shelf human-verified gold standard (highest quality)
 * 2 = peer-validated, high predictive lift
 * 3 = standard agent contribution with positive validation signals
 * 4 = lightly validated; usable but not premium
 * 5 = raw lattice contribution, unvalidated (lowest quality)
 *
 * Numeric ordering is INVERTED from quality ordering: lower numbers are
 * better. The `quality_tier_min` filter parameter takes the WORST numeric
 * tier you'll accept (which equals the MIN quality tier you'll accept).
 *
 * Used by:
 * - Agent retrieval: pass `quality_tier_min: 3` for high-stakes contexts
 *   (returns tiers 1-3 — the top three quality levels — and excludes 4,5).
 *   Internally this becomes SQL `quality_tier <= 3`.
 * - Buyer pricing: tier 1 datasets cost more than tier 4.
 */
export type QualityTier = 1 | 2 | 3 | 4 | 5;

export interface Question {
  /** canonical_id from Candidate A's normalize() — `v<N>:<hash>`. */
  id: string;
  /** Original question text (pre-normalization). */
  framing: string;
  /** Status in the inquiry lifecycle. */
  status: QuestionStatus;
  /** Pointer into answers.id when status is "answered" or "closed". */
  best_answer_id: string | null;
  /** Unix epoch seconds when posed. */
  posed_at: number;
  /** Agent or human name who posed it. */
  posed_by: string;
  /** Free-form context — typically an edge_root path or a parent question id. */
  posed_in_context: string | null;
  /** Composition depth. 0 = root question; 1+ = sub-question of a parent. */
  depth: number;
}

export interface Answer {
  /** sha256(question_id + body + by_agent) — content-identity. */
  id: string;
  question_id: string;
  body: string;
  /** Apprenticeship Substrate's dual-output: WHY this answers it.
   *  Required and non-empty (whitespace-trimmed). Enforced at runtime
   *  by both `recordAnswer` (apprenticeship.ts) and `putAnswer`
   *  (sqlite-store.ts) so callers cannot bypass the invariant by
   *  going around the apprenticeship API. The SQL schema column is
   *  still TEXT (nullable in DDL) for backwards-compat with existing
   *  databases; tightening to NOT NULL requires a migration step
   *  pending boss approval — see docs/lattice-alt-a-progress.md. */
  explanation: string;
  by_agent: string;
  /** Running score updated by peer study turns. */
  predictive_lift: number;
  status: AnswerStatus;
  quality_tier: QualityTier;
  /** Unix epoch seconds when produced. */
  created_at: number;
  /** Optional validator agent name (for tier 1 gold-standard). */
  validator_id: string | null;
}

/** Citation = directed edge in the answer DAG.
 *  parent answer cites child answer (i.e., child answer composes into parent).
 */
export interface Citation {
  parent_answer_id: string;
  child_answer_id: string;
}

/** Question DAG — a question can be a sub-question of multiple parents. */
export interface QuestionParent {
  parent_question_id: string;
  child_question_id: string;
}

// ─── Query types ───────────────────────────────────────────────────────────

export interface QuestionFilter {
  status?: QuestionStatus | QuestionStatus[];
  posed_by?: string;
  posed_at_after?: number;       // unix epoch seconds
  posed_at_before?: number;
  depth?: number;
  depth_min?: number;
  depth_max?: number;
  /** Limit results. Default 100. */
  limit?: number;
  /** Sort by posed_at DESC by default. */
  order_by?: "posed_at_desc" | "posed_at_asc";
}

export interface AnswerFilter {
  question_id?: string;
  by_agent?: string;
  /** EXCLUDE answers authored by this agent. Used by pushContext to
   *  drop the calling agent's own answers from cross-domain push so the
   *  agent doesn't see its own past words pushed back as "prior knowledge."
   *  LC2 fix (NL19): pushed into AnswerFilter (replacing the in-memory
   *  filter in lattice-context.ts) so the SQL-side filter is applied at
   *  retrieval, not after slicing — eligible peer hits no longer get
   *  dropped when the calling agent dominates the top of the cosine ranking. */
  by_agent_not?: string;
  status?: AnswerStatus | AnswerStatus[];
  quality_tier_min?: QualityTier;
  predictive_lift_min?: number;
  limit?: number;
  order_by?: "predictive_lift_desc" | "created_at_desc" | "created_at_asc";
}
