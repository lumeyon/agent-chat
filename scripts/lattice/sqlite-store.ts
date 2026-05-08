// Phase 6 — Layer 2 multi-dim sqlite indices for the Inquiry Lattice.
//
// Implements the multi-axis indexed storage described in
// docs/inquiry-lattice.md "The multi-dimensional structure":
//
//   SemanticTree    — handled separately by HNSW (kg.ts), not here
//   TemporalIndex   — sqlite B-tree on questions(posed_at)
//   AgentIndex      — sqlite hash index on questions(posed_by) and answers(by_agent)
//   StatusIndex     — sqlite index on questions(status), answers(status)
//   DepthIndex      — sqlite index on questions(depth)
//   CitationDAG     — citations table with indices on both parent and child
//
// Per docs/inquiry-lattice.md "Dual-audience fusion": the storage shape
// IS the export shape. The same row a buyer downloads as JSONL is the
// row an agent retrieves at query time. No translation layer.
//
// Uses bun:sqlite — bundled with bun, zero install cost.

import { Database, type Statement } from "bun:sqlite";
import * as crypto from "node:crypto";
import type {
  Answer,
  AnswerFilter,
  AnswerStatus,
  Citation,
  Question,
  QuestionFilter,
  QuestionParent,
  QuestionStatus,
} from "./types.ts";

const SCHEMA_VERSION = 4;  // v4 (NL11): answers.quality_tier CHECK IN (1,2,3,4,5) — discrete-set, not BETWEEN

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  framing           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('open','answered','closed','reopened')),
  best_answer_id    TEXT REFERENCES answers(id) ON DELETE NO ACTION,
  posed_at          INTEGER NOT NULL,
  posed_by          TEXT NOT NULL,
  posed_in_context  TEXT,
  depth             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_q_status   ON questions(status);
CREATE INDEX IF NOT EXISTS idx_q_posed_at ON questions(posed_at);
CREATE INDEX IF NOT EXISTS idx_q_posed_by ON questions(posed_by);
CREATE INDEX IF NOT EXISTS idx_q_depth    ON questions(depth);

