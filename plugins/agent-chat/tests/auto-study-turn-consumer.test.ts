// Phase A2 (NL35): tests for the auto-study-turn consumer that reads
// `.auto-study-turn.jsonl`, dispatches a codex peer (heterogeneity rule:
// never the answer's own author), grades, applies lift, and writes a
// result entry.
//
// Test seam: AGENT_CHAT_MOCK_PEER_RESPONSE returns a canned predictor
// output bypassing the real codex CLI (same pattern as ephemeral-peer-
// review.ts uses).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTmpConversations, rmTmp, runScript, freshEnv } from "./helpers.ts";
import { LatticeStore } from "../../../scripts/lattice/sqlite-store.ts";
import { recordAnswer } from "../../../scripts/lattice/apprenticeship.ts";
import { canonicalIdOf } from "../../../scripts/lattice/import-from-kg.ts";
import type { Question } from "../../../scripts/lattice/types.ts";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkTmpConversations();
  dbPath = path.join(tmp, "lattice.db");
});
afterEach(() => { rmTmp(tmp); });

function seedQuestionAndAnswer(
  store: LatticeStore,
  framing: string,
  answerBody: string,
  byAgent: string,
  initialLift: number = 0.5,
): { questionId: string; answerId: string } {
  const questionId = canonicalIdOf(framing);
  const q: Question = {
    id: questionId,
    framing,
    status: "open",
    best_answer_id: null,
    posed_at: 1000,
    posed_by: "boss",
    posed_in_context: "test",
    depth: 0,
  };
  store.putQuestion(q);
  const a = recordAnswer(store, {
    question_id: questionId,
    body: answerBody,
    by_agent: byAgent,
    explanation: "test explanation",
    predictive_lift: initialLift,
    status: "accepted",
    quality_tier: 2,
  });
  store.setQuestionStatus(questionId, "answered", a.id);
  return { questionId, answerId: a.id };
}

