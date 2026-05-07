#!/usr/bin/env bun
// validate-corpus.ts — sanity check for canonical-equivalence-corpus.*.jsonl.
//
// Per docs/canonical-equivalence-spec.md the corpus drives Phase 4 scoring,
// so the schema and category labels MUST match the spec. This validator
// catches typos, missing fields, unknown categories, duplicate IDs, and
// reports a category histogram so we can see whether each category has
// enough pairs to make scoring meaningful.
//
// Usage: bun scripts/lattice/validate-corpus.ts [<path/to/corpus.jsonl>]
//
// Exit 0 if valid; non-zero with diagnostics if any line fails.

import * as fs from "node:fs";
import * as path from "node:path";

// Categories enumerated in docs/canonical-equivalence-spec.md §3.1, §3.2, §3.3.
// Categories here MUST stay in sync with the spec.
const MERGE_CATEGORIES = new Set([
  "surface_form",
  "inflection",
  "contractions",
  "filler_politeness",
  "voice",
  "word_order",
  "register",
]);

const SEPARATE_CATEGORIES = new Set([
  "negation",
  "different_referent",
  "different_question_word",
  "different_scope",
  "different_aspect",
  "granularity_narrowing",
  "granularity_broadening",
  "implicit_context",
]);

const ALLOWED_PROVENANCE = new Set([
  "hand_curated",
  "hard_negative",
  "public_qqp",
  "public_mrpc",
  "public_paws",
  "llm_synth",
]);

type Entry = {
  id: string;
  q1: string;
  q2: string;
  label: "merge" | "separate";
  category: string;
  subcategory?: string | null;
  provenance: string;
  version: string;
};

type ValidationResult = {
  ok: boolean;
  total: number;
  errors: string[];
  perCategory: Map<string, { merge: number; separate: number }>;
  perProvenance: Map<string, number>;
  perLabel: Map<string, number>;
};

function validateEntry(line: string, lineno: number): { entry?: Entry; error?: string } {
  if (!line.trim()) return { error: `line ${lineno}: empty (JSONL must have one entry per line, no blank lines)` };
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return { error: `line ${lineno}: not valid JSON (${(e as Error).message})` };
  }
  for (const field of ["id", "q1", "q2", "label", "category", "provenance", "version"]) {
    if (typeof raw[field] !== "string") {
      return { error: `line ${lineno}: missing or non-string field "${field}"` };
    }
  }
  if (raw.label !== "merge" && raw.label !== "separate") {
    return { error: `line ${lineno}: label must be "merge" or "separate", got "${raw.label}"` };
  }
  const knownCategories = new Set([...MERGE_CATEGORIES, ...SEPARATE_CATEGORIES]);
  if (!knownCategories.has(raw.category)) {
    return {
      error: `line ${lineno}: unknown category "${raw.category}". Allowed: ${[...knownCategories].sort().join(", ")}`,
    };
  }
  if (raw.label === "merge" && !MERGE_CATEGORIES.has(raw.category)) {
    return {
      error: `line ${lineno}: label="merge" but category="${raw.category}" is in the SEPARATE set per spec §3.2/§3.3. Did you mean a MERGE category, or label="separate"?`,
    };
  }
  if (raw.label === "separate" && !SEPARATE_CATEGORIES.has(raw.category)) {
    return {
      error: `line ${lineno}: label="separate" but category="${raw.category}" is in the MERGE set per spec §3.1/§3.3. Did you mean a SEPARATE category, or label="merge"?`,
    };
  }
  if (!ALLOWED_PROVENANCE.has(raw.provenance)) {
    return {
      error: `line ${lineno}: unknown provenance "${raw.provenance}". Allowed: ${[...ALLOWED_PROVENANCE].sort().join(", ")}`,
    };
  }
  if (raw.version !== "v1") {
    return { error: `line ${lineno}: version must be "v1" for the v1 corpus, got "${raw.version}"` };
  }
  if (raw.subcategory != null && typeof raw.subcategory !== "string") {
    return { error: `line ${lineno}: subcategory must be string or null/missing, got ${typeof raw.subcategory}` };
  }
  // Strict character equality: catches accidental duplicate (copy-paste) but
  // ALLOWS whitespace-only differences which are legitimate surface_form
  // tests (e.g., "What is X?" vs " What is X? ").
  if (raw.q1 === raw.q2) {
    return { error: `line ${lineno}: q1 and q2 are character-identical — corpus pairs must differ in at least one character` };
  }
  return { entry: raw as Entry };
}

export function validateCorpusFile(filePath: string): ValidationResult {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  const perCategory = new Map<string, { merge: number; separate: number }>();
  const perProvenance = new Map<string, number>();
  const perLabel = new Map<string, number>();

  lines.forEach((line, i) => {
    const lineno = i + 1;
    const { entry, error } = validateEntry(line, lineno);
    if (error) {
      errors.push(error);
      return;
    }
    if (!entry) return;

    if (seenIds.has(entry.id)) {
      errors.push(`line ${lineno}: duplicate id "${entry.id}"`);
    } else {
      seenIds.add(entry.id);
    }

    // Detect duplicate (q1, q2) pairs even with different ids.
    const pairKey = `${entry.q1.trim()}\n||\n${entry.q2.trim()}`;
    const reverseKey = `${entry.q2.trim()}\n||\n${entry.q1.trim()}`;
    if (seenPairs.has(pairKey) || seenPairs.has(reverseKey)) {
      errors.push(`line ${lineno}: duplicate pair (q1,q2) already seen earlier in corpus (id=${entry.id})`);
    } else {
      seenPairs.add(pairKey);
    }

    const cat = perCategory.get(entry.category) ?? { merge: 0, separate: 0 };
    cat[entry.label]++;
    perCategory.set(entry.category, cat);
    perProvenance.set(entry.provenance, (perProvenance.get(entry.provenance) ?? 0) + 1);
    perLabel.set(entry.label, (perLabel.get(entry.label) ?? 0) + 1);
  });

  return { ok: errors.length === 0, total: lines.length, errors, perCategory, perProvenance, perLabel };
}

function main() {
  const arg = process.argv[2] ?? "tests/canonical-equivalence-corpus.v1.jsonl";
  const filePath = path.resolve(arg);
  if (!fs.existsSync(filePath)) {
    console.error(`error: corpus file not found at ${filePath}`);
    process.exit(2);
  }
  const result = validateCorpusFile(filePath);

  console.log(`corpus: ${filePath}`);
  console.log(`total entries: ${result.total}`);
  console.log();
  console.log(`per-label:`);
  for (const [label, count] of [...result.perLabel.entries()].sort()) {
    console.log(`  ${label.padEnd(10)} ${count}`);
  }
  console.log();
  console.log(`per-category:`);
  const sortedCats = [...result.perCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cat, counts] of sortedCats) {
    const total = counts.merge + counts.separate;
    const breakdown = counts.merge > 0 && counts.separate > 0
      ? `(merge=${counts.merge}, separate=${counts.separate})`
      : counts.merge > 0 ? `(merge)` : `(separate)`;
    console.log(`  ${cat.padEnd(28)} ${String(total).padStart(4)}  ${breakdown}`);
  }
  console.log();
  console.log(`per-provenance:`);
  for (const [prov, count] of [...result.perProvenance.entries()].sort()) {
    console.log(`  ${prov.padEnd(16)} ${count}`);
  }
  console.log();
  if (!result.ok) {
    console.error(`VALIDATION FAILED — ${result.errors.length} error(s):`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`✓ corpus is valid`);
}

if (import.meta.main) main();