CREATE TABLE IF NOT EXISTS answers (
  id              TEXT PRIMARY KEY,
  question_id     TEXT NOT NULL,
  body            TEXT NOT NULL,
  explanation     TEXT NOT NULL,
  by_agent        TEXT NOT NULL,
  predictive_lift REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK(status IN ('proposed','accepted','superseded','refuted')),
  quality_tier    INTEGER NOT NULL DEFAULT 5 CHECK(quality_tier IN (1,2,3,4,5)),
  created_at      INTEGER NOT NULL,
  validator_id    TEXT,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_a_question        ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_a_by              ON answers(by_agent);
CREATE INDEX IF NOT EXISTS idx_a_status          ON answers(status);
CREATE INDEX IF NOT EXISTS idx_a_quality         ON answers(quality_tier);
CREATE INDEX IF NOT EXISTS idx_a_predictive_lift ON answers(predictive_lift DESC);
CREATE INDEX IF NOT EXISTS idx_a_created_at      ON answers(created_at);

-- Answer DAG: parent cites child (child composes INTO parent).
CREATE TABLE IF NOT EXISTS citations (
  parent_answer_id TEXT NOT NULL,
  child_answer_id  TEXT NOT NULL,
  PRIMARY KEY (parent_answer_id, child_answer_id),
  FOREIGN KEY (parent_answer_id) REFERENCES answers(id) ON DELETE CASCADE,
  FOREIGN KEY (child_answer_id)  REFERENCES answers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_c_parent ON citations(parent_answer_id);
CREATE INDEX IF NOT EXISTS idx_c_child  ON citations(child_answer_id);

-- Question DAG: a question can be sub-question of multiple parents.
CREATE TABLE IF NOT EXISTS question_parents (
  parent_question_id TEXT NOT NULL,
  child_question_id  TEXT NOT NULL,
  PRIMARY KEY (parent_question_id, child_question_id),
  FOREIGN KEY (parent_question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (child_question_id)  REFERENCES questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qp_parent ON question_parents(parent_question_id);
CREATE INDEX IF NOT EXISTS idx_qp_child  ON question_parents(child_question_id);
`;

function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  // Run any pending migrations on existing databases. New DBs get the
  // current schema directly from CREATE TABLE; the migrations are no-ops.
  // IMPORTANT: migrations run BEFORE PRAGMA foreign_keys = ON because
  // table-rebuild patterns (DROP + CREATE) can't run cleanly with FK
  // enforcement on. Migrations themselves disable+restore FK explicitly
  // for paranoid safety.
  migrateV1toV2(db);
  migrateV2toV3(db);
  migrateV3toV4(db);
  // Record schema version for future migrations.
  db.run(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`,
    ["schema_version", String(SCHEMA_VERSION)],
  );
  // Foreign key enforcement is per-connection in sqlite.
  db.run("PRAGMA foreign_keys = ON");
}

/** Migration v1 → v2 (NL7): tighten answers.explanation to TEXT NOT NULL.
 *  iter-3's runtime guard at putAnswer + recordAnswer ensures all writes
 *  carry non-empty explanations; v2 enforces the same invariant at the
 *  SQL level (defense in depth). Safe on production data because all
 *  existing rows already comply (audited NL7).
 *
 *  SQLite doesn't support `ALTER COLUMN ... SET NOT NULL`, so the
 *  migration uses the standard "create new table, copy, drop, rename"
 *  pattern. Wrapped in BEGIN IMMEDIATE for atomicity. Idempotent: if
 *  the column is already NOT NULL (fresh schema OR previously migrated),
 *  this is a no-op. */
function migrateV1toV2(db: Database): void {
  // Detect if explanation column is currently nullable.
  const colInfo = db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(answers)`)
    .all();
  const explanation = colInfo.find((c) => c.name === "explanation");
  if (!explanation || explanation.notnull === 1) {
    // Already migrated, or table doesn't exist (fresh DB — handled by
    // CREATE TABLE above). Nothing to do.
    return;
  }
  // Safety check: refuse to migrate if any row has NULL explanation.
  // iter-3's runtime guard should mean zero such rows in practice.
  const nullCountRow = db
    .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM answers WHERE explanation IS NULL`)
    .get();
  const nullCount = (nullCountRow as { c: number }).c;
  if (nullCount > 0) {
    throw new Error(
      `migrateV1toV2 aborted: ${nullCount} answer row(s) have NULL explanation. ` +
      `Backfill those first (recordAnswer enforces non-empty at write time, ` +
      `so this should be impossible — investigate the data source).`,
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE answers_new (
        id              TEXT PRIMARY KEY,
        question_id     TEXT NOT NULL,
        body            TEXT NOT NULL,
        explanation     TEXT NOT NULL,
        by_agent        TEXT NOT NULL,
        predictive_lift REAL NOT NULL DEFAULT 0,
        status          TEXT NOT NULL CHECK(status IN ('proposed','accepted','superseded','refuted')),
        quality_tier    INTEGER NOT NULL DEFAULT 5 CHECK(quality_tier BETWEEN 1 AND 5),
        created_at      INTEGER NOT NULL,
        validator_id    TEXT,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO answers_new (id, question_id, body, explanation, by_agent, predictive_lift, status, quality_tier, created_at, validator_id)
      SELECT id, question_id, body, explanation, by_agent, predictive_lift, status, quality_tier, created_at, validator_id FROM answers
    `);
    db.exec(`DROP TABLE answers`);
    db.exec(`ALTER TABLE answers_new RENAME TO answers`);
    // Recreate indexes that were attached to the old table.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_question ON answers(question_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_by ON answers(by_agent)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_status ON answers(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_quality ON answers(quality_tier)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_predictive_lift ON answers(predictive_lift DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_created_at ON answers(created_at)`);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/** Migration v2 → v3 (NL9): add FK constraint
 *  `questions.best_answer_id REFERENCES answers(id) ON DELETE NO ACTION`.
 *  Iter-7 K1 added a runtime guard at setQuestionStatus that prevents new
 *  writes from creating bad pointers; v3 enforces the same invariant at
 *  the SQL level (defense in depth — even raw-SQL bypassers get blocked).
 *
 *  ON DELETE NO ACTION (the SQLite default) means: deleting an answer
 *  that's a question's best_answer is REFUSED. Callers must NULL the
 *  best_answer_id first (or change the question status), which preserves
 *  the iter-5 joint-consistency invariant. CASCADE/SET NULL would either
 *  destroy data or violate the invariant.
 *
 *  Idempotency: detected via PRAGMA foreign_key_list. No-op if already
 *  migrated.
 *
 *  Safety: pre-flight orphan audit. If any questions have a non-null
 *  best_answer_id pointing at a non-existent answer, the migration
 *  refuses (don't propagate corrupt data to the new schema). */
function migrateV2toV3(db: Database): void {
  const fkList = db
    .query<{ from: string; table: string }, []>(`PRAGMA foreign_key_list(questions)`)
    .all();
  const hasBestAnswerFk = fkList.some(
    (fk) => fk.from === "best_answer_id" && fk.table === "answers",
  );
  if (hasBestAnswerFk) return;  // already migrated

  const orphansRow = db
    .query<{ c: number }, []>(`
      SELECT COUNT(*) as c FROM questions
      WHERE best_answer_id IS NOT NULL
        AND best_answer_id NOT IN (SELECT id FROM answers)
    `)
    .get();
  const orphans = (orphansRow as { c: number }).c;
  if (orphans > 0) {
    throw new Error(
      `migrateV2toV3 aborted: ${orphans} question row(s) have best_answer_id ` +
      `pointing at non-existent answers. Iter-7's runtime guard prevents new ` +
      `writes from creating these — investigate the data source. NULL or fix ` +
      `the orphans before re-running.`,
    );
  }

  // Disable FK enforcement for the rebuild (DROP TABLE questions would
  // fail with question_parents.parent_question_id and child_question_id
  // FKs in flight; same protection as v1→v2 path which relied on the
  // default-OFF state).
  const fkOnRow = db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get();
  const fkWasOn = (fkOnRow as { foreign_keys: number }).foreign_keys === 1;
  if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE questions_new (
        id                TEXT PRIMARY KEY,
        framing           TEXT NOT NULL,
        status            TEXT NOT NULL CHECK(status IN ('open','answered','closed','reopened')),
        best_answer_id    TEXT REFERENCES answers(id) ON DELETE NO ACTION,
        posed_at          INTEGER NOT NULL,
        posed_by          TEXT NOT NULL,
        posed_in_context  TEXT,
        depth             INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      INSERT INTO questions_new (id, framing, status, best_answer_id, posed_at, posed_by, posed_in_context, depth)
      SELECT id, framing, status, best_answer_id, posed_at, posed_by, posed_in_context, depth FROM questions
    `);
    db.exec(`DROP TABLE questions`);
    db.exec(`ALTER TABLE questions_new RENAME TO questions`);
    // Recreate indexes that were attached to the old questions table.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_q_status   ON questions(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_q_posed_at ON questions(posed_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_q_posed_by ON questions(posed_by)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_q_depth    ON questions(depth)`);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
}

/** Migration v3 → v4 (NL11): tighten answers.quality_tier CHECK from
 *  `BETWEEN 1 AND 5` to `IN (1,2,3,4,5)`. The BETWEEN form admits
 *  fractional values (e.g. 2.5) due to SQLite's dynamic typing — the
 *  IN form requires exact integer membership. Closes keystone iter-6 K2.
 *
 *  Idempotency: detect via sqlite_master.sql for the answers table —
 *  if the CHECK clause text already contains "IN (1,2,3,4,5)", no-op.
 *  This is more robust than re-checking PRAGMA which doesn't expose
 *  the CHECK clause text.
 *
 *  Safety: pre-flight audit refuses if any row has quality_tier NOT IN
 *  (1,2,3,4,5). Should be zero in practice (the type is `1|2|3|4|5`). */
function migrateV3toV4(db: Database): void {
  const masterRow = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='answers'`)
    .get();
  const masterSql = (masterRow as { sql: string } | null)?.sql ?? "";
  if (masterSql.includes("IN (1,2,3,4,5)")) {
    return;  // already migrated
  }

  // Safety check: refuse if any row has out-of-set quality_tier.
  const badRow = db
    .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM answers WHERE quality_tier NOT IN (1,2,3,4,5)`)
    .get();
  const badCount = (badRow as { c: number }).c;
  if (badCount > 0) {
    throw new Error(
      `migrateV3toV4 aborted: ${badCount} answer row(s) have quality_tier not in {1,2,3,4,5}. ` +
      `These would be invalid under the new CHECK. Backfill or fix them first.`,
    );
  }

  // Disable FK enforcement during the rebuild (citations + questions
  // both reference answers; DROP TABLE answers would fail).
  const fkOnRow = db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get();
  const fkWasOn = (fkOnRow as { foreign_keys: number }).foreign_keys === 1;
  if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE answers_new (
        id              TEXT PRIMARY KEY,
        question_id     TEXT NOT NULL,
        body            TEXT NOT NULL,
        explanation     TEXT NOT NULL,
        by_agent        TEXT NOT NULL,
        predictive_lift REAL NOT NULL DEFAULT 0,
        status          TEXT NOT NULL CHECK(status IN ('proposed','accepted','superseded','refuted')),
        quality_tier    INTEGER NOT NULL DEFAULT 5 CHECK(quality_tier IN (1,2,3,4,5)),
        created_at      INTEGER NOT NULL,
        validator_id    TEXT,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO answers_new (id, question_id, body, explanation, by_agent, predictive_lift, status, quality_tier, created_at, validator_id)
      SELECT id, question_id, body, explanation, by_agent, predictive_lift, status, quality_tier, created_at, validator_id FROM answers
    `);
    db.exec(`DROP TABLE answers`);
    db.exec(`ALTER TABLE answers_new RENAME TO answers`);
    // Recreate indexes that were attached to the old answers table.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_question ON answers(question_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_by ON answers(by_agent)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_status ON answers(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_quality ON answers(quality_tier)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_predictive_lift ON answers(predictive_lift DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_a_created_at ON answers(created_at)`);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
}

/** Compute a deterministic answer id from its content fields. */
export function makeAnswerId(question_id: string, body: string, by_agent: string): string {
  const h = crypto.createHash("sha256");
  h.update(question_id);
  h.update("\n");
  h.update(body);
  h.update("\n");
  h.update(by_agent);
  return `ans:${h.digest("hex").slice(0, 16)}`;
}

// ─── Question status / best_answer_id joint invariant ─────────────────────

/** Lumeyon's iter-1 REAL #3 finding: types.ts:39 documents that
 *  best_answer_id is "Pointer into answers.id when status is answered or
 *  closed", but pre-fix putQuestion / setQuestionStatus accepted any
 *  combination silently. The invariant the docs claim:
 *    - status in {open, reopened} → best_answer_id MUST be null
 *    - status in {answered, closed} → best_answer_id MUST be non-null
 *  Enforced at write-time in both putQuestion and setQuestionStatus.
 *  pushContext's fallback (apprenticeship.ts) for null best_answer_id
 *  on an answered question stays — defense in depth on the read side. */
function enforceQuestionStatusInvariant(
  status: QuestionStatus,
  best_answer_id: string | null | undefined,
): void {
  const hasBestAnswer = typeof best_answer_id === "string" && best_answer_id.length > 0;
  if ((status === "open" || status === "reopened") && hasBestAnswer) {
    throw new Error(
      `question status invariant: status="${status}" requires best_answer_id=null ` +
      `(got "${best_answer_id}"). An open/reopened question cannot already point at an answer.`,
    );
  }
  if ((status === "answered" || status === "closed") && !hasBestAnswer) {
    throw new Error(
      `question status invariant: status="${status}" requires best_answer_id to be a non-empty string ` +
      `(got ${best_answer_id === null ? "null" : best_answer_id === undefined ? "undefined" : "empty string"}). ` +
      `An answered/closed question must point at the accepted answer (see types.ts:39).`,
    );
  }
}

/** Keystone's iter-6 K3 finding: addCitation / addQuestionParent's
 *  read-then-insert (cycle check followed by INSERT) was NOT wrapped in
 *  a transaction. Two LatticeStore connections to the same file could
 *  each pass opposite-edge cycle checks (each seeing a state where the
 *  other's edge doesn't exist yet) and then both INSERT, producing a
 *  cycle. Wrap each check+insert in BEGIN IMMEDIATE: SQLite's
 *  writer-mutex serializes all immediate transactions, so the second
 *  writer's BEGIN IMMEDIATE blocks until the first commits — by then
 *  the read inside the second transaction sees the new edge and
 *  correctly detects the cycle. Mirrors the withWriter pattern already
 *  proven in fts.ts:108 for the FTS5 index. SYNC version (lattice ops
 *  are synchronous; no retry/backoff — contention is so rare that a
 *  raw SQLITE_BUSY surface is acceptable). */
function withImmediateWriter<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/** Keystone's iter-6 K1 finding: best_answer_id was not FK-validated at
 *  setQuestionStatus — any non-empty string passed, including missing
 *  answers, answers for another question, or non-accepted answers.
 *  Called from setQuestionStatus AFTER enforceQuestionStatusInvariant
 *  has established that best_answer_id is a non-empty string when
 *  status is answered/closed. Verifies (a) answer exists, (b) its
 *  question_id matches, (c) its status === "accepted". putQuestion
 *  does NOT call this — at insert time the answer typically doesn't
 *  exist yet (production path is put-as-open then promote via
 *  setQuestionStatus). The promotion choke-point is where the
 *  invariant is checked. */
function enforceBestAnswerReference(
  db: Database,
  question_id: string,
  best_answer_id: string,
): void {
  const row = db
    .query<{ question_id: string; status: string }, [string]>(
      `SELECT question_id, status FROM answers WHERE id = ?`,
    )
    .get(best_answer_id);
  if (!row) {
    throw new Error(
      `setQuestionStatus FK guard: best_answer_id="${best_answer_id}" does not reference any existing answer.`,
    );
  }
  if (row.question_id !== question_id) {
    throw new Error(
      `setQuestionStatus FK guard: best_answer_id="${best_answer_id}" points to an answer whose question_id is "${row.question_id}", not "${question_id}".`,
    );
  }
  if (row.status !== "accepted") {
    throw new Error(
      `setQuestionStatus FK guard: best_answer_id="${best_answer_id}" points to an answer with status="${row.status}", not "accepted". Only accepted answers can be a question's best_answer.`,
    );
  }
}

// ─── Cycle prevention for question_parents ─────────────────────────────────

function questionAncestors(db: Database, questionId: string): Set<string> {
  // BFS over question_parents, returning all ancestor question ids.
  const stmt = db.prepare(
    "SELECT parent_question_id FROM question_parents WHERE child_question_id = ?",
  );
  const ancestors = new Set<string>();
  const stack = [questionId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const rows = stmt.all(cur) as { parent_question_id: string }[];
    for (const row of rows) {
      if (!ancestors.has(row.parent_question_id)) {
        ancestors.add(row.parent_question_id);
        stack.push(row.parent_question_id);
      }
    }
  }
  return ancestors;
}

function answerAncestors(db: Database, answerId: string): Set<string> {
  // BFS over citations: parents are answers that cite this one (this is
  // child of those parents). For cycle prevention we look at the OTHER
  // direction: ancestors-of-parent-when-adding-child means ancestors are
  // those reachable BACKWARD from the child via parent edges.
  // Actually: cycle would be parent → ... → child → parent. So when
  // adding (parent, child), check that parent is NOT a descendant of child.
  // A descendant of child = anything reachable from child via the
  // parent-of-cites-child relation.
  const stmt = db.prepare(
    "SELECT child_answer_id FROM citations WHERE parent_answer_id = ?",
  );
  const descendants = new Set<string>();
  const stack = [answerId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const rows = stmt.all(cur) as { child_answer_id: string }[];
    for (const row of rows) {
      if (!descendants.has(row.child_answer_id)) {
        descendants.add(row.child_answer_id);
        stack.push(row.child_answer_id);
      }
    }
  }
  return descendants;
}

// ─── LatticeStore ──────────────────────────────────────────────────────────

export class LatticeStore {
  private db: Database;
  private stmts: {
    insertQuestion: Statement;
    tryInsertQuestion: Statement;
    getQuestion: Statement;
    updateQuestionStatus: Statement;
    insertAnswer: Statement;
    getAnswer: Statement;
    insertCitation: Statement;
    insertQuestionParent: Statement;
  };

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    ensureSchema(this.db);

    this.stmts = {
      insertQuestion: this.db.prepare(`
        INSERT INTO questions (id, framing, status, best_answer_id, posed_at, posed_by, posed_in_context, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      // K-imp-4 fix (NL18 keystone): atomic INSERT-or-skip. SQLite
      // INSERT OR IGNORE is race-safe at the SQL level — concurrent
      // writers can't both succeed; exactly one wins, the other silently
      // no-ops. Used by importPairs (and any other ingest path) to drop
      // the classic check-then-act getQuestion+putQuestion race that
      // surfaced as "UNIQUE constraint failed: questions.id" under
      // parallel imports.
      tryInsertQuestion: this.db.prepare(`
        INSERT OR IGNORE INTO questions (id, framing, status, best_answer_id, posed_at, posed_by, posed_in_context, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getQuestion: this.db.prepare(`SELECT * FROM questions WHERE id = ?`),
      updateQuestionStatus: this.db.prepare(`
        UPDATE questions SET status = ?, best_answer_id = ? WHERE id = ?
      `),
      insertAnswer: this.db.prepare(`
        INSERT INTO answers (id, question_id, body, explanation, by_agent, predictive_lift, status, quality_tier, created_at, validator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getAnswer: this.db.prepare(`SELECT * FROM answers WHERE id = ?`),
      insertCitation: this.db.prepare(`
        INSERT INTO citations (parent_answer_id, child_answer_id) VALUES (?, ?)
      `),
      insertQuestionParent: this.db.prepare(`
        INSERT INTO question_parents (parent_question_id, child_question_id) VALUES (?, ?)
      `),
    };
  }

  close(): void {
    this.db.close();
  }

  // ─── Question operations ────────────────────────────────────────────────

  putQuestion(q: Question): void {
    enforceQuestionStatusInvariant(q.status, q.best_answer_id);
    this.stmts.insertQuestion.run(
      q.id,
      q.framing,
      q.status,
      q.best_answer_id ?? null,
      q.posed_at,
      q.posed_by,
      q.posed_in_context ?? null,
      q.depth,
    );
  }

  /** K-imp-4 fix (NL18 keystone): atomic, race-safe variant of putQuestion.
   *  Returns true if the row was inserted, false if a row with the same id
   *  already existed. Uses INSERT OR IGNORE — concurrent writers cannot
   *  collide; exactly one wins. Use this for ingest paths that must be
   *  idempotent under parallel callers (e.g. importPairs).
   *
   *  Note: when the row already exists this method does NOT update any
   *  fields. If the caller needs to know what's actually stored, follow
   *  up with getQuestion(id). The intent is "create-if-absent, otherwise
   *  no-op," not "upsert." */
  tryPutQuestion(q: Question): boolean {
    enforceQuestionStatusInvariant(q.status, q.best_answer_id);
    const result = this.stmts.tryInsertQuestion.run(
      q.id,
      q.framing,
      q.status,
      q.best_answer_id ?? null,
      q.posed_at,
      q.posed_by,
      q.posed_in_context ?? null,
      q.depth,
    );
    return result.changes > 0;
  }

  getQuestion(id: string): Question | null {
    const row = this.stmts.getQuestion.get(id) as Question | undefined;
    return row ?? null;
  }

  /** Update the lifecycle status (and optional best_answer_id pointer). */
  setQuestionStatus(id: string, status: QuestionStatus, best_answer_id: string | null = null): void {
    enforceQuestionStatusInvariant(status, best_answer_id);
    // K1: when promoting to answered/closed, validate the best_answer_id
    // FK is real, matches this question, and is accepted. Iter-5's
    // enforceQuestionStatusInvariant guarantees best_answer_id is a
    // non-empty string here when status is answered/closed.
    if ((status === "answered" || status === "closed") && best_answer_id) {
      enforceBestAnswerReference(this.db, id, best_answer_id);
    }
    this.stmts.updateQuestionStatus.run(status, best_answer_id, id);
  }

  /** Multi-axis query — composes filters via SQL AND. */
  queryQuestions(filter: QuestionFilter = {}): Question[] {
    const conds: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map(() => "?").join(",");
      conds.push(`status IN (${placeholders})`);
      for (const s of statuses) params.push(s);
    }
    if (filter.posed_by) {
      conds.push("posed_by = ?");
      params.push(filter.posed_by);
    }
    if (filter.posed_at_after !== undefined) {
      conds.push("posed_at >= ?");
      params.push(filter.posed_at_after);
    }
    if (filter.posed_at_before !== undefined) {
      conds.push("posed_at < ?");
      params.push(filter.posed_at_before);
    }
    if (filter.depth !== undefined) {
      conds.push("depth = ?");
      params.push(filter.depth);
    }
    if (filter.depth_min !== undefined) {
      conds.push("depth >= ?");
      params.push(filter.depth_min);
    }
    if (filter.depth_max !== undefined) {
      conds.push("depth <= ?");
      params.push(filter.depth_max);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.order_by === "posed_at_asc" ? "ASC" : "DESC";
    const limit = filter.limit ?? 100;
    const sql = `SELECT * FROM questions ${where} ORDER BY posed_at ${order} LIMIT ?`;
    params.push(limit);

    return this.db.query(sql).all(...params) as Question[];
  }

  // ─── Answer operations ──────────────────────────────────────────────────

  putAnswer(a: Answer): void {
    // Apprenticeship Substrate forcing function 1 (dual-output): every
    // Answer must carry a non-empty explanation. recordAnswer() enforces
    // this at the apprenticeship API layer (apprenticeship.ts:55-63);
    // we enforce it again here so direct putAnswer callers cannot
    // bypass the invariant. Lumeyon's iter-1 review flagged the original
    // typed-as-nullable surface as a real type-safety hole.
    if (typeof a.explanation !== "string" || a.explanation.trim().length === 0) {
      throw new Error(
        `putAnswer: dual-output invariant — explanation must be a non-empty ` +
        `string (got ${a.explanation === null ? "null" : a.explanation === undefined ? "undefined" : "empty/whitespace string"}).`,
      );
    }
    this.stmts.insertAnswer.run(
      a.id,
      a.question_id,
      a.body,
      a.explanation,
      a.by_agent,
      a.predictive_lift,
      a.status,
      a.quality_tier,
      a.created_at,
      a.validator_id ?? null,
    );
  }

  getAnswer(id: string): Answer | null {
    const row = this.stmts.getAnswer.get(id) as Answer | undefined;
    return row ?? null;
  }

  /** Update only the status of an existing answer. Used by selection
   *  pressure / re-ranking to promote winners and demote losers. */
  setAnswerStatus(id: string, status: AnswerStatus): void {
    this.db.run("UPDATE answers SET status = ? WHERE id = ?", [status, id]);
  }

  /** Update predictive_lift on an existing answer. Used by study-turn
   *  grading to bump or penalize an answer based on prediction error. */
  setAnswerPredictiveLift(id: string, predictive_lift: number): void {
    this.db.run("UPDATE answers SET predictive_lift = ? WHERE id = ?", [predictive_lift, id]);
  }

  /** Update the explanation of an existing answer. Used by the importer
   *  when an ephemeral peer review section is re-imported and we want
   *  to upgrade it from the auto-imported placeholder to a real
   *  provenance explanation. Honors the dual-output invariant
   *  (non-empty string), same as putAnswer. */
  setAnswerExplanation(id: string, explanation: string): void {
    if (typeof explanation !== "string" || explanation.trim().length === 0) {
      throw new Error(
        `setAnswerExplanation: dual-output invariant — explanation must be a non-empty string ` +
        `(got ${explanation === null ? "null" : explanation === undefined ? "undefined" : "empty/whitespace string"}).`,
      );
    }
    this.db.run("UPDATE answers SET explanation = ? WHERE id = ?", [explanation, id]);
  }

  /** Update the quality_tier of an existing answer. Used to promote an
   *  auto-imported answer to a peer-validated tier (e.g. tier 5 → 3
   *  for content from an ephemeral peer review). */
  setAnswerQualityTier(id: string, quality_tier: QualityTier): void {
    this.db.run("UPDATE answers SET quality_tier = ? WHERE id = ?", [quality_tier, id]);
  }

  queryAnswers(filter: AnswerFilter = {}): Answer[] {
    const conds: string[] = [];
    const params: (string | number)[] = [];

    if (filter.question_id) {
      conds.push("question_id = ?");
      params.push(filter.question_id);
    }
    if (filter.by_agent) {
      conds.push("by_agent = ?");
      params.push(filter.by_agent);
    }
    if (filter.by_agent_not) {
      conds.push("by_agent != ?");
      params.push(filter.by_agent_not);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map(() => "?").join(",");
      conds.push(`status IN (${placeholders})`);
      for (const s of statuses) params.push(s);
    }
    if (filter.quality_tier_min !== undefined && filter.quality_tier_min !== null) {
      conds.push("quality_tier <= ?");  // tier 1 = best, so MIN tier = MAX numeric
      params.push(filter.quality_tier_min);
    }
    if (filter.predictive_lift_min !== undefined && filter.predictive_lift_min !== null) {
      conds.push("predictive_lift >= ?");
      params.push(filter.predictive_lift_min);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    let order: string;
    switch (filter.order_by ?? "predictive_lift_desc") {
      case "predictive_lift_desc": order = "predictive_lift DESC"; break;
      case "created_at_desc":      order = "created_at DESC"; break;
      case "created_at_asc":       order = "created_at ASC"; break;
      default:                     order = "predictive_lift DESC";
    }
    const limit = filter.limit ?? 100;
    const sql = `SELECT * FROM answers ${where} ORDER BY ${order} LIMIT ?`;
    params.push(limit);

    return this.db.query(sql).all(...params) as Answer[];
  }

  // ─── Citation DAG ────────────────────────────────────────────────────────

  /**
   * Add a citation: parent_answer cites child_answer (child composes INTO parent).
   * Refuses if the edge would create a cycle.
   */
  addCitation(parent_answer_id: string, child_answer_id: string): void {
    if (parent_answer_id === child_answer_id) {
      throw new Error(`citation: self-citation refused (${parent_answer_id})`);
    }
    // K3: cycle check + insert atomic under BEGIN IMMEDIATE. Pre-fix two
    // concurrent connections could each see opposite-edge-not-present
    // and both insert, producing a cycle.
    withImmediateWriter(this.db, () => {
      // Cycle check: would adding (parent → child) create a cycle?
      // Yes iff parent is a DESCENDANT of child. Walk descendants of child
      // via citations(parent_answer_id = X) — if we reach parent, refuse.
      const descendantsOfChild = answerAncestors(this.db, child_answer_id);
      if (descendantsOfChild.has(parent_answer_id)) {
        throw new Error(
          `citation: would create cycle ${parent_answer_id} → ... → ${child_answer_id} → ${parent_answer_id}`,
        );
      }
      this.stmts.insertCitation.run(parent_answer_id, child_answer_id);
    });
  }

  /** Get answers cited BY this parent answer (i.e., its sub-answers). */
  getCitedAnswers(parent_answer_id: string): Citation[] {
    return this.db
      .query(`SELECT * FROM citations WHERE parent_answer_id = ?`)
      .all(parent_answer_id) as Citation[];
  }

  /** Get answers that cite this child (i.e., parents that compose this). */
  getCitingAnswers(child_answer_id: string): Citation[] {
    return this.db
      .query(`SELECT * FROM citations WHERE child_answer_id = ?`)
      .all(child_answer_id) as Citation[];
  }

  // ─── Question DAG ────────────────────────────────────────────────────────

  addQuestionParent(parent_id: string, child_id: string): void {
    if (parent_id === child_id) {
      throw new Error(`question_parent: self-parent refused (${parent_id})`);
    }
    // K3: same atomicity contract as addCitation — read+insert under
    // BEGIN IMMEDIATE so two connections cannot interleave a cycle.
    withImmediateWriter(this.db, () => {
      const ancestors = questionAncestors(this.db, parent_id);
      if (ancestors.has(child_id)) {
        throw new Error(
          `question_parent: would create cycle in question DAG`,
        );
      }
      this.stmts.insertQuestionParent.run(parent_id, child_id);
    });
  }

  getQuestionParents(child_id: string): QuestionParent[] {
    return this.db
      .query(`SELECT * FROM question_parents WHERE child_question_id = ?`)
      .all(child_id) as QuestionParent[];
  }

  getQuestionChildren(parent_id: string): QuestionParent[] {
    return this.db
      .query(`SELECT * FROM question_parents WHERE parent_question_id = ?`)
      .all(parent_id) as QuestionParent[];
  }

  // ─── Stats / introspection ───────────────────────────────────────────────

  stats(): { questions: number; answers: number; citations: number; question_parents: number } {
    return {
      questions: (this.db.query(`SELECT COUNT(*) as c FROM questions`).get() as any).c,
      answers: (this.db.query(`SELECT COUNT(*) as c FROM answers`).get() as any).c,
      citations: (this.db.query(`SELECT COUNT(*) as c FROM citations`).get() as any).c,
      question_parents: (this.db.query(`SELECT COUNT(*) as c FROM question_parents`).get() as any).c,
    };
  }
}
