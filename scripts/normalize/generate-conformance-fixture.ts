#!/usr/bin/env bun
// generate-conformance-fixture.ts — produce the canonical-id fixture
// file used by both TypeScript and Python implementations of
// Candidate A to verify they produce identical outputs.
//
// The fixture is the cross-language conformance contract for the
// Lumeyon dual-audience fusion: Python (lumeyon/quantum-substrate)
// and TypeScript (lumeyon/agent-chat) must agree on canonical_id
// for the SAME input. If either implementation drifts, the test
// fails in CI.
//
// Usage:
//   bun scripts/normalize/generate-conformance-fixture.ts
//     # Writes tests/conformance-fixture-v1.jsonl
//
// Each line of the output:
//   {"input": "<question>", "normalized": "<after-pipeline>", "canonical_id": "v1:<hash>"}
//
// The fixture covers a deliberately diverse set of inputs that
// exercise every step of the pipeline so any port has to handle the
// full surface area, not just the easy cases.

import * as fs from "node:fs";
import { candidateA } from "./candidate-a.ts";

// Inputs span every step of the pipeline. Keep this list stable —
// any change to the fixture is a change to the conformance contract.
const INPUTS: string[] = [
  // Surface form
  "What is the deadline?",
  "WHAT IS THE DEADLINE?",
  "what is the deadline?",
  "  What is the deadline?  ",
  "What is the deadline?!?!",
  "What is the deadline",
  // Whitespace collapse
  "What  is   the    deadline?",
  // Contractions
  "What's the issue?",
  "Don't we need auth?",
  "I'm seeing an error",
  "It's working, isn't it?",
  // Filler / politeness
  "Hey, what is X?",
  "Please, what is X?",
  "Just curious, what is X?",
  "Sorry, what does this do?",
  "What's the status, thanks?",
  // Register
  "WTF is X?",
  "Why the hell is this broken?",
  "How do I, like, set this up?",
  // Modifiers (word-order MERGE)
  "In production, what is the timeout?",
  "What is the timeout in production?",
  "On Linux, where is the config?",
  "Where is the config on Linux?",
  "By default, what is the value?",
  "What is the value by default?",
  // Synonyms
  "What does this method do?",
  "What does this function do?",
  "How do I fix this defect?",
  "How do I fix this bug?",
  "How do I resolve this issue?",
  // Lemmatization-sensitive
  "What causes errors?",
  "What is causing the error?",
  "How do tests pass?",
  "How does the test pass?",
  // Edge cases
  "X?",
  "?",
  "",
  "WHAT'S THE DEAL, ANYWAY???",
  "  hey,  what's the deal??  ",
  // Unicode
  "What is the deadline?​", // zero-width space
  "What is the deadline?",
  // Multiple modifiers stacked
  "In production, on Linux, what is the timeout?",
  // Real corpus samples (from canonical-equivalence-corpus.v1.jsonl)
  "How do I install dependencies?",
  "Where is the config file?",
  "Why does this leak memory?",
  "What runs on startup?",
];

interface FixtureEntry {
  input: string;
  normalized: string;
  canonical_id: string;
}

async function main(): Promise<void> {
  const out: FixtureEntry[] = [];
  for (const input of INPUTS) {
    const r = await candidateA.normalize(input);
    out.push({ input, normalized: r.normalized, canonical_id: r.canonical_id });
  }

  const outPath = "tests/conformance-fixture-v1.jsonl";
  const text = out.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(outPath, text);
  console.log(`wrote ${out.length} fixture entries to ${outPath}`);

  // Echo first few to stdout for sanity.
  console.log("\nfirst 5 entries:");
  for (const e of out.slice(0, 5)) {
    console.log(`  ${JSON.stringify(e.input).padEnd(40)} → ${e.canonical_id}  (normalized: ${JSON.stringify(e.normalized)})`);
  }
}

if (import.meta.main) await main();
