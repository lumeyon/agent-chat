// sqlite-store.test.ts — Phase 6 tests for the multi-dim sqlite indices.
//
// Tests the contract from docs/inquiry-lattice.md "The multi-dimensional
// structure": multi-axis queries via index intersection, citation DAG
// traversal, cycle prevention, and the dual-audience-fusion-required
// fields (quality_tier, predictive_lift, validator_id).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { LatticeStore, makeAnswerId } from "./sqlite-store.ts";
import type { Question, Answer } from "./types.ts";

let store: LatticeStore;

beforeEach(() => {
  store = new LatticeStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: "v1:abc123def4567890",
    framing: "What is the deadline?",
    status: "open",
    best_answer_id: null,
    posed_at: 1000,
    posed_by: "boss",
    posed_in_context: "/petersen/boss-orion",
    depth: 0,
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: makeAnswerId("v1:abc123def4567890", "Friday at 5pm.", "orion"),
    question_id: "v1:abc123def4567890",
    body: "Friday at 5pm.",
    explanation: "Quoted directly from the project plan.",
    by_agent: "orion",
    predictive_lift: 0.5,
    status: "proposed",
    quality_tier: 3,
    created_at: 1010,
    validator_id: null,
    ...overrides,
  };
}

describe("LatticeStore — Question CRUD", () => {
  test("put + get round-trip", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    const fetched = store.getQuestion(q.id);
    expect(fetched).toEqual(q);
  });

  test("get unknown id returns null", () => {
    expect(store.getQuestion("v1:nonexistent")).toBeNull();
  });

  test("setQuestionStatus updates lifecycle", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    // The K1 FK guard requires the best_answer_id to point at an
    // existing accepted answer for this question.
    const a = makeAnswer({ id: "ans:abc123def4567890", status: "accepted" });
    store.putAnswer(a);
    store.setQuestionStatus(q.id, "answered", "ans:abc123def4567890");
    const fetched = store.getQuestion(q.id);
    expect(fetched?.status).toBe("answered");
    expect(fetched?.best_answer_id).toBe("ans:abc123def4567890");
  });

  test("status check constraint rejects invalid values", () => {
    const q = makeQuestion();
    expect(() => {
      store.putQuestion({ ...q, status: "bogus" as any });
    }).toThrow();
  });
});

describe("LatticeStore — multi-axis question query", () => {
  beforeEach(() => {
    // Seed a varied set of questions for filtering tests.
    const seeds: Question[] = [
      makeQuestion({ id: "v1:q1", posed_at: 100, posed_by: "boss",  status: "open",     depth: 0 }),
      makeQuestion({ id: "v1:q2", posed_at: 200, posed_by: "boss",  status: "answered", depth: 1, best_answer_id: "ans:q2-best" }),
      makeQuestion({ id: "v1:q3", posed_at: 300, posed_by: "orion", status: "answered", depth: 2, best_answer_id: "ans:q3-best" }),
      makeQuestion({ id: "v1:q4", posed_at: 400, posed_by: "orion", status: "closed",   depth: 0, best_answer_id: "ans:q4-best" }),
      makeQuestion({ id: "v1:q5", posed_at: 500, posed_by: "john",  status: "reopened", depth: 1 }),
    ];
    for (const q of seeds) store.putQuestion(q);
  });

  test("filter by status (single)", () => {
    const out = store.queryQuestions({ status: "answered" });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q3"]);
  });

  test("filter by status (array)", () => {
    const out = store.queryQuestions({ status: ["closed", "reopened"] });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q4", "v1:q5"]);
  });

  test("filter by posed_by (agent index)", () => {
    const out = store.queryQuestions({ posed_by: "orion" });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q3", "v1:q4"]);
  });

  test("temporal range filter", () => {
    const out = store.queryQuestions({ posed_at_after: 200, posed_at_before: 500 });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q3", "v1:q4"]);
  });

  test("depth filter (depth_min, depth_max)", () => {
    const out = store.queryQuestions({ depth_min: 1, depth_max: 1 });
    expect(out.map((q) => q.id).sort()).toEqual(["v1:q2", "v1:q5"]);
  });

  test("multi-axis intersection: answered AND posed by orion", () => {
    const out = store.queryQuestions({ status: "answered", posed_by: "orion" });
    expect(out.map((q) => q.id)).toEqual(["v1:q3"]);
  });

  test("multi-axis intersection: by boss in temporal window AND open", () => {
    const out = store.queryQuestions({
      posed_by: "boss",
      posed_at_after: 0,
      posed_at_before: 250,
      status: "open",
    });
    expect(out.map((q) => q.id)).toEqual(["v1:q1"]);
  });

  test("ordering: posed_at DESC by default", () => {
    const out = store.queryQuestions({});
    expect(out.map((q) => q.id)).toEqual(["v1:q5", "v1:q4", "v1:q3", "v1:q2", "v1:q1"]);
  });

  test("ordering: posed_at ASC explicit", () => {
    const out = store.queryQuestions({ order_by: "posed_at_asc" });
    expect(out.map((q) => q.id)).toEqual(["v1:q1", "v1:q2", "v1:q3", "v1:q4", "v1:q5"]);
  });

  test("limit caps result set", () => {
    const out = store.queryQuestions({ limit: 2 });
    expect(out.length).toBe(2);
  });
});

