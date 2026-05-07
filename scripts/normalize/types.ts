// Shared types for canonical-normalization candidates.
//
// Per docs/inquiry-lattice.md "Lattice-as-normalizer" section: the v1 winning
// candidate must be PLUGGABLE so tier-1 lattice queries can hook in for v2.
// Closed-form black-box normalizers are disfavored. The Normalizer interface
// below is intentionally narrow but extensible — implementations can expose
// internal state (e.g. the synonym dictionary, the lemma map) via meta.
//
// Canonical_id format is `v<N>:<hash>` per docs/canonical-equivalence-spec.md
// §5. Versioning is mandatory; we never ship a canonical_id without it.

export interface NormalizeResult {
  /** The canonical ID for this question. Format: v<N>:<hash>. */
  canonical_id: string;
  /** The normalized form (string) — what produced the hash. */
  normalized: string;
  /** Optional: confidence in [0,1] for fuzzy/embedding-based candidates. */
  confidence?: number;
  /** Optional: per-candidate diagnostic data. */
  meta?: Record<string, unknown>;
}

export interface Normalizer {
  /** Stable identifier for this candidate, e.g. "candidate-A". */
  readonly id: string;
  /** Version tag baked into canonical_id (e.g. "v1"). Versioning is mandatory. */
  readonly version: string;
  /**
   * Run normalization on a question. Async to accommodate
   * embedding-based candidates (the MiniLM model loads on first call).
   * String-only candidates can wrap their result in Promise.resolve.
   */
  normalize(q: string): Promise<NormalizeResult>;
  /**
   * Compare two questions; return whether they should be treated as
   * equivalent under this candidate's policy. Default implementations
   * compare canonical_id. Embedding-based candidates override to
   * use cosine similarity.
   */
  equivalent(q1: string, q2: string): Promise<boolean>;
}

/**
 * Default equivalence: same canonical_id. Most string-based candidates use
 * this. Embedding-based candidates override.
 */
export async function defaultEquivalent(n: Normalizer, q1: string, q2: string): Promise<boolean> {
  const [r1, r2] = await Promise.all([n.normalize(q1), n.normalize(q2)]);
  return r1.canonical_id === r2.canonical_id;
}
