#!/usr/bin/env bun
// auto-study-turn-consumer.ts — Phase A2 (NL35).
//
// Reads `.auto-study-turn.jsonl` schedule entries (written by the
// record-turn post-hook in agent-chat.ts under AGENT_CHAT_AUTO_STUDY_TURN=1),
// picks the oldest unprocessed entry, dispatches a codex peer (per
// the heterogeneity rule: never the answer's own author), grades the
// peer's prediction against the actual answer body via
// cosineSimilarity, applies the grade via applyGradeToLift, and
// appends a result line to `.auto-study-turn-results.jsonl`.
//
// Each invocation processes ONE entry and exits — caller decides
// cadence (cron, interval, or fired from the record-turn post-hook).
// This keeps each run small and crash-isolated.
//
// Heterogeneity rule (INVIOLABLE rule 5 from prompt.md): the picked
// peer MUST be codex (lumeyon, keystone, or carina per the petersen
// topology) AND must NOT match the answer's by_agent. If the
// answer was authored by a codex peer, the consumer picks a
// different codex peer for the prediction.
//
// Test seam: AGENT_CHAT_MOCK_PEER_RESPONSE returns a canned predictor
// output bypassing the real codex CLI (same pattern as
// ephemeral-peer-review.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LatticeStore, makeAnswerId } from "../../../scripts/lattice/sqlite-store.ts";
import {
  buildStudyPrompt,
  gradePrediction,
  applyGradeToLift,
  type Predictor,
  type StudyCandidate,
} from "../../../scripts/lattice/study-turn.ts";
import { canonicalIdOf } from "../../../scripts/lattice/import-from-kg.ts";
import { CONVERSATIONS_DIR } from "./lib.ts";

interface ScheduleEntry {
  ts: string;
  edge_id: string;
  agent: string;
  speaker: string;
  framing: string;
  answer_body: string;
  status: string;
}

interface ResultEntry {
  schedule_ts: string;
  ts: string;
  peer: string;
  status: "predicted" | "failed";
  prediction?: string;       // truncated; full text in stderr if needed
  grade?: { cosine: number; passed: boolean; threshold: number; gradable: boolean };
  lift_update?: { answer_id: string; old_lift: number; new_lift: number; delta: number };
  error?: string;
}

// All codex peers in the petersen topology, in a stable rotation order.
const CODEX_PEERS = ["lumeyon", "keystone", "carina"] as const;

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

