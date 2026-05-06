// scripts/fts.ts — bun:sqlite-backed FTS5 index over per-edge archives.
//
// Round 12 slice 2 (lossless-claw backport): KNOWINGLY DEVIATES from
// ARCHITECTURE.md cross-cutting invariant #1 ("filesystem-only, no
// SQLite"). The deviation is bounded: filesystem files (index.jsonl,
// META.yaml, BODY.md, SUMMARY.md) remain authoritative; this sqlite db
// is a derived FTS index, rebuildable from index.jsonl + per-archive
// SUMMARY.md, and never the source of truth. Loss of fts.db reverts
// search.ts grep to its existing regex/JSONL fallback (search remains
// functional, just unranked); rebuild via `archive.ts doctor --rebuild-fts`.
//
// Schema (sentinel-ratified Phase 1):
//   CREATE VIRTUAL TABLE archives USING fts5(
//     archive_id UNINDEXED, edge_id UNINDEXED, kind UNINDEXED, depth UNINDEXED,
//     earliest_at UNINDEXED, latest_at UNINDEXED,
//     tldr, summary_body, keywords, expand_topics,
//     tokenize='porter unicode61'
//   );
//
// Indexed columns are 4 (tldr / summary_body / keywords / expand_topics);
// orion's bm25 weight tuple is (2.0, 1.0, 1.5, 2.5) matching that order.
// BODY.md is intentionally NOT indexed — SUMMARY.md is the search surface
// per cross-slice contract; BODY.md is the recovery layer reached via
// search.ts expand. Tokenizer `porter unicode61` is the standard FTS5
// stem+casefold combo. v-next escalation if cross-archive code-identifier
// search becomes a use case: `trigram` tokenizer (sentinel).
//
// Concurrent-write safety: SQLite serializes writers via BEGIN IMMEDIATE
// + file lock. Two `bun` processes (e.g. archive.ts auto + condense.ts
// commit on the same edge) hitting back-to-back can stall on
// SQLITE_BUSY. withWriter retries up to 5x with exponential 200ms × 2^n
// backoff PLUS ±25% jitter to break lockstep retries (sentinel's
// refinement). Per-edge fts.db scoping limits contention to the
// rare two-on-same-edge case; cross-edge writes never contend.
//
// Corruption detection: on SQLITE_CORRUPT during write, write a sentinel
// file <edge.dir>/.fts-corrupt with the error body so doctor/gc can surface
// degraded search. Sentinel file cleared on successful rebuild.

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { IndexEntry } from "./lib.ts";
import { readIndex } from "./lib.ts";

export const FTS_DB_NAME = "fts.db";
export const FTS_CORRUPT_SENTINEL = ".fts-corrupt";

export type SummaryFields = {
  tldr: string;
  summary_body: string;
  keywords: string;     // pre-joined (e.g. " " or ", "); we treat as one bag of words
  expand_topics: string; // text after "Expand for details about:" line
};

export function ftsDbPath(edgeDir: string): string {
  return path.join(edgeDir, FTS_DB_NAME);
}

export function ftsCorruptSentinelPath(edgeDir: string): string {
  return path.join(edgeDir, FTS_CORRUPT_SENTINEL);
}

const SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS archives USING fts5(
    archive_id UNINDEXED,
    edge_id UNINDEXED,
    kind UNINDEXED,
    depth UNINDEXED,
    earliest_at UNINDEXED,
    latest_at UNINDEXED,
    tldr,
    summary_body,
    keywords,
    expand_topics,
    tokenize='porter unicode61'
  );
