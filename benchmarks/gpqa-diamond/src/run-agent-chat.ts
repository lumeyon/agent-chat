#!/usr/bin/env bun
// run-agent-chat.ts — agent-chat condition for the GPQA Diamond
// benchmark. Per problem, fires THREE LLM calls:
//
//   1. Draft   — claude (orion) sees the question + choices, produces an
//                initial chain-of-thought + Answer: X.
//   2. Critique — codex (one of lumeyon/keystone/carina by question_id
//                hash; heterogeneity-first per the petersen topology)
//                sees the question + claude's draft and is asked to
//                critique the reasoning. The critic does NOT see the
//                answer key.
//   3. Revise  — claude (orion) sees the question + its own draft + the
//                codex critique, produces a final Answer: X.
//
// Final letter for scoring = the revised answer's extracted letter.
// Per-call captures (draft response, critique response, revised
// response, peer name, per-call elapsed) are saved so post-hoc analysis
// can characterize where the substrate added or didn't add value.
//
// Same problems.jsonl, same extractAnswer, same scoring rules as the
// single-model baselines. Resumable via --skip-by-id on the result
// file. Supports --timeout-ms (default 1_200_000 = 20 min per call)
// and --retry-timeouts (drops failed entries so the runner re-runs
// them).

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import { extractAnswer } from "./extract.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROBLEMS = path.join(HERE, "..", "data", "problems.jsonl");
const RESULTS_DIR = path.join(HERE, "..", "results");

const CODEX_PEERS = ["lumeyon", "keystone", "carina"] as const;

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
  subdomain: string;
  model: "agent-chat";
  peer: string;
  // Per-call captures.
  claude_draft_response: string;
  claude_draft_letter: string | null;
  codex_critique_response: string;
  claude_revised_response: string;
  // Final extracted/expected/correct = from the REVISED claude answer.
  answer_extracted: string | null;
  answer_expected: string;
  correct: boolean;
  // Timing + error diagnostics.
  elapsed_ms: number;             // TOTAL across all 3 calls
  elapsed_ms_draft: number;
  elapsed_ms_critique: number;
  elapsed_ms_revise: number;
  prompt_chars_draft: number;
  prompt_chars_critique: number;
  prompt_chars_revise: number;
  error?: string;
}

function buildDraftPrompt(p: Problem): string {
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

function buildCritiquePrompt(p: Problem, peer: string, draft: string, draftLetter: string | null): string {
  return [
    `You are ${peer}, a peer reviewer with expertise in graduate-level science.`,
    "",
    "Another agent (orion) has produced a draft answer to a multiple-choice question.",
    "Your job is to critique the reasoning. You do NOT know the correct answer.",
    "Be terse and rigorous. If you find an error in the reasoning, name it specifically.",
    "If you disagree with the chosen answer, argue for a different choice and say which.",
    "If the reasoning is sound, say so explicitly and endorse the choice.",
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
    `orion's draft answer (chose ${draftLetter ?? "[unparseable]"}):`,
    "---",
    draft,
    "---",
    "",
    "Your critique:",
  ].join("\n");
}

function buildRevisePrompt(p: Problem, draft: string, critique: string, peer: string): string {
  return [
    "You are an expert answering a multiple-choice question.",
    "",
    "Below is your earlier DRAFT answer and a CRITIQUE from a peer reviewer.",
    "Consider the critique carefully. If the critique is right, update your reasoning.",
    "If the critique is wrong, defend your original reasoning. Do not change your answer reflexively just because the peer disagreed — only change if their argument is actually correct.",
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
    "Your DRAFT answer:",
    "---",
    draft,
    "---",
    "",
    `CRITIQUE from peer (${peer}):`,
    "---",
    critique,
    "---",
    "",
    "Now produce your final answer. Think step by step, then on the LAST line of your response output exactly:",
    "Answer: X",
    "",
    "where X is one of A, B, C, or D.",
  ].join("\n");
}

function pickPeer(questionId: string): string {
  const hash = crypto.createHash("sha256").update(questionId).digest();
  const idx = hash[0] % CODEX_PEERS.length;
  return CODEX_PEERS[idx];
}

function dispatchClaude(prompt: string, timeoutMs: number): { stdout: string; stderr: string; status: number | null } {
  const r = child_process.spawnSync(
    "claude",
    ["-p", "--output-format", "text", prompt],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function dispatchCodex(prompt: string, timeoutMs: number): { stdout: string; stderr: string; status: number | null } {
  const r = child_process.spawnSync(
    "codex",
    ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
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
    } catch { /* tolerate */ }
  }
  return ids;
}

/** Find IDs to retry: extracted-answer is null AND any of the 3 calls
 *  emitted an error or had len 0. Refusals (any of the 3 responses
 *  containing "Usage Policy" canned text) are NOT retried. */
function findFailureIds(resultsPath: string): Set<string> {
  if (!fs.existsSync(resultsPath)) return new Set();
  const lines = fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean);
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.answer_extracted === null && r.error) {
        // Don't retry refusals (any response body containing the canned
        // text). Heuristic: refusal mentions "Usage Policy".
        const blob = `${r.claude_draft_response ?? ""}${r.codex_critique_response ?? ""}${r.claude_revised_response ?? ""}`;
        if (!/Usage Policy|usage policy/.test(blob)) ids.add(r.id);
      }
    } catch { /* tolerate */ }
  }
  return ids;
}

