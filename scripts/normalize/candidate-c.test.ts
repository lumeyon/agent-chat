// Tests for Candidate C (hybrid A + B).
//
// Verifies the three decision branches:
//   1. A_merged    — A's rules already say merge
//   2. cosine_override — A says no but cosine >= θ_HIGH (0.95)
//   3. rejected    — A says no and cosine < θ_HIGH
//
// Plus the contract that C should at minimum match A on cases A handles,
// and pick up some cases A misses (voice change, paraphrase) without
// regressing on hard negatives.

import { test, expect, describe } from "bun:test";
import { candidateC, diagnose, THETA_HIGH_V1 } from "./candidate-c.ts";

describe("Candidate C — decision branches", () => {
  test("A_merged branch fires on cases A handles cleanly", async () => {
    const d = await diagnose("What is X?", "WTF is X?");
    expect(d.a_merged).toBe(true);
    expect(d.c_verdict).toBe(true);
    expect(d.decision_branch).toBe("A_merged");
  });

  test("cosine_override branch fires on voice changes (A misses)", async () => {
    const d = await diagnose("What does the parser do?", "What is done by the parser?");
    expect(d.a_merged).toBe(false);
    expect(d.cosine).toBeGreaterThan(THETA_HIGH_V1);
    expect(d.c_verdict).toBe(true);
    expect(d.decision_branch).toBe("cosine_override");
  }, 30_000);

  test("rejected branch fires on hard negatives (A says no AND cosine low)", async () => {
    const d = await diagnose("How do I enable X?", "How do I disable X?");
    expect(d.a_merged).toBe(false);
    expect(d.cosine).toBeLessThan(THETA_HIGH_V1);
    expect(d.c_verdict).toBe(false);
    expect(d.decision_branch).toBe("rejected");
  }, 30_000);
});

describe("Candidate C — contract: at least as good as A", () => {
  test("everything A merges, C also merges (no regression)", async () => {
    const merge_pairs = [
      ["What is the deadline?", "what is the deadline?"],
      ["What's the issue?", "What is the issue?"],
      ["What is X?", "Hey, what is X?"],
      ["Why is this broken?", "Why the hell is this broken?"],
    ];
    for (const [q1, q2] of merge_pairs) {
      expect(await candidateC.equivalent(q1, q2)).toBe(true);
    }
  });

  test("hard negatives that A correctly rejects, C also rejects", async () => {
    const separate_pairs = [
      ["What causes this?", "What prevents this?"],
      ["How do I enable X?", "How do I disable X?"],
      ["What is X?", "Why is X?"],
      ["What does X do?", "What did X do?"],
    ];
    for (const [q1, q2] of separate_pairs) {
      expect(await candidateC.equivalent(q1, q2)).toBe(false);
    }
  }, 60_000);
});

describe("Candidate C — picks up cases A misses", () => {
  test("voice change (A misses, B catches, C should catch via cosine override)", async () => {
    expect(await candidateC.equivalent("What does the parser do?", "What is done by the parser?")).toBe(true);
  }, 30_000);

  test("tag-question contraction (A misses; cosine should override)", async () => {
    // A's contraction expansion produces "do not we" vs "do we not" — distinct.
    // Cosine on the same surface forms should be very high (near-identical text).
    const d = await diagnose("Don't we need auth here?", "Do we not need auth here?");
    // Both branches valid: A may say yes after all (depending on lemma collapse),
    // OR cosine override fires. C should land on merge regardless.
    expect(d.c_verdict).toBe(true);
  }, 30_000);
});

describe("Candidate C — canonical_id format", () => {
  test("inherits A's canonical_id verbatim", async () => {
    const c = await candidateC.normalize("What is X?");
    const a = await (await import("./candidate-a.ts")).candidateA.normalize("What is X?");
    expect(c.canonical_id).toBe(a.canonical_id);
  });

  test("meta exposes strategy", async () => {
    const r = await candidateC.normalize("What is X?");
    expect(r.meta?.strategy).toBe("hybrid-A-then-cosine");
    expect(r.meta?.delegate).toBe("candidate-A");
    expect(r.meta?.theta_high).toBe(THETA_HIGH_V1);
  });
});
