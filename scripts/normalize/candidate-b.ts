// Candidate B — pure embedding cosine threshold.
//
// No string normalization beyond minimal preprocessing. Equivalence is
// determined by cosine similarity between embeddings of the (lightly
// normalized) inputs. Threshold θ = 0.92 per spec D6.
//
// Tradeoff: catches deeper paraphrase equivalence than Candidate A's
// rule-based approach (e.g., voice changes, tag-question word-order
// differences) but risks false-merges on hard negatives where surface
// similarity outweighs semantic difference (negation, polarity, scope).
//
// canonical_id strategy: minimal text normalization (NFKC + lowercase +
// trim) is hashed for the canonical_id. Equivalence is determined by
// cosine, NOT by canonical_id match. This means: B's canonical_id is
// largely a grouping convenience; the real test is equivalent().
//
// The lattice (when integrated) will use canonical_id for clustering at
// the leaf and cosine for fuzzy match within clusters.

import * as crypto from "node:crypto";
import {
  embed,
  embedBatch,
  cosineSimilarity,
} from "../../plugins/agent-chat/scripts/embed.ts";
import type { Normalizer, NormalizeResult } from "./types.ts";

// Per docs/canonical-equivalence-spec.md §4 D6.
// Tunable based on Phase 4 scoring; precision-first default.
export const THETA_V1 = 0.92;

// Minimal text preprocessing applied before embedding. Just enough to
// fold trivial surface variation (case + whitespace) so identical
// questions in different cases don't waste embedding compute.
function preEmbed(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Tiny LRU cache of embeddings keyed by preprocessed text. Keeps
// repeated equivalent() calls fast (e.g., during scoring against a
// corpus where the same q1 appears in many pairs).
const embedCache = new Map<string, Float32Array>();
const MAX_CACHE = 4096;

async function cachedEmbed(q: string): Promise<Float32Array> {
  const key = preEmbed(q);
  const hit = embedCache.get(key);
  if (hit) {
    // Move-to-front by deleting and re-inserting (preserves LRU order).
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  const e = await embed(key);
  if (embedCache.size >= MAX_CACHE) {
    // Evict oldest (Map iteration is insertion order).
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, e);
  return e;
}

// Allow callers to seed the cache in batch — useful for scoring runs
// where we have all questions upfront and want one batch embedding call
// instead of N sequential calls.
export async function preloadCache(questions: string[]): Promise<void> {
  const unique = [...new Set(questions.map(preEmbed))];
  const missing = unique.filter((q) => !embedCache.has(q));
  if (missing.length === 0) return;
  const embs = await embedBatch(missing);
  missing.forEach((q, i) => {
    if (embedCache.size >= MAX_CACHE) {
      const oldest = embedCache.keys().next().value;
      if (oldest !== undefined) embedCache.delete(oldest);
    }
    embedCache.set(q, embs[i]);
  });
}

export const candidateB: Normalizer = {
  id: "candidate-B",
  version: "v1",

  async normalize(q: string): Promise<NormalizeResult> {
    const normalized = preEmbed(q);
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return {
      canonical_id: `${this.version}:${hash}`,
      normalized,
      meta: { strategy: "embedding-cosine", theta: THETA_V1 },
    };
  },

  async equivalent(q1: string, q2: string): Promise<boolean> {
    // Identical-after-preprocessing → trivially equivalent.
    if (preEmbed(q1) === preEmbed(q2)) return true;
    const [e1, e2] = await Promise.all([cachedEmbed(q1), cachedEmbed(q2)]);
    const sim = cosineSimilarity(e1, e2);
    return sim >= THETA_V1;
  },
};

// Diagnostic: return the cosine for a pair without thresholding.
// Useful for tuning θ during Phase 4.
export async function pairCosine(q1: string, q2: string): Promise<number> {
  const [e1, e2] = await Promise.all([cachedEmbed(q1), cachedEmbed(q2)]);
  return cosineSimilarity(e1, e2);
}

// CLI: print cosine + verdict for a pair of questions.
//   bun scripts/normalize/candidate-b.ts "What is X?" "WTF is X?"
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('usage: candidate-b.ts "<q1>" "<q2>"');
    process.exit(2);
  }
  const [q1, q2] = args;
  const sim = await pairCosine(q1, q2);
  const eq = await candidateB.equivalent(q1, q2);
  console.log(`q1:           ${JSON.stringify(q1)}`);
  console.log(`q2:           ${JSON.stringify(q2)}`);
  console.log(`cosine:       ${sim.toFixed(4)}`);
  console.log(`threshold θ:  ${THETA_V1}`);
  console.log(`equivalent:   ${eq}`);
}