function writeJournal(...entries: object[]): void {
  const journalPath = path.join(tmp, ".auto-study-turn.jsonl");
  fs.writeFileSync(journalPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function readResults(): any[] {
  const resultsPath = path.join(tmp, ".auto-study-turn-results.jsonl");
  if (!fs.existsSync(resultsPath)) return [];
  return fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function consumerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return freshEnv({
    AGENT_CHAT_CONVERSATIONS_DIR: tmp,
    AGENT_CHAT_LATTICE_DB: dbPath,
    ...extra,
  }) as Record<string, string>;
}

describe("auto-study-turn-consumer — A2", () => {
  test("A2-a: happy path — picks oldest scheduled entry, dispatches codex peer, writes result with lift update", () => {
    const store = new LatticeStore(dbPath);
    const { questionId, answerId } = seedQuestionAndAnswer(
      store,
      "What is the deadline?",
      "Friday at 5pm.",
      "orion",
      0.5,
    );
    const initialLift = store.getAnswer(answerId)!.predictive_lift;
    expect(initialLift).toBe(0.5);
    store.close();

    writeJournal({
      ts: "2026-05-08T10:00:00Z",
      edge_id: "boss-orion",
      agent: "orion",
      speaker: "boss",
      framing: "What is the deadline?",
      answer_body: "Friday at 5pm.",
      status: "scheduled",
    });

    // Mock the codex predictor to return a high-similarity prediction so
    // gradePrediction yields a positive cosine and applyGradeToLift bumps
    // lift upward.
    const r = runScript(
      "auto-study-turn-consumer.ts",
      [],
      consumerEnv({
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Friday at 5pm.",  // matches actual → high cosine
      }),
    );
    expect(r.exitCode).toBe(0);

    const results = readResults();
    expect(results.length).toBe(1);
    expect(results[0].schedule_ts).toBe("2026-05-08T10:00:00Z");
    expect(results[0].status).toBe("predicted");
    expect(results[0].peer).toMatch(/^(lumeyon|keystone|carina)$/);
    expect(results[0].peer).not.toBe("orion");  // heterogeneity: never the answer's own author
    expect(results[0].grade).toBeDefined();
    expect(typeof results[0].grade.cosine).toBe("number");
    expect(results[0].lift_update).toBeDefined();
    expect(typeof results[0].lift_update.delta).toBe("number");

    // Lattice's predictive_lift was actually written.
    const store2 = new LatticeStore(dbPath);
    try {
      const updated = store2.getAnswer(answerId)!;
      // High-similarity prediction → positive lift bump.
      expect(updated.predictive_lift).toBeGreaterThan(initialLift);
    } finally {
      store2.close();
    }
  });

  test("A2-b: heterogeneity rule — picked peer is NEVER the answer's own author", () => {
    const store = new LatticeStore(dbPath);
    // Seed an answer authored by lumeyon. The hash-derived peer might
    // also be lumeyon; the consumer must skip and pick a different
    // codex peer.
    seedQuestionAndAnswer(store, "Some question", "Some answer", "lumeyon");
    store.close();

    writeJournal({
      ts: "2026-05-08T10:00:00Z",
      edge_id: "lumeyon-orion",
      agent: "lumeyon",
      speaker: "boss",
      framing: "Some question",
      answer_body: "Some answer",
      status: "scheduled",
    });

    const r = runScript(
      "auto-study-turn-consumer.ts",
      [],
      consumerEnv({
        AGENT_CHAT_MOCK_PEER_RESPONSE: "Predicted output.",
      }),
    );
    expect(r.exitCode).toBe(0);

    const results = readResults();
    expect(results.length).toBe(1);
    expect(results[0].peer).not.toBe("lumeyon");  // heterogeneity guard
    expect(results[0].peer).toMatch(/^(keystone|carina)$/);
  });

  test("A2-c: dispatch failure — entry marked failed, doesn't crash, doesn't pollute other entries", () => {
    const store = new LatticeStore(dbPath);
    seedQuestionAndAnswer(store, "Q1", "A1", "orion");
    seedQuestionAndAnswer(store, "Q2", "A2", "orion");
    store.close();

    writeJournal(
      { ts: "2026-05-08T10:00:00Z", edge_id: "boss-orion", agent: "orion", speaker: "boss", framing: "Q1", answer_body: "A1", status: "scheduled" },
      { ts: "2026-05-08T10:01:00Z", edge_id: "boss-orion", agent: "orion", speaker: "boss", framing: "Q2", answer_body: "A2", status: "scheduled" },
    );

    // Force dispatch failure by NOT setting a mock and relying on
    // freshEnv's AGENT_CHAT_NO_LLM=1 default → codex adapter returns
    // reason=not-found.
    const r = runScript(
      "auto-study-turn-consumer.ts",
      [],
      consumerEnv({}),
    );
    expect(r.exitCode).toBe(0);  // doesn't crash on dispatch failure

    const results = readResults();
    expect(results.length).toBe(1);  // only the OLDEST scheduled entry got processed
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBeDefined();
    expect(results[0].schedule_ts).toBe("2026-05-08T10:00:00Z");  // oldest
  });

  test("A2-d: empty journal — exits 0 silently, writes nothing", () => {
    // No journal file at all.
    const r = runScript(
      "auto-study-turn-consumer.ts",
      [],
      consumerEnv({}),
    );
    expect(r.exitCode).toBe(0);
    expect(readResults()).toEqual([]);
  });

  test("A2-e: idempotent re-run — already-processed entries are skipped", () => {
    const store = new LatticeStore(dbPath);
    seedQuestionAndAnswer(store, "Some question", "Some answer", "orion");
    store.close();

    writeJournal({
      ts: "2026-05-08T10:00:00Z",
      edge_id: "boss-orion",
      agent: "orion",
      speaker: "boss",
      framing: "Some question",
      answer_body: "Some answer",
      status: "scheduled",
    });

    // First run processes the entry.
    runScript(
      "auto-study-turn-consumer.ts", [],
      consumerEnv({ AGENT_CHAT_MOCK_PEER_RESPONSE: "Predicted." }),
    );
    expect(readResults().length).toBe(1);

    // Second run: same scheduled entry, but it already has a result
    // line. Consumer must skip it (find no unprocessed entries).
    const r = runScript(
      "auto-study-turn-consumer.ts", [],
      consumerEnv({ AGENT_CHAT_MOCK_PEER_RESPONSE: "Different prediction." }),
    );
    expect(r.exitCode).toBe(0);
    expect(readResults().length).toBe(1);  // no new result; idempotent skip
  });

  test("A2-f: missing answer in lattice — entry marked failed with diagnostic", () => {
    // Schedule entry references a Q/A that's not actually in the lattice.
    // (E.g., journal was written but lattice import never ran for this
    // edge.) Consumer should mark the entry failed gracefully.
    // Create an empty lattice DB so the consumer reaches the question
    // lookup step (vs failing earlier on missing DB file).
    const store = new LatticeStore(dbPath);
    store.close();
    writeJournal({
      ts: "2026-05-08T10:00:00Z",
      edge_id: "boss-orion",
      agent: "orion",
      speaker: "boss",
      framing: "Question never imported",
      answer_body: "Answer never imported",
      status: "scheduled",
    });

    const r = runScript(
      "auto-study-turn-consumer.ts", [],
      consumerEnv({ AGENT_CHAT_MOCK_PEER_RESPONSE: "P." }),
    );
    expect(r.exitCode).toBe(0);

    const results = readResults();
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toMatch(/answer not found|question not found/i);
  });
});