function stripIds(resultsPath: string, idsToDrop: Set<string>): number {
  if (!fs.existsSync(resultsPath)) return 0;
  const lines = fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (idsToDrop.has(r.id)) dropped++;
      else kept.push(line);
    } catch {
      kept.push(line);
    }
  }
  fs.writeFileSync(resultsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  return dropped;
}

function parseArgs(argv: string[]): { limit?: number; out?: string; start?: number; stop?: number; timeoutMs: number; retryTimeouts?: boolean } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--start") out.start = parseInt(argv[++i], 10);
    else if (a === "--stop") out.stop = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--retry-timeouts") out.retryTimeouts = true;
  }
  if (out.timeoutMs === undefined) out.timeoutMs = 1_200_000;  // 20 min/call default
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsPath = args.out ?? path.join(RESULTS_DIR, "agent-chat.jsonl");
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

  if (args.retryTimeouts) {
    const ids = findFailureIds(resultsPath);
    const dropped = stripIds(resultsPath, ids);
    console.error(`# --retry-timeouts: dropped ${dropped} failed entries from ${resultsPath}; will re-run with timeout-ms=${args.timeoutMs}`);
  }

  const problems = loadProblems();
  const completed = loadCompletedIds(resultsPath);
  const start = args.start ?? 0;
  const stop = args.stop ?? problems.length;
  const slice = problems.slice(start, stop);
  const todo = slice.filter((p) => !completed.has(p.id)).slice(0, args.limit ?? slice.length);

  console.error(`# agent-chat condition: ${todo.length} problems pending (${completed.size} already done; range [${start}, ${stop}); timeout-ms=${args.timeoutMs} per call → 3x = ${args.timeoutMs * 3 / 1000}s/problem worst-case)`);

  let i = 0;
  for (const p of todo) {
    i++;
    const t0 = Date.now();
    const peer = pickPeer(p.id);

    // ---- Call 1: claude draft ----
    const draftPrompt = buildDraftPrompt(p);
    const tDraft0 = Date.now();
    const draftR = dispatchClaude(draftPrompt, args.timeoutMs);
    const draftElapsed = Date.now() - tDraft0;
    const draftResponse = draftR.stdout.trim();
    const draftLetter = draftResponse ? extractAnswer(draftResponse) : null;
    const draftError = draftR.status !== 0 && !draftResponse
      ? `claude draft cli exited ${draftR.status}: ${draftR.stderr.slice(0, 200)}`
      : undefined;

    if (draftError) {
      // If draft fails outright, skip critique/revise and record the failure.
      const entry: ResultEntry = {
        id: p.id, domain: p.domain, subdomain: p.subdomain, model: "agent-chat", peer,
        claude_draft_response: draftResponse, claude_draft_letter: draftLetter,
        codex_critique_response: "", claude_revised_response: "",
        answer_extracted: null, answer_expected: p.answer, correct: false,
        elapsed_ms: Date.now() - t0,
        elapsed_ms_draft: draftElapsed, elapsed_ms_critique: 0, elapsed_ms_revise: 0,
        prompt_chars_draft: draftPrompt.length, prompt_chars_critique: 0, prompt_chars_revise: 0,
        error: draftError,
      };
      fs.appendFileSync(resultsPath, JSON.stringify(entry) + "\n");
      console.error(`# [${i}/${todo.length}] ${p.id} ${p.domain.slice(0,7)}/${p.subdomain.slice(0,15)} DRAFT-FAIL (${draftElapsed}ms)`);
      continue;
    }

    // ---- Call 2: codex critique ----
    const critiquePrompt = buildCritiquePrompt(p, peer, draftResponse, draftLetter);
    const tCrit0 = Date.now();
    const critR = dispatchCodex(critiquePrompt, args.timeoutMs);
    const critElapsed = Date.now() - tCrit0;
    const critResponse = critR.stdout.trim();
    const critError = critR.status !== 0 && !critResponse
      ? `codex critique cli exited ${critR.status}: ${critR.stderr.slice(0, 200)}`
      : undefined;
    // Critique failure is non-fatal: skip the revise step but still
    // count the draft answer as the agent-chat result. This way a
    // codex hiccup doesn't penalize agent-chat below claude-alone.
    if (critError) {
      const entry: ResultEntry = {
        id: p.id, domain: p.domain, subdomain: p.subdomain, model: "agent-chat", peer,
        claude_draft_response: draftResponse, claude_draft_letter: draftLetter,
        codex_critique_response: "", claude_revised_response: draftResponse,
        answer_extracted: draftLetter, answer_expected: p.answer,
        correct: draftLetter === p.answer,
        elapsed_ms: Date.now() - t0,
        elapsed_ms_draft: draftElapsed, elapsed_ms_critique: critElapsed, elapsed_ms_revise: 0,
        prompt_chars_draft: draftPrompt.length, prompt_chars_critique: critiquePrompt.length, prompt_chars_revise: 0,
        error: critError,
      };
      fs.appendFileSync(resultsPath, JSON.stringify(entry) + "\n");
      console.error(`# [${i}/${todo.length}] ${p.id} ${p.domain.slice(0,7)}/${p.subdomain.slice(0,15)} CRIT-FAIL kept-draft=${draftLetter ?? "?"} expected=${p.answer} ${draftLetter === p.answer ? "✓" : "✗"} (draft=${draftElapsed}ms crit=${critElapsed}ms)`);
      continue;
    }

    // ---- Call 3: claude revise ----
    const revisePrompt = buildRevisePrompt(p, draftResponse, critResponse, peer);
    const tRev0 = Date.now();
    const revR = dispatchClaude(revisePrompt, args.timeoutMs);
    const revElapsed = Date.now() - tRev0;
    const revResponse = revR.stdout.trim();
    const revLetter = revResponse ? extractAnswer(revResponse) : null;
    const revError = revR.status !== 0 && !revResponse
      ? `claude revise cli exited ${revR.status}: ${revR.stderr.slice(0, 200)}`
      : undefined;

    // If revise fails: fall back to draft answer.
    const finalLetter = revError ? draftLetter : revLetter;
    const finalCorrect = finalLetter === p.answer;

    const entry: ResultEntry = {
      id: p.id, domain: p.domain, subdomain: p.subdomain, model: "agent-chat", peer,
      claude_draft_response: draftResponse, claude_draft_letter: draftLetter,
      codex_critique_response: critResponse,
      claude_revised_response: revResponse,
      answer_extracted: finalLetter, answer_expected: p.answer, correct: finalCorrect,
      elapsed_ms: Date.now() - t0,
      elapsed_ms_draft: draftElapsed, elapsed_ms_critique: critElapsed, elapsed_ms_revise: revElapsed,
      prompt_chars_draft: draftPrompt.length, prompt_chars_critique: critiquePrompt.length, prompt_chars_revise: revisePrompt.length,
      ...(revError ? { error: revError } : {}),
    };
    fs.appendFileSync(resultsPath, JSON.stringify(entry) + "\n");

    const flipFlag = (draftLetter !== null && revLetter !== null && draftLetter !== revLetter) ? " FLIP" : "";
    console.error(`# [${i}/${todo.length}] ${p.id} ${p.domain.slice(0,7)}/${p.subdomain.slice(0,15)} draft=${draftLetter ?? "?"}→${revLetter ?? "?"} expected=${p.answer} ${finalCorrect ? "✓" : "✗"} peer=${peer} (draft=${draftElapsed}ms crit=${critElapsed}ms rev=${revElapsed}ms total=${(Date.now()-t0)/1000|0}s)${flipFlag}`);
  }

  console.error(`# done; results in ${resultsPath}`);
}

main().catch((err) => {
  console.error(`# FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