describe("LatticeStore — Answer CRUD + multi-axis", () => {
  beforeEach(() => {
    store.putQuestion(makeQuestion({ id: "v1:q1" }));
    store.putQuestion(makeQuestion({ id: "v1:q2" }));
    const seeds: Answer[] = [
      makeAnswer({ id: "ans:a1", question_id: "v1:q1", by_agent: "orion",  status: "accepted",   predictive_lift: 0.9, quality_tier: 2 }),
      makeAnswer({ id: "ans:a2", question_id: "v1:q1", by_agent: "lumeyon", status: "proposed",  predictive_lift: 0.4, quality_tier: 4 }),
      makeAnswer({ id: "ans:a3", question_id: "v1:q2", by_agent: "orion",  status: "accepted",   predictive_lift: 0.7, quality_tier: 1, validator_id: "boss" }),
      makeAnswer({ id: "ans:a4", question_id: "v1:q2", by_agent: "carina", status: "refuted",    predictive_lift: 0.1, quality_tier: 5 }),
    ];
    for (const a of seeds) store.putAnswer(a);
  });

  test("filter by question_id", () => {
    const out = store.queryAnswers({ question_id: "v1:q1" });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a2"]);
  });

  test("filter by by_agent", () => {
    const out = store.queryAnswers({ by_agent: "orion" });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("filter by quality_tier_min (tier 1 is best)", () => {
    const out = store.queryAnswers({ quality_tier_min: 2 });
    // tier 1 and tier 2 answers
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("filter by predictive_lift_min", () => {
    const out = store.queryAnswers({ predictive_lift_min: 0.5 });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });

  test("ordering: predictive_lift DESC by default", () => {
    const out = store.queryAnswers({});
    expect(out.map((a) => a.id)).toEqual(["ans:a1", "ans:a3", "ans:a2", "ans:a4"]);
  });

  test("multi-axis: orion's accepted answers with predictive_lift > 0.5", () => {
    const out = store.queryAnswers({
      by_agent: "orion",
      status: "accepted",
      predictive_lift_min: 0.5,
    });
    expect(out.map((a) => a.id).sort()).toEqual(["ans:a1", "ans:a3"]);
  });
});

describe("LatticeStore — Citation DAG", () => {
  beforeEach(() => {
    store.putQuestion(makeQuestion());
    for (const id of ["ans:a", "ans:b", "ans:c", "ans:d"]) {
      store.putAnswer(makeAnswer({ id }));
    }
  });

  test("addCitation + getCitedAnswers + getCitingAnswers", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:a", "ans:c");
    store.addCitation("ans:b", "ans:d");

    expect(store.getCitedAnswers("ans:a").map((c) => c.child_answer_id).sort()).toEqual(
      ["ans:b", "ans:c"],
    );
    expect(store.getCitingAnswers("ans:d").map((c) => c.parent_answer_id)).toEqual(["ans:b"]);
  });

  test("cycle prevention — direct loop refused", () => {
    store.addCitation("ans:a", "ans:b");
    expect(() => store.addCitation("ans:b", "ans:a")).toThrow(/cycle/);
  });

  test("cycle prevention — transitive cycle refused", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:b", "ans:c");
    expect(() => store.addCitation("ans:c", "ans:a")).toThrow(/cycle/);
  });

  test("self-citation refused", () => {
    expect(() => store.addCitation("ans:a", "ans:a")).toThrow(/self/);
  });

  test("non-cyclic citations work after a near-cycle was rejected", () => {
    store.addCitation("ans:a", "ans:b");
    store.addCitation("ans:b", "ans:c");
    expect(() => store.addCitation("ans:c", "ans:a")).toThrow();
    // ans:d isn't in the cycle path; (a, d) is fine.
    store.addCitation("ans:a", "ans:d");
    expect(store.getCitedAnswers("ans:a").length).toBe(2);
  });

  // Regression for keystone's iter-6 K3 finding: pre-iter-8 the cycle
  // check + INSERT pair was not transactional, so two connections to the
  // same file could interleave and produce a cycle. Iter-8 wraps both
  // operations in BEGIN IMMEDIATE. This test verifies the multi-connection
  // path: cycle detection sees the OTHER connection's committed state.
  test("multi-connection cycle detection — second connection sees first's committed citation", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k3-citation-"));
    const dbFile = path.join(tmp, "race.db");
    try {
      const storeA = new LatticeStore(dbFile);
      const storeB = new LatticeStore(dbFile);
      storeA.putQuestion(makeQuestion({ id: "v1:q-shared" }));
      const a1 = makeAnswer({ id: "ans:r1", question_id: "v1:q-shared" });
      const a2 = makeAnswer({ id: "ans:r2", question_id: "v1:q-shared" });
      storeA.putAnswer(a1);
      storeA.putAnswer(a2);

      // storeA writes (r1 → r2). storeB then tries (r2 → r1). storeB MUST
      // see storeA's committed citation under BEGIN IMMEDIATE and refuse.
      storeA.addCitation("ans:r1", "ans:r2");
      expect(() => storeB.addCitation("ans:r2", "ans:r1")).toThrow(/cycle/);

      storeA.close();
      storeB.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("LatticeStore — Question DAG", () => {
  beforeEach(() => {
    for (const id of ["v1:q1", "v1:q2", "v1:q3"]) {
      store.putQuestion(makeQuestion({ id }));
    }
  });

  test("addQuestionParent + traversal", () => {
    store.addQuestionParent("v1:q1", "v1:q2");
    store.addQuestionParent("v1:q1", "v1:q3");
    expect(store.getQuestionChildren("v1:q1").map((p) => p.child_question_id).sort()).toEqual(
      ["v1:q2", "v1:q3"],
    );
    expect(store.getQuestionParents("v1:q2").map((p) => p.parent_question_id)).toEqual(["v1:q1"]);
  });

  test("cycle prevention on question DAG", () => {
    store.addQuestionParent("v1:q1", "v1:q2");
    store.addQuestionParent("v1:q2", "v1:q3");
    expect(() => store.addQuestionParent("v1:q3", "v1:q1")).toThrow(/cycle/);
  });

  // K3 sibling test for question DAG (mirrors the addCitation
  // multi-connection regression added above).
  test("multi-connection cycle detection — second connection sees first's committed question_parent", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k3-qparent-"));
    const dbFile = path.join(tmp, "race.db");
    try {
      const storeA = new LatticeStore(dbFile);
      const storeB = new LatticeStore(dbFile);
      for (const id of ["v1:rq1", "v1:rq2"]) storeA.putQuestion(makeQuestion({ id }));

      storeA.addQuestionParent("v1:rq1", "v1:rq2");
      expect(() => storeB.addQuestionParent("v1:rq2", "v1:rq1")).toThrow(/cycle/);

      storeA.close();
      storeB.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("LatticeStore — stats and constraints", () => {
  test("stats reports correct counts", () => {
    store.putQuestion(makeQuestion({ id: "v1:q1" }));
    store.putQuestion(makeQuestion({ id: "v1:q2" }));
    store.putAnswer(makeAnswer({ id: "ans:a", question_id: "v1:q1" }));
    store.putAnswer(makeAnswer({ id: "ans:b", question_id: "v1:q2" }));
    store.addCitation("ans:b", "ans:a");
    store.addQuestionParent("v1:q1", "v1:q2");

    const s = store.stats();
    expect(s.questions).toBe(2);
    expect(s.answers).toBe(2);
    expect(s.citations).toBe(1);
    expect(s.question_parents).toBe(1);
  });

  test("foreign key constraint rejects citation referencing non-existent answer", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:a" }));
    expect(() => store.addCitation("ans:a", "ans:does_not_exist")).toThrow(/FOREIGN KEY/);
  });

  // Regression for lumeyon's iter-1 REAL #2 finding: putAnswer accepted
  // null/empty explanation silently, contradicting the dual-output forcing
  // function. Pre-fix the SQL-level INSERT succeeded; post-fix putAnswer
  // throws before the INSERT runs.
  test("putAnswer rejects null explanation (dual-output invariant)", () => {
    store.putQuestion(makeQuestion());
    expect(() =>
      store.putAnswer(makeAnswer({ explanation: null as any })),
    ).toThrow(/explanation/i);
  });

  test("putAnswer rejects empty-string explanation (dual-output invariant)", () => {
    store.putQuestion(makeQuestion());
    expect(() =>
      store.putAnswer(makeAnswer({ explanation: "" })),
    ).toThrow(/explanation/i);
  });

  test("putAnswer rejects whitespace-only explanation", () => {
    store.putQuestion(makeQuestion());
    expect(() =>
      store.putAnswer(makeAnswer({ explanation: "   \n\t  " })),
    ).toThrow(/explanation/i);
  });

  // Regression for lumeyon's iter-1 REAL #3 finding: Question.status and
  // best_answer_id were not jointly constrained — types.ts:39 documents
  // "Pointer into answers.id when status is answered or closed", but pre-fix
  // putQuestion / setQuestionStatus accepted any combination silently.
  test("putQuestion rejects open status with non-null best_answer_id", () => {
    expect(() =>
      store.putQuestion(makeQuestion({ status: "open", best_answer_id: "ans:bogus" })),
    ).toThrow(/best_answer_id|status/i);
  });

  test("putQuestion rejects reopened status with non-null best_answer_id", () => {
    expect(() =>
      store.putQuestion(makeQuestion({ status: "reopened", best_answer_id: "ans:bogus" })),
    ).toThrow(/best_answer_id|status/i);
  });

  test("putQuestion rejects answered status with null best_answer_id", () => {
    expect(() =>
      store.putQuestion(makeQuestion({ status: "answered", best_answer_id: null })),
    ).toThrow(/best_answer_id|status/i);
  });

  test("putQuestion rejects closed status with null best_answer_id", () => {
    expect(() =>
      store.putQuestion(makeQuestion({ status: "closed", best_answer_id: null })),
    ).toThrow(/best_answer_id|status/i);
  });

  test("setQuestionStatus rejects open status with non-null best_answer_id", () => {
    store.putQuestion(makeQuestion({ status: "answered", best_answer_id: "ans:x" }));
    store.putAnswer(makeAnswer({ id: "ans:x" }));
    expect(() =>
      store.setQuestionStatus(makeQuestion().id, "open", "ans:x"),
    ).toThrow(/best_answer_id|status/i);
  });

  test("setQuestionStatus rejects answered status with null best_answer_id", () => {
    store.putQuestion(makeQuestion({ status: "answered", best_answer_id: "ans:x" }));
    store.putAnswer(makeAnswer({ id: "ans:x" }));
    expect(() =>
      store.setQuestionStatus(makeQuestion().id, "answered", null),
    ).toThrow(/best_answer_id|status/i);
  });

  // Regression for keystone's iter-6 K1 finding: best_answer_id was not
  // FK-validated at setQuestionStatus. Pre-fix any non-empty string
  // passed (including missing answers, answers for another question,
  // or non-accepted answers).
  test("setQuestionStatus rejects answered when best_answer_id points to non-existent answer", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    expect(() =>
      store.setQuestionStatus(q.id, "answered", "ans:nonexistent"),
    ).toThrow(/best_answer_id|nonexistent/i);
  });

  test("setQuestionStatus rejects answered when best_answer_id points to answer for a DIFFERENT question", () => {
    const q1 = makeQuestion({ id: "v1:q-one" });
    const q2 = makeQuestion({ id: "v1:q-two" });
    store.putQuestion(q1);
    store.putQuestion(q2);
    // Create an answer for q2.
    const a2 = makeAnswer({ id: "ans:for-q2", question_id: "v1:q-two" });
    store.putAnswer(a2);
    // Try to point q1 at q2's answer.
    expect(() =>
      store.setQuestionStatus(q1.id, "answered", "ans:for-q2"),
    ).toThrow(/best_answer_id|question_id/i);
  });

  test("setQuestionStatus rejects answered when best_answer_id points to answer with status != accepted", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    // Create a "proposed" (not yet accepted) answer for q.
    const a = makeAnswer({ id: "ans:proposed", status: "proposed" });
    store.putAnswer(a);
    expect(() =>
      store.setQuestionStatus(q.id, "answered", "ans:proposed"),
    ).toThrow(/best_answer_id|accepted|proposed/i);
  });

  test("setQuestionStatus accepts answered when best_answer_id points to a valid accepted answer", () => {
    const q = makeQuestion();
    store.putQuestion(q);
    const a = makeAnswer({ id: "ans:happy", status: "accepted" });
    store.putAnswer(a);
    // Should NOT throw.
    expect(() =>
      store.setQuestionStatus(q.id, "answered", "ans:happy"),
    ).not.toThrow();
    const fetched = store.getQuestion(q.id)!;
    expect(fetched.status).toBe("answered");
    expect(fetched.best_answer_id).toBe("ans:happy");
  });

  // Iter-11: setAnswerExplanation + setAnswerQualityTier — used by the
  // importer to retroactively upgrade auto-imported peer-review answers
  // to authored status.
  test("setAnswerExplanation updates the explanation field", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:upgrade-me", explanation: "(auto-imported placeholder)" }));
    store.setAnswerExplanation("ans:upgrade-me", "Real authored explanation.");
    const a = store.getAnswer("ans:upgrade-me")!;
    expect(a.explanation).toBe("Real authored explanation.");
  });

  test("setAnswerExplanation rejects empty/null/whitespace (mirrors putAnswer guard)", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:strict" }));
    expect(() => store.setAnswerExplanation("ans:strict", "")).toThrow(/explanation/i);
    expect(() => store.setAnswerExplanation("ans:strict", "   \n  ")).toThrow(/explanation/i);
    expect(() => store.setAnswerExplanation("ans:strict", null as any)).toThrow(/explanation/i);
  });

  test("setAnswerQualityTier updates the quality_tier field", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:tier", quality_tier: 5 }));
    store.setAnswerQualityTier("ans:tier", 3);
    const a = store.getAnswer("ans:tier")!;
    expect(a.quality_tier).toBe(3);
  });
});

describe("LatticeStore — quality_tier semantics (dual-audience fusion)", () => {
  test("quality_tier 1 (gold) sorts above tier 5 (raw) under quality_tier_min filter", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:gold", quality_tier: 1, predictive_lift: 0.5 }));
    store.putAnswer(makeAnswer({ id: "ans:raw",  quality_tier: 5, predictive_lift: 0.5 }));

    // Filter for tier-1-only:
    const top = store.queryAnswers({ quality_tier_min: 1 });
    expect(top.map((a) => a.id)).toEqual(["ans:gold"]);

    // Filter for tier-3-or-better — only gold (tier 1) qualifies; raw (tier 5) is below.
    const above3 = store.queryAnswers({ quality_tier_min: 3 });
    expect(above3.map((a) => a.id)).toEqual(["ans:gold"]);

    // Filter for tier-5-or-better — both qualify.
    const above5 = store.queryAnswers({ quality_tier_min: 5 });
    expect(above5.map((a) => a.id).sort()).toEqual(["ans:gold", "ans:raw"]);
  });

  test("validator_id is preserved (gold-standard provenance)", () => {
    store.putQuestion(makeQuestion());
    store.putAnswer(makeAnswer({ id: "ans:gold", quality_tier: 1, validator_id: "human:alice" }));
    const fetched = store.getAnswer("ans:gold");
    expect(fetched?.validator_id).toBe("human:alice");
  });
});

// Iter-3 deferred → NL7 executed: SQL-level enforcement of the dual-output
// invariant (Answer.explanation NOT NULL). Pre-NL7 the runtime guards in
// recordAnswer + putAnswer enforced this at the application layer; the
// schema column itself was nullable. NL7 tightens at the SQL level too —
// defense in depth. Migration handles existing databases.
describe("schema migration: explanation NOT NULL (iter-3 / NL7)", () => {
  test("fresh schema has explanation column declared NOT NULL", () => {
    const fresh = new LatticeStore(":memory:");
    try {
      const colInfo = (fresh as any).db
        .query(`PRAGMA table_info(answers)`)
        .all() as Array<{ name: string; notnull: number }>;
      const explanation = colInfo.find((c) => c.name === "explanation");
      expect(explanation).toBeDefined();
      expect(explanation!.notnull).toBe(1);
    } finally {
      fresh.close();
    }
  });

  test("migration preserves existing data when tightening to NOT NULL", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const { Database } = require("bun:sqlite");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-migration-"));
    const dbFile = path.join(tmp, "old.db");
    try {
      // Build the OLD-shape database directly (simulates a pre-NL7 lattice).
      const oldDb = new Database(dbFile);
      oldDb.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE questions (
          id TEXT PRIMARY KEY,
          framing TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('open','answered','closed','reopened')),
          best_answer_id TEXT,
          posed_at INTEGER NOT NULL,
          posed_by TEXT NOT NULL,
          posed_in_context TEXT,
          depth INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE answers (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL,
          body TEXT NOT NULL,
          explanation TEXT,                    -- OLD: nullable
          by_agent TEXT NOT NULL,
          predictive_lift REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('proposed','accepted','superseded','refuted')),
          quality_tier INTEGER NOT NULL DEFAULT 5 CHECK(quality_tier BETWEEN 1 AND 5),
          created_at INTEGER NOT NULL,
          validator_id TEXT,
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );
        CREATE TABLE citations (
          parent_answer_id TEXT NOT NULL,
          child_answer_id TEXT NOT NULL,
          PRIMARY KEY (parent_answer_id, child_answer_id),
          FOREIGN KEY (parent_answer_id) REFERENCES answers(id) ON DELETE CASCADE,
          FOREIGN KEY (child_answer_id) REFERENCES answers(id) ON DELETE CASCADE
        );
        CREATE TABLE question_parents (
          parent_question_id TEXT NOT NULL,
          child_question_id TEXT NOT NULL,
          PRIMARY KEY (parent_question_id, child_question_id),
          FOREIGN KEY (parent_question_id) REFERENCES questions(id) ON DELETE CASCADE,
          FOREIGN KEY (child_question_id) REFERENCES questions(id) ON DELETE CASCADE
        );
      `);

      // Seed old-format data (with non-null explanations — production
      // already complies; iter-3's runtime guard ensured no NULLs landed).
      oldDb.run(
        `INSERT INTO questions (id, framing, status, posed_at, posed_by) VALUES (?, ?, ?, ?, ?)`,
        ["v1:q1", "Test?", "open", 100, "boss"],
      );
      oldDb.run(
        `INSERT INTO answers (id, question_id, body, explanation, by_agent, status, quality_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["ans:r1", "v1:q1", "answer body", "real explanation", "orion", "accepted", 2, 200],
      );
      oldDb.close();

      // Re-open via LatticeStore — should detect the old schema and migrate.
      const migrated = new LatticeStore(dbFile);
      try {
        // After migration, column should be NOT NULL.
        const colInfo = (migrated as any).db
          .query(`PRAGMA table_info(answers)`)
          .all() as Array<{ name: string; notnull: number }>;
        const explanation = colInfo.find((c) => c.name === "explanation");
        expect(explanation!.notnull).toBe(1);

        // Data preserved.
        const a = migrated.getAnswer("ans:r1");
        expect(a).not.toBeNull();
        expect(a!.body).toBe("answer body");
        expect(a!.explanation).toBe("real explanation");
        expect(a!.by_agent).toBe("orion");

        // Schema version bumped to 2.
        const ver = (migrated as any).db
          .query(`SELECT value FROM schema_meta WHERE key = ?`)
          .get("schema_version") as { value: string } | null;
        expect(ver?.value).toBe("2");
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("schema-level NOT NULL rejects bypass-INSERT with NULL explanation", () => {
    // Defense-in-depth: even if a future caller bypasses putAnswer's runtime
    // guard and goes direct via raw SQL, the schema itself rejects NULL.
    const fresh = new LatticeStore(":memory:");
    try {
      fresh.putQuestion({
        id: "v1:q-bypass", framing: "x", status: "open", best_answer_id: null,
        posed_at: 1, posed_by: "x", posed_in_context: null, depth: 0,
      });
      // Direct INSERT with NULL — should throw.
      expect(() => {
        (fresh as any).db.run(
          `INSERT INTO answers (id, question_id, body, explanation, by_agent, status, quality_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["ans:bypass", "v1:q-bypass", "body", null, "orion", "accepted", 5, 1],
        );
      }).toThrow(/NOT NULL/i);
    } finally {
      fresh.close();
    }
  });
});