`;

function openDb(edgeDir: string): Database {
  fs.mkdirSync(edgeDir, { recursive: true });
  const db = new Database(ftsDbPath(edgeDir));
  // WAL mode improves reader/writer concurrency on shared filesystems and
  // makes SQLITE_BUSY less frequent overall. Cheap to enable.
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch {}
  db.exec(SCHEMA);
  return db;
}

// Mark this edge's FTS as corrupt. Caller writes a short error message.
// Cleared by rebuildFromIndex on successful completion.
function markCorrupt(edgeDir: string, err: Error): void {
  try {
    fs.writeFileSync(
      ftsCorruptSentinelPath(edgeDir),
      `${new Date().toISOString()}\n${err.name}: ${err.message}\n`,
    );
  } catch {}
}

function clearCorruptSentinel(edgeDir: string): void {
  try { fs.unlinkSync(ftsCorruptSentinelPath(edgeDir)); } catch {}
}

// withWriter: serialize each write attempt under a BEGIN IMMEDIATE
// transaction, retrying on SQLITE_BUSY. ±25% jitter breaks lockstep
// retries between two contending processes (sentinel's refinement).
async function withWriter<T>(db: Database, fn: () => T): Promise<T> {
  const baseDelay = 200;
  const maxRetries = 5;
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const busy = /SQLITE_BUSY|database is locked/i.test(msg);
      if (!busy || attempt === maxRetries) throw e;
      const jitter = 1 + (Math.random() - 0.5) * 0.5; // ±25%
      const delay = baseDelay * Math.pow(2, attempt) * jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// upsertEntry: insert or replace one archive row. Called by archive.ts
// auto/commit and condense.ts commit AFTER appendIndexEntry. Idempotent:
// re-upserting the same archive_id replaces the row in place.
export async function upsertEntry(
  edgeDir: string,
  entry: IndexEntry,
  summary: SummaryFields,
): Promise<void> {
  let db: Database;
  try {
    db = openDb(edgeDir);
  } catch (e: any) {
    markCorrupt(edgeDir, e);
    throw e;
  }
  try {
    await withWriter(db, () => {
      // Delete-then-insert pattern: FTS5 doesn't support upsert via
      // ON CONFLICT (it's a virtual table). Two statements in one
      // transaction is atomic.
      db.run(`DELETE FROM archives WHERE archive_id = ?`, [entry.id]);
      db.run(
        `INSERT INTO archives (
          archive_id, edge_id, kind, depth, earliest_at, latest_at,
          tldr, summary_body, keywords, expand_topics
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id, entry.edge_id, entry.kind, entry.depth,
          entry.earliest_at, entry.latest_at,
          summary.tldr,
          summary.summary_body,
          summary.keywords,
          summary.expand_topics,
        ],
      );
    });
  } catch (e: any) {
    if (/SQLITE_CORRUPT/i.test(String(e?.message ?? e))) markCorrupt(edgeDir, e);
    throw e;
  } finally {
    db.close();
  }
}

// query: bm25-ranked search against the 4 indexed columns. Weights chosen
// per orion's Phase-2 cross-slice contract:
//   tldr=2.0, summary_body=1.0, keywords=1.5, expand_topics=2.5
// expand_topics ranks highest because it explicitly lists what's NOT in
// the summary — a hit there is the strongest signal that calling
// `search.ts expand` would surface relevant content. tldr ranks 2.0
// because a hit there means the summary's headline is about the query.
// summary_body=1.0 is the baseline.
//
// CRITICAL — bm25() expects ONE weight per declared column, INCLUDING
// UNINDEXED columns. Our schema has 10 columns total: 6 UNINDEXED
// (archive_id, edge_id, kind, depth, earliest_at, latest_at — indices
// 0..5) followed by 4 INDEXED (tldr, summary_body, keywords,
// expand_topics — indices 6..9). Passing only 4 weights aligns them to
// the FIRST 4 columns (all UNINDEXED, no scoring contribution) and
// silently produces unweighted ranking. Round-12 keystone caught this
// empirically by inverting weights and observing identical ranking.
// Fix: 6 placeholder 1.0s for the UNINDEXED prefix, then the 4 real
// weights in declaration order.
export type FtsHit = {
  archive_id: string;
  edge_id: string;
  kind: string;
  depth: number;
  earliest_at: string;
  latest_at: string;
  tldr: string;
  rank: number; // negative; lower (more negative) = better
};

