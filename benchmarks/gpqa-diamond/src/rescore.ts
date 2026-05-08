#!/usr/bin/env bun
// rescore.ts — re-apply the canonical extractAnswer to a results JSONL
// and update each entry's `answer_extracted` and `correct` fields.
//
// Useful when run-baseline.ts was launched with an older extractAnswer
// implementation; we don't want to re-pay the LLM call to re-run, just
// to re-parse what's already saved.
//
// Usage:
//   bun rescore.ts <results.jsonl> [--in-place | --out <newpath>]
//   default: writes to <results>.rescored.jsonl

import * as fs from "node:fs";
import { extractAnswer } from "./extract.ts";

function parseArgs(argv: string[]): { input: string; out: string; inPlace: boolean } {
  let input = "";
  let out = "";
  let inPlace = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in-place") inPlace = true;
    else if (a === "--out") out = argv[++i];
    else if (!input) input = a;
  }
  if (!input) {
    console.error("usage: rescore.ts <results.jsonl> [--in-place | --out <newpath>]");
    process.exit(2);
  }
  if (!out) out = inPlace ? input : input.replace(/\.jsonl$/, "") + ".rescored.jsonl";
  return { input, out, inPlace };
}

function main() {
  const { input, out } = parseArgs(process.argv.slice(2));
  const lines = fs.readFileSync(input, "utf8").split("\n").filter(Boolean);
  let changed = 0;
  let total = 0;
  let stillWrong = 0;
  let nowCorrect = 0;
  let nowWrong = 0;
  const outLines: string[] = [];
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { outLines.push(line); continue; }
    total++;
    const before = entry.answer_extracted;
    const newExtracted = extractAnswer(entry.response ?? "");
    const newCorrect = newExtracted === entry.answer_expected;
    if (newExtracted !== before || newCorrect !== entry.correct) {
      changed++;
      if (entry.correct && !newCorrect) nowWrong++;
      else if (!entry.correct && newCorrect) nowCorrect++;
    }
    if (!newCorrect) stillWrong++;
    entry.answer_extracted = newExtracted;
    entry.correct = newCorrect;
    outLines.push(JSON.stringify(entry));
  }
  fs.writeFileSync(out, outLines.join("\n") + "\n");
  console.log(`# rescored ${total} entries → ${out}`);
  console.log(`#   changed:      ${changed}`);
  console.log(`#   newly correct: ${nowCorrect}`);
  console.log(`#   newly wrong:   ${nowWrong}`);
  console.log(`#   still wrong:  ${stillWrong}`);
}

main();