function appendJsonl<T>(filePath: string, entry: T): void {
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

/** Pick a codex peer for the given question, skipping the answer's own
 *  author. Heterogeneity rule: the predictor must be a different model
 *  family AND a different agent than the answer's author. Hash the
 *  question_id to spread across peers deterministically; rotate forward
 *  if the picked peer matches the excluded agent. */
function pickPredictorPeer(questionId: string, excludeAgent: string): string {
  const hash = crypto.createHash("sha256").update(questionId).digest();
  const start = hash[0] % CODEX_PEERS.length;
  for (let i = 0; i < CODEX_PEERS.length; i++) {
    const peer = CODEX_PEERS[(start + i) % CODEX_PEERS.length];
    if (peer !== excludeAgent) return peer;
  }
  // Should be unreachable: there are 3 codex peers and only 1 excluded.
  throw new Error(`pickPredictorPeer: no eligible codex peer for excludeAgent="${excludeAgent}"`);
}

/** Build the dispatcher for the picked peer. Honors the
 *  AGENT_CHAT_MOCK_PEER_RESPONSE test seam — returns a predictor
 *  function that, when called, either returns the mocked response or
 *  shells out via the codex runtime adapter. */
async function buildPeerPredictor(peer: string): Promise<Predictor> {
  const mockResponse = process.env.AGENT_CHAT_MOCK_PEER_RESPONSE;
  if (mockResponse !== undefined) {
    return async (_challenge) => mockResponse;
  }
  // Real path: dispatch via the codex runtime adapter. All petersen
  // peers run codex per agents.petersen.yaml, so we always use the codex
  // adapter regardless of which peer name we picked.
  const adapter = await import("./runtimes/codex.ts");
  return async (challenge) => {
    const promptText =
      `You are ${peer}. Answer this question concisely (1-3 sentences).\n\n` +
      `Question: ${challenge.question_framing}\n\n` +
      (challenge.peer_explanations.length > 0
        ? `Hints from peer answers:\n${challenge.peer_explanations.map((e) => `- ${e}`).join("\n")}\n\n`
        : "") +
      `Answer:`;
    const r = await adapter.dispatch({ prompt: promptText, timeoutMs: 90_000 });
    if (r.reason !== "ok" || !r.stdout) {
      throw new Error(`codex dispatch failed for ${peer}: reason=${r.reason} stderr=${r.stderr.slice(0, 200)}`);
    }
    return r.stdout.trim();
  };
}

async function main(): Promise<number> {
  const journalPath = path.join(CONVERSATIONS_DIR, ".auto-study-turn.jsonl");
  const resultsPath = path.join(CONVERSATIONS_DIR, ".auto-study-turn-results.jsonl");

  const scheduled = readJsonl<ScheduleEntry>(journalPath);
  if (scheduled.length === 0) return 0;

  const results = readJsonl<ResultEntry>(resultsPath);
  const processedTs = new Set(results.map((r) => r.schedule_ts));

  const pending = scheduled.filter((s) => !processedTs.has(s.ts));
  if (pending.length === 0) return 0;

  // Process the OLDEST pending entry. Other pending entries wait for
  // future ticks. One-entry-per-invocation keeps each run small,
  // crash-isolated, and predictable in cost.
  pending.sort((a, b) => a.ts.localeCompare(b.ts));
  const entry = pending[0];

  const writeFailure = (errMsg: string, peer: string = "unknown") => {
    const r: ResultEntry = {
      schedule_ts: entry.ts,
      ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      peer,
      status: "failed",
      error: errMsg.slice(0, 500),
    };
    appendJsonl(resultsPath, r);
  };

  // Look up the answer in the lattice. canonical_id from framing,
  // answer_id from (canonical_id + answer_body + agent). If either
  // lookup fails, mark the entry failed and exit cleanly — this
  // happens when the journal was written but the lattice import
  // hasn't run for the affected edge yet.
  const dbPath = process.env.AGENT_CHAT_LATTICE_DB ?? path.join(CONVERSATIONS_DIR, "lattice.db");
  if (!fs.existsSync(dbPath)) {
    writeFailure(`lattice DB not found at ${dbPath}`);
    return 0;
  }

  const store = new LatticeStore(dbPath);
  let exitCode = 0;
  try {
    const questionId = canonicalIdOf(entry.framing);
    const question = store.getQuestion(questionId);
    if (!question) {
      writeFailure(`question not found in lattice: canonical_id=${questionId} framing=${entry.framing.slice(0, 80)}`);
      return 0;
    }

    const answerId = makeAnswerId(questionId, entry.answer_body, entry.agent);
    const answer = store.getAnswer(answerId);
    if (!answer) {
      writeFailure(`answer not found in lattice: answer_id=${answerId} agent=${entry.agent}`);
      return 0;
    }

    // Heterogeneity-first peer selection: pick a codex peer that's not
    // the answer's own author.
    const peer = pickPredictorPeer(questionId, entry.agent);

    // Build the study candidate manually (we already have the question
    // and answer; selectStudyQuestions is unnecessary here).
    const candidate: StudyCandidate = {
      question,
      actual_answer: answer,
      peer_explanations: [],
    };

    let predictor: Predictor;
    try {
      predictor = await buildPeerPredictor(peer);
    } catch (err) {
      writeFailure(`predictor setup failed: ${(err as Error)?.message ?? err}`, peer);
      return 0;
    }

    const challenge = buildStudyPrompt(candidate);
    let prediction: string;
    try {
      prediction = await predictor(challenge);
    } catch (err) {
      writeFailure(`dispatch failed: ${(err as Error)?.message ?? err}`, peer);
      return 0;
    }

    const grade = await gradePrediction(prediction, answer.body, 0.85);
    const liftUpdate = grade.gradable
      ? applyGradeToLift(store, answer.id, grade, 0.1)
      : { answer_id: answer.id, old_lift: answer.predictive_lift, new_lift: answer.predictive_lift, delta: 0 };

    const result: ResultEntry = {
      schedule_ts: entry.ts,
      ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      peer,
      status: "predicted",
      prediction: prediction.length > 200 ? prediction.slice(0, 197) + "..." : prediction,
      grade: { cosine: grade.cosine, passed: grade.passed, threshold: grade.threshold, gradable: grade.gradable },
      lift_update: liftUpdate,
    };
    appendJsonl(resultsPath, result);
  } finally {
    store.close();
  }

  return exitCode;
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[auto-study-turn-consumer] FATAL: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
}
