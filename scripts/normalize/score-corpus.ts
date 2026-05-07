#!/usr/bin/env bun
// score-corpus.ts — Phase 4 scoring harness.
//
// Runs each Normalizer candidate against the full canonical-equivalence
// corpus and reports precision/recall/F1 per (candidate, category) plus
// per-candidate overall.
//
// Output format: a markdown table written to stdout, plus a JSONL trace
// of (candidate, pair_id, predicted, actual) for downstream failure
// analysis (which pairs each candidate gets wrong).
//
// Usage:
//   bun scripts/normalize/score-corpus.ts
//     # Score all candidates against tests/canonical-equivalence-corpus.v1.jsonl
//
//   bun scripts/normalize/score-corpus.ts --candidate A
//     # Score only Candidate A
//
//   bun scripts/normalize/score-corpus.ts --trace failures.jsonl
//     # Write per-pair predictions to failures.jsonl

import * as fs from "node:fs";
import * as path from "node:path";
import type { Normalizer } from "./types.ts";
import { candidateA } from "./candidate-a.ts";
import { candidateB, preloadCache } from "./candidate-b.ts";
import { candidateC } from "./candidate-c.ts";

interface CorpusEntry {
  id: string;
  q1: string;
  q2: string;
  label: "merge" | "separate";
  category: string;
}

interface Tally {
  tp: number; // predicted merge, actual merge
  fp: number; // predicted merge, actual separate (false merge)
  tn: number; // predicted separate, actual separate
  fn: number; // predicted separate, actual merge (missed merge)
}

function emptyTally(): Tally {
  return { tp: 0, fp: 0, tn: 0, fn: 0 };
}

function precision(t: Tally): number {
  const denom = t.tp + t.fp;
  return denom === 0 ? 1 : t.tp / denom;
}
function recall(t: Tally): number {
  const denom = t.tp + t.fn;
  return denom === 0 ? 1 : t.tp / denom;
}
function f1(t: Tally): number {
  const p = precision(t);
  const r = recall(t);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function loadCorpus(filePath: string): CorpusEntry[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: CorpusEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as CorpusEntry);
  }
  return out;
}

interface ScoreResult {
  candidate: string;
  overall: Tally;
  perCategory: Map<string, Tally>;
  failures: Array<{ id: string; q1: string; q2: string; predicted: boolean; actual: boolean; category: string }>;
}

async function scoreCandidate(
  candidate: Normalizer,
  corpus: CorpusEntry[],
  options: { recordFailures: boolean } = { recordFailures: false },
): Promise<ScoreResult> {
  const overall = emptyTally();
  const perCategory = new Map<string, Tally>();
  const failures: ScoreResult["failures"] = [];

  for (const entry of corpus) {
    const predicted = await candidate.equivalent(entry.q1, entry.q2);
    const actual = entry.label === "merge";
    const cat = entry.category;
    if (!perCategory.has(cat)) perCategory.set(cat, emptyTally());
    const t = perCategory.get(cat)!;
    if (predicted && actual) {
      overall.tp++;
      t.tp++;
    } else if (predicted && !actual) {
      overall.fp++;
      t.fp++;
      if (options.recordFailures) failures.push({ ...entry, predicted, actual });
    } else if (!predicted && !actual) {
      overall.tn++;
      t.tn++;
    } else {
      overall.fn++;
      t.fn++;
      if (options.recordFailures) failures.push({ ...entry, predicted, actual });
    }
  }

  return { candidate: candidate.id, overall, perCategory, failures };
}

function printResult(r: ScoreResult): void {
  console.log(`\n## ${r.candidate}\n`);
  console.log(`### Overall`);
  console.log(`| metric | value |`);
  console.log(`|---|---|`);
  console.log(`| precision | ${(precision(r.overall) * 100).toFixed(1)}% |`);
  console.log(`| recall    | ${(recall(r.overall) * 100).toFixed(1)}% |`);
  console.log(`| F1        | ${(f1(r.overall) * 100).toFixed(1)}% |`);
  console.log(`| TP/FP/TN/FN | ${r.overall.tp} / ${r.overall.fp} / ${r.overall.tn} / ${r.overall.fn} |`);

  console.log(`\n### Per-category`);
  console.log(`| category | precision | recall | F1 | n |`);
  console.log(`|---|---|---|---|---|`);
  const sortedCats = [...r.perCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cat, t] of sortedCats) {
    const n = t.tp + t.fp + t.tn + t.fn;
    console.log(
      `| ${cat} | ${(precision(t) * 100).toFixed(1)}% | ${(recall(t) * 100).toFixed(1)}% | ${(f1(t) * 100).toFixed(1)}% | ${n} |`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let onlyCandidate: string | null = null;
  let traceFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--candidate") onlyCandidate = args[++i];
    else if (args[i] === "--trace") traceFile = args[++i];
  }

  const corpusPath = path.resolve("tests/canonical-equivalence-corpus.v1.jsonl");
  const corpus = loadCorpus(corpusPath);
  console.error(`# Phase 4 scoring — corpus = ${corpus.length} pairs from ${corpusPath}`);

  const allCandidates: Record<string, Normalizer> = {
    A: candidateA,
    B: candidateB,
    C: candidateC,
  };
  const candidates = onlyCandidate ? { [onlyCandidate]: allCandidates[onlyCandidate] } : allCandidates;

  // Pre-embed all unique questions so Candidate B's per-pair calls are fast.
  if ("B" in candidates || "C" in candidates) {
    const allQuestions: string[] = [];
    for (const e of corpus) {
      allQuestions.push(e.q1, e.q2);
    }
    console.error(`# preloading embeddings for ${new Set(allQuestions).size} unique questions...`);
    const t0 = Date.now();
    await preloadCache(allQuestions);
    console.error(`# embeddings cached in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const traceFailures = traceFile !== null;
  const allFailures: ScoreResult["failures"] = [];
  const results: ScoreResult[] = [];

  for (const [letter, c] of Object.entries(candidates)) {
    if (!c) {
      console.error(`# unknown candidate: ${letter}`);
      continue;
    }
    console.error(`# scoring Candidate ${letter}...`);
    const t0 = Date.now();
    const r = await scoreCandidate(c, corpus, { recordFailures: traceFailures });
    console.error(`# Candidate ${letter} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    results.push(r);
    if (traceFailures) {
      for (const f of r.failures) {
        allFailures.push({ ...f, candidate: c.id } as any);
      }
    }
  }

  // Summary table at top.
  console.log(`# Phase 4 scoring summary\n`);
  console.log(`Corpus: ${corpus.length} pairs from \`${path.relative(process.cwd(), corpusPath)}\`\n`);
  console.log(`| candidate | precision | recall | F1 | TP | FP | TN | FN |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    console.log(
      `| ${r.candidate} | ${(precision(r.overall) * 100).toFixed(1)}% | ${(recall(r.overall) * 100).toFixed(1)}% | ${(f1(r.overall) * 100).toFixed(1)}% | ${r.overall.tp} | ${r.overall.fp} | ${r.overall.tn} | ${r.overall.fn} |`,
    );
  }

  for (const r of results) {
    printResult(r);
  }

  if (traceFile && allFailures.length > 0) {
    fs.writeFileSync(traceFile, allFailures.map((f) => JSON.stringify(f)).join("\n") + "\n");
    console.error(`\n# wrote ${allFailures.length} failure records to ${traceFile}`);
  }
}

if (import.meta.main) await main();