export function query(edgeDir: string, q: string, limit = 50): FtsHit[] {
  const dbPath = ftsDbPath(edgeDir);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    // bm25 expects ONE weight per declared column, including UNINDEXED.
    // 10 columns total: cols 0-5 are UNINDEXED (placeholder 1.0), cols
    // 6-9 are INDEXED (tldr=2.0, summary_body=1.0, keywords=1.5,
    // expand_topics=2.5). SQLite returns a NEGATIVE score (more negative
    // = better match); query() flips the sign so callers see "higher
    // = better".
    const weights = `1, 1, 1, 1, 1, 1, 2.0, 1.0, 1.5, 2.5`;
    const sql = `
      SELECT archive_id, edge_id, kind, depth, earliest_at, latest_at, tldr,
             bm25(archives, ${weights}) AS rank
      FROM archives
      WHERE archives MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.query(sql).all(q, limit) as any[];
    return rows.map((r) => ({
      archive_id: r.archive_id,
      edge_id: r.edge_id,
      kind: r.kind,
      depth: Number(r.depth),
      earliest_at: r.earliest_at,
      latest_at: r.latest_at,
      tldr: r.tldr,
      rank: Number(r.rank),
    }));
  } catch (e: any) {
    if (/SQLITE_CORRUPT/i.test(String(e?.message ?? e))) markCorrupt(edgeDir, e);
    return [];
  } finally {
    db.close();
  }
}

// hasEntry: existence check used by doctor's fts_in_sync invariant.
export function hasEntry(edgeDir: string, archiveId: string): boolean {
  const dbPath = ftsDbPath(edgeDir);
  if (!fs.existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query(`SELECT 1 FROM archives WHERE archive_id = ? LIMIT 1`).get(archiveId);
    return row != null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

// integrityCheck: runs SQLite's PRAGMA integrity_check. Returns true iff
// the db is healthy. Called from doctor (sentinel's design — on-demand,
// not on every write). Marks corrupt sentinel on failure.
export function integrityCheck(edgeDir: string): { ok: boolean; details?: string } {
  const dbPath = ftsDbPath(edgeDir);
  if (!fs.existsSync(dbPath)) return { ok: true }; // no db = nothing to check
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`PRAGMA integrity_check`).all() as any[];
    const first = rows[0]?.integrity_check ?? rows[0]?.["integrity_check"];
    if (rows.length === 1 && (first === "ok" || rows[0]?.[Object.keys(rows[0])[0]] === "ok")) {
      return { ok: true };
    }
    const details = rows.map((r) => Object.values(r).join(": ")).join("\n");
    markCorrupt(edgeDir, new Error(`integrity_check: ${details}`));
    return { ok: false, details };
  } catch (e: any) {
    markCorrupt(edgeDir, e);
    return { ok: false, details: String(e?.message ?? e) };
  } finally {
    db.close();
  }
}

// rebuildFromIndex: drop fts.db and rebuild from index.jsonl + per-archive
// SUMMARY.md re-reads. Called by `archive.ts doctor --rebuild-fts`. This
// is the recovery primitive for SQLITE_CORRUPT or any drift between
// fts.db and index.jsonl (e.g., a write that crashed mid-transaction).
//
// Caller-provided extractor parses SUMMARY.md content into the four
// indexed fields. Defined here as a callback so the parser logic stays
// in one place (lib.ts: extractTldr / extractKeywords / extractExpandTopics)
// without forcing fts.ts to import the whole summary-parsing surface.
export async function rebuildFromIndex(
  edgeDir: string,
  extract: (entry: IndexEntry) => SummaryFields | null,
): Promise<{ rebuilt: number; skipped: number }> {
  const dbPath = ftsDbPath(edgeDir);
  // Drop and recreate from scratch.
  try { fs.unlinkSync(dbPath); } catch {}
  // Also clean up any WAL/SHM companion files.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  const entries = readIndex(edgeDir);
  if (entries.length === 0) {
    clearCorruptSentinel(edgeDir);
    return { rebuilt: 0, skipped: 0 };
  }
  const db = openDb(edgeDir);
  let rebuilt = 0;
  let skipped = 0;
  try {
    await withWriter(db, () => {
      for (const entry of entries) {
        const summary = extract(entry);
        if (!summary) { skipped++; continue; }
        db.run(
          `INSERT INTO archives (
            archive_id, edge_id, kind, depth, earliest_at, latest_at,
            tldr, summary_body, keywords, expand_topics
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id, entry.edge_id, entry.kind, entry.depth,
            entry.earliest_at, entry.latest_at,
            summary.tldr, summary.summary_body,
            summary.keywords, summary.expand_topics,
          ],
        );
        rebuilt++;
      }
    });
    clearCorruptSentinel(edgeDir);
  } finally {
    db.close();
  }
  return { rebuilt, skipped };
}
