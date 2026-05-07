// Candidate C — hybrid A + B.
//
// Strategy: trust Candidate A's deterministic string normalization for
// high-precision matches; fall back to Candidate B's embedding cosine
// only when A says SEPARATE but the embedding similarity is high enough
// to override.
//
// Decision flow for equivalent(q1, q2):
//
//   1. Compute A's canonical_id for both. If they match → MERGE.
//      (A is precision-first; when A says yes, we trust it.)
//   2. If A says no, compute cosine via B's preEmbed pipeline.
//      If cosine >= θ_HIGH (default 0.95, stricter than B's 0.92)
//      → MERGE (override A's verdict).
//   3. Otherwise SEPARATE.
//
// Why θ_HIGH > θ standalone? Because B alone uses 0.92 to balance
// precision vs recall. When B is acting as a TIE-BREAKER for A's
// rejection, we need higher confidence to override — A's negative
// verdict is a strong signal that the questions ARE distinct
// (different question word, different scope, etc., which A's rule
// pipeline correctly rejects). Only override when cosine is
// near-paraphrase territory.
//
// canonical_id: uses A's canonical_id verbatim. C inherits A's
// equivalence classes and only adds MERGE relationships on top.
// Two questions that A merges have the same canonical_id under C;
// two questions that ONLY C merges (via cosine override) have
// DIFFERENT canonical_ids but C.equivalent() returns true.
//
// This is intentional: canonical_id is for fast leaf clustering;
// equivalent() is for fuzzy matching at the cluster boundary. The
// lattice uses both — leaves are keyed by canonical_id, but a query
// for "find similar questions" calls equivalent() against cluster
// representatives.

import { candidateA } from "./candidate-a.ts";
import { candidateB, pairCosine } from "./candidate-b.ts";
import type { Normalizer, NormalizeResult } from "./types.ts";

// Stricter threshold than B's standalone θ = 0.92, since C is using
// cosine to OVERRIDE A's rejection — needs higher confidence.
export const THETA_HIGH_V1 = 0.95;

export const candidateC: Normalizer = {
  id: "candidate-C",
  version: "v1",

  async normalize(q: string): Promise<NormalizeResult> {
    // Inherit A's canonical_id; expose strategy in meta.
    const a = await candidateA.normalize(q);
    return {
      canonical_id: a.canonical_id,
      normalized: a.normalized,
      meta: {
        strategy: "hybrid-A-then-cosine",
        delegate: "candidate-A",
        theta_high: THETA_HIGH_V1,
      },
    };
  },

  async equivalent(q1: string, q2: string): Promise<boolean> {
    // Step 1: A's verdict. If A merges, we trust it.
    if (await candidateA.equivalent(q1, q2)) return true;

    // Step 2: A rejected. Check cosine; only override if strongly above threshold.
    const sim = await pairCosine(q1, q2);
    return sim >= THETA_HIGH_V1;
  },
};

// Diagnostic: report which decision branch fired for a pair.
export type CDiagnosis = {
  q1: string;
  q2: string;
  a_merged: boolean;
  cosine: number;
  c_verdict: boolean;
  decision_branch: "A_merged" | "cosine_override" | "rejected";
};

export async function diagnose(q1: string, q2: string): Promise<CDiagnosis> {
  const a_merged = await candidateA.equivalent(q1, q2);
  const cosine = await pairCosine(q1, q2);
  let c_verdict: boolean;
  let decision_branch: CDiagnosis["decision_branch"];
  if (a_merged) {
    c_verdict = true;
    decision_branch = "A_merged";
  } else if (cosine >= THETA_HIGH_V1) {
    c_verdict = true;
    decision_branch = "cosine_override";
  } else {
    c_verdict = false;
    decision_branch = "rejected";
  }
  return { q1, q2, a_merged, cosine, c_verdict, decision_branch };
}

// CLI: print full diagnosis for a pair.
//   bun scripts/normalize/candidate-c.ts "What is X?" "WTF is X?"
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('usage: candidate-c.ts "<q1>" "<q2>"');
    process.exit(2);
  }
  const [q1, q2] = args;
  const d = await diagnose(q1, q2);
  console.log(`q1:                ${JSON.stringify(d.q1)}`);
  console.log(`q2:                ${JSON.stringify(d.q2)}`);
  console.log(`A says merged:     ${d.a_merged}`);
  console.log(`cosine:            ${d.cosine.toFixed(4)}`);
  console.log(`θ_HIGH:            ${THETA_HIGH_V1}`);
  console.log(`C verdict:         ${d.c_verdict}`);
  console.log(`decision branch:   ${d.decision_branch}`);
}
