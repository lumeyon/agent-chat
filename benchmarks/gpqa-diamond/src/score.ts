#!/usr/bin/env bun
// score.ts — aggregate a results JSONL into accuracy stats.
//
// Usage:
//   bun score.ts <path/to/results.jsonl>

import * as fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: score.ts <results.jsonl>");
  process.exit(2);
}
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const entries = lines.map((l) => JSON.parse(l));
const total = entries.length;
const correct = entries.filter((e) => e.correct).length;
const errors = entries.filter((e) => e.error).length;
const noExtract = entries.filter((e) => e.answer_extracted === null).length;

const byDomain: Record<string, { total: number; correct: number }> = {};
for (const e of entries) {
  const d = e.domain || "unknown";
  byDomain[d] = byDomain[d] || { total: 0, correct: 0 };
  byDomain[d].total++;
  if (e.correct) byDomain[d].correct++;
}

const elapsedMsList = entries.map((e) => e.elapsed_ms ?? 0).filter(Boolean);
const meanElapsed = elapsedMsList.length > 0 ? elapsedMsList.reduce((a, b) => a + b, 0) / elapsedMsList.length : 0;

console.log(`file:         ${file}`);
console.log(`model:        ${entries[0]?.model ?? "?"}`);
console.log(`total:        ${total}`);
console.log(`correct:      ${correct}  (${((correct / total) * 100).toFixed(1)}%)`);
console.log(`errors:       ${errors}`);
console.log(`no-extract:   ${noExtract}  (response present but couldn't parse "Answer: X")`);
console.log(`mean elapsed: ${(meanElapsed / 1000).toFixed(1)}s`);
console.log("");
console.log("by domain:");
for (const [d, s] of Object.entries(byDomain).sort()) {
  console.log(`  ${d.padEnd(30)} ${s.correct}/${s.total}  (${((s.correct / s.total) * 100).toFixed(1)}%)`);
}

// Confusion table: which letter did the model pick when it was wrong?
const wrong = entries.filter((e) => !e.correct && e.answer_extracted);
const confusion: Record<string, Record<string, number>> = {};
for (const e of wrong) {
  const exp = e.answer_expected;
  const got = e.answer_extracted;
  confusion[exp] = confusion[exp] || {};
  confusion[exp][got] = (confusion[exp][got] || 0) + 1;
}
console.log("");
console.log("confusion (rows = expected, cols = picked, only wrong):");
console.log(`  expected   A   B   C   D`);
for (const exp of ["A", "B", "C", "D"]) {
  const row = confusion[exp] || {};
  const cells = ["A", "B", "C", "D"].map((g) => String(row[g] ?? 0).padStart(3));
  console.log(`         ${exp}  ${cells.join("  ")}`);
}
