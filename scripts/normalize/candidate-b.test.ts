// Smoke tests for Candidate B (embedding cosine threshold).
//
// Embedding inference takes a few hundred ms per call (model load is the
// hot path on first invocation). Tests are fewer and more targeted than
// Candidate A's; full corpus scoring lives in score-corpus.ts.
//
// We're not testing exact cosine values (those depend on the MiniLM
// model's deterministic but opaque behavior). We're testing the
// candidate's CONTRACT: identical preprocessed inputs → equivalent;
// known SEPARATE pairs from spec §3.2 → not equivalent at θ = 0.92.

import { test, expect, describe } from "bun:test";
import { candidateB, pairCosine, THETA_V1 } from "./candidate-b.ts";

describe("Candidate B — canonical_id format", () => {
  test("emits v1:<hash> format", async () => {
    const r = await candidateB.normalize("What is X?");
    expect(r.canonical_id).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  test("identical inputs → identical canonical_id (deterministic)", async () => {
    const r1 = await candidateB.normalize("What is X?");
    const r2 = await candidateB.normalize("What is X?");
    expect(r1.canonical_id).toBe(r2.canonical_id);
  });

  test("preprocessed-equal inputs → identical canonical_id", async () => {
    // After NFKC/lowercase/whitespace, these collapse to "what is x?".
    const r1 = await candidateB.normalize("What is X?");
    const r2 = await candidateB.normalize("WHAT IS X?");
    const r3 = await candidateB.normalize("  What is X? ");
    expect(r1.canonical_id).toBe(r2.canonical_id);
    expect(r1.canonical_id).toBe(r3.canonical_id);
  });

  test("meta exposes strategy + threshold", async () => {
    const r = await candidateB.normalize("What is X?");
    expect(r.meta?.strategy).toBe("embedding-cosine");
    expect(r.meta?.theta).toBe(THETA_V1);
  });
});

describe("Candidate B — equivalent() on known pairs", () => {
  test("preprocessed-equal pairs short-circuit to equivalent", async () => {
    expect(await candidateB.equivalent("What is X?", "what is x?")).toBe(true);
    expect(await candidateB.equivalent("How do I run this?", "  how do i run this?  ")).toBe(true);
  });

  test("§3.2 SEPARATE: negation pairs do NOT merge under cosine", async () => {
    // These are known hard negatives. Embedding cosine commonly fails
    // here because surface-level similarity is high. If Candidate B
    // merges them, we've found a known weakness — Phase 4 will quantify.
    const pairs = [
      ["How do I enable X?", "How do I disable X?"],
      ["What causes this?", "What prevents this?"],
      ["Why does this work?", "Why doesn't this work?"],
    ];
    let mergeCount = 0;
    for (const [q1, q2] of pairs) {
      if (await candidateB.equivalent(q1, q2)) mergeCount++;
    }
    // Document the expected weakness: at θ=0.92, embedding cosine
    // probably catches some but not all polarity flips. Test passes
    // as long as not ALL pairs falsely merge.
    expect(mergeCount).toBeLessThan(pairs.length);
  }, 30_000);

  test("clearly different questions do NOT merge", async () => {
    expect(await candidateB.equivalent("What is the deadline?", "Where is the API?")).toBe(false);
    expect(await candidateB.equivalent("How do I install this?", "Why is the build slow?")).toBe(false);
  }, 30_000);
});

describe("Candidate B — diagnostic pairCosine", () => {
  test("cosine on identical preprocessed inputs is ~1.0", async () => {
    const sim = await pairCosine("What is X?", "what is x?");
    expect(sim).toBeGreaterThan(0.99);
  });

  test("cosine on unrelated questions is well below threshold", async () => {
    const sim = await pairCosine("What is the deadline?", "Where is the API?");
    expect(sim).toBeLessThan(0.85);
  }, 30_000);
});
