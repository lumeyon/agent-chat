// Smoke tests for Candidate A. Pulls a small sample of pairs from the
// canonical-equivalence corpus and asserts the normalizer's behavior
// matches the expected label. Full Phase 4 scoring lives in
// scripts/normalize/score-corpus.ts (TBD); this is just a sanity check.

import { test, expect, describe } from "bun:test";
import {
  candidateA,
  normalizeString,
  step_contractions,
  step_strip_fillers,
  step_strip_register,
  step_strip_modifiers,
  step_synonyms,
  step_lemmatize,
} from "./candidate-a.ts";

describe("Candidate A — pipeline steps", () => {
  test("contraction expansion", () => {
    expect(step_contractions("what's the deal")).toBe("what is the deal");
    expect(step_contractions("don't worry")).toBe("do not worry");
    expect(step_contractions("nothing here")).toBe("nothing here");
  });

  test("filler stripping", () => {
    expect(step_strip_fillers("hey, what is x")).toBe("what is x");
    expect(step_strip_fillers("please help me")).toBe("help me");
    expect(step_strip_fillers("just curious, what is x")).toBe("what is x");
  });

  test("register: WTF maps to 'what' (replacement, not strip)", () => {
    expect(step_strip_register("wtf is this")).toBe("what is this");
    expect(step_strip_register("why the hell is x")).toBe("why is x");
    // The ", like ," construct collapses to a single space; whitespace
    // step (run later in the pipeline) consolidates further.
    expect(step_strip_register("how do i , like , do this")).toBe("how do i do this");
  });

  test("modifier stripping", () => {
    expect(step_strip_modifiers("in production, what fails")).toBe("what fails");
    expect(step_strip_modifiers("what fails in production")).toBe("what fails");
    expect(step_strip_modifiers("on linux, where is x")).toBe("where is x");
    expect(step_strip_modifiers("by default, what is the value")).toBe("what is the value");
  });

  test("synonym substitution (programming domain)", () => {
    expect(step_synonyms("what does this method do")).toBe("what does this function do");
    expect(step_synonyms("how do i fix this defect")).toBe("how do i fix this bug");
    expect(step_synonyms("how do i resolve this issue")).toBe("how do i fix this bug");
  });

  test("lemmatization (crude suffix stripping)", () => {
    // Suffix priority: ies → -y, then ing/tion/ed/s. "tests" is too short
    // for "tion" (would leave "tes") so falls through to plural "s" → "test".
    expect(step_lemmatize("running tests")).toBe("runn test");
    expect(step_lemmatize("dependencies installed")).toBe("dependency install");
  });
});

describe("Candidate A — full normalize on real corpus pairs", () => {
  test("surface_form: case + punctuation differences merge", async () => {
    expect(await candidateA.equivalent("What is the deadline?", "what is the deadline?")).toBe(true);
    expect(await candidateA.equivalent("WHAT IS X?", "what is x")).toBe(true);
    expect(await candidateA.equivalent("How do I run the tests?", "How do I run the tests")).toBe(true);
  });

  test("contractions merge", async () => {
    expect(await candidateA.equivalent("What's the issue?", "What is the issue?")).toBe(true);
    // Known limitation (Candidate A): tag-question negation reorders.
    // "Don't we" expands to "do not we" but the parallel "Do we not"
    // stays "do we not" — different word orders. A grammar-aware or
    // embedding-based candidate should catch this. Documenting the gap.
    expect(await candidateA.equivalent("Don't we need auth here?", "Do we not need auth here?")).toBe(false);
  });

  test("filler/politeness merges", async () => {
    expect(await candidateA.equivalent("What is X?", "Hey, what is X?")).toBe(true);
    expect(await candidateA.equivalent("What's the status?", "Yo, what's the status?")).toBe(true);
  });

  test("register merges", async () => {
    expect(await candidateA.equivalent("What is X?", "WTF is X?")).toBe(true);
    expect(await candidateA.equivalent("Why is this broken?", "Why the hell is this broken?")).toBe(true);
  });

  test("word_order: modifier moves don't change canonical", async () => {
    expect(await candidateA.equivalent("In Python, what is X?", "What is X in Python?")).toBe(false);
    // ^ "in Python" not in MODIFIERS_V1 (precision-first). Phase 4 will surface this.
    expect(await candidateA.equivalent("In production, what is the timeout?", "What is the timeout in production?")).toBe(true);
    expect(await candidateA.equivalent("By default, what is the value?", "What is the value by default?")).toBe(true);
  });

  test("§3.2 SEPARATE: negation pairs do NOT merge", async () => {
    expect(await candidateA.equivalent("What causes this?", "What prevents this?")).toBe(false);
    expect(await candidateA.equivalent("How do I enable X?", "How do I disable X?")).toBe(false);
    expect(await candidateA.equivalent("Why does X work?", "Why doesn't X work?")).toBe(false);
  });

  test("§3.2 SEPARATE: different question word does NOT merge", async () => {
    expect(await candidateA.equivalent("What is X?", "Why is X?")).toBe(false);
    expect(await candidateA.equivalent("How does X work?", "Where does X work?")).toBe(false);
  });

  test("§3.2 SEPARATE: different aspect does NOT merge", async () => {
    expect(await candidateA.equivalent("What does X do?", "What did X do?")).toBe(false);
  });
});

describe("Candidate A — canonical_id format", () => {
  test("emits v1:<hash> format", async () => {
    const r = await candidateA.normalize("What is X?");
    expect(r.canonical_id).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  test("same input → same canonical_id (deterministic)", async () => {
    const r1 = await candidateA.normalize("What is X?");
    const r2 = await candidateA.normalize("What is X?");
    expect(r1.canonical_id).toBe(r2.canonical_id);
  });

  test("different inputs → likely different canonical_ids", async () => {
    const r1 = await candidateA.normalize("What is X?");
    const r2 = await candidateA.normalize("Why is X?");
    expect(r1.canonical_id).not.toBe(r2.canonical_id);
  });
});
