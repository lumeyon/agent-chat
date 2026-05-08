#!/usr/bin/env bun
// run-baseline.ts — run a single-model baseline (codex or claude) over
// the GPQA Diamond problem set. Resumable: skips problems already in
// the result JSONL.
//
// Usage:
//   bun run-baseline.ts --model codex|claude [--limit N] [--out PATH] [--start I] [--stop J]
//
// Output: one JSON line per problem with {id, domain, prompt, response, answer_extracted, correct, elapsed_ms, error?}
//
// Scoring is done separately by score.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { extractAnswer } from "./extract.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROBLEMS = path.join(HERE, "..", "data", "problems.jsonl");
const RESULTS_DIR = path.join(HERE, "..", "results");

interface Problem {
  id: string;
  domain: string;
  subdomain: string;
  question: string;
  choices: Record<"A"|"B"|"C"|"D", string>;
  answer: string;
}

interface ResultEntry {
  id: string;
  domain: string;
  model: "codex" | "claude";
  prompt_chars: number;
  response: string;
  answer_extracted: string | null;
  answer_expected: string;
  correct: boolean;
  elapsed_ms: number;
  error?: string;
}

function buildPrompt(p: Problem): string {
  return [
    "You are an expert answering a multiple-choice question.",
    "",
    `Domain: ${p.domain} / ${p.subdomain}`,
    "",
    `Question: ${p.question}`,
    "",
    "Choices:",
    `(A) ${p.choices.A}`,
    `(B) ${p.choices.B}`,
    `(C) ${p.choices.C}`,
    `(D) ${p.choices.D}`,
    "",
    "Think step by step, then on the LAST line of your response output exactly:",
    "Answer: X",
    "",
    "where X is one of A, B, C, or D.",
  ].join("\n");
}

function dispatchCodex(prompt: string, timeoutMs = 240_000): { stdout: string; stderr: string; status: number | null } {
  const r = child_process.spawnSync(
    "codex",
    ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function dispatchClaude(prompt: string, timeoutMs = 240_000): { stdout: string; stderr: string; status: number | null } {
  const r = child_process.spawnSync(
    "claude",
    ["-p", "--output-format", "text", prompt],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function loadProblems(): Problem[] {
  const text = fs.readFileSync(PROBLEMS, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Problem);
}

function loadCompletedIds(resultsPath: string): Set<string> {
  if (!fs.existsSync(resultsPath)) return new Set();
  const lines = fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean);
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.id) ids.add(r.id);
    } catch { /* tolerate malformed line */ }
  }
  return ids;
}

function parseArgs(argv: string[]): { model: "codex" | "claude"; limit?: number; out?: string; start?: number; stop?: number } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--start") out.start = parseInt(argv[++i], 10);
    else if (a === "--stop") out.stop = parseInt(argv[++i], 10);
  }
  if (out.model !== "codex" && out.model !== "claude") {
    console.error("usage: run-baseline.ts --model codex|claude [--limit N] [--start I] [--stop J] [--out PATH]");
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsPath = args.out ?? path.join(RESULTS_DIR, `${args.model}.jsonl`);
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

  const problems = loadProblems();
  const completed = loadCompletedIds(resultsPath);

  const start = args.start ?? 0;
  const stop = args.stop ?? problems.length;
  const slice = problems.slice(start, stop);
  const todo = slice.filter((p) => !completed.has(p.id)).slice(0, args.limit ?? slice.length);

  console.error(`# ${args.model} baseline: ${todo.length} problems pending (${completed.size} already done; range [${start}, ${stop}))`);

  let i = 0;
  for (const p of todo) {
    i++;
    const prompt = buildPrompt(p);
    const t0 = Date.now();
    let response = "";
    let stderr = "";
    let status: number | null = null;
    let error: string | undefined;
    try {
      const r = args.model === "codex" ? dispatchCodex(prompt) : dispatchClaude(prompt);
      response = r.stdout.trim();
      stderr = r.stderr;
      status = r.status;
      if (status !== 0 && !response) error = `cli exited ${status}: ${stderr.slice(0, 300)}`;
    } catch (err) {
      error = `dispatch threw: ${(err as Error)?.message ?? err}`;
    }
    const elapsed_ms = Date.now() - t0;
    const answer_extracted = response ? extractAnswer(response) : null;
    const correct = answer_extracted === p.answer;
    const entry: ResultEntry = {
      id: p.id,
      domain: p.domain,
      model: args.model,
      prompt_chars: prompt.length,
      response,
      answer_extracted,
      answer_expected: p.answer,
      correct,
      elapsed_ms,
      ...(error ? { error } : {}),
    };
    fs.appendFileSync(resultsPath, JSON.stringify(entry) + "\n");
    const pct = ((i / todo.length) * 100).toFixed(1);
    console.error(`# [${i}/${todo.length} ${pct}%] ${p.id} ${p.domain}/${p.subdomain.slice(0, 20)} → ans=${answer_extracted ?? "?"} expected=${p.answer} ${correct ? "✓" : "✗"} (${elapsed_ms}ms)${error ? " ERR" : ""}`);
  }

  console.error(`# done; results in ${resultsPath}`);
}

main().catch((err) => {
  console.error(`# FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
