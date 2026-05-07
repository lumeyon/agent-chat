#!/usr/bin/env bun
// stats.ts — `agent-chat lattice-stats` — inspect the global lattice.
//
// Surfaces what's in the lattice: counts, agent participation,
// quality-tier distribution, predictive_lift histogram, top-cited
// answers. Used for debugging, demos, dataset characterization,
// and tracking how the lattice grows over time.
//
// Usage:
//   bun scripts/lattice/stats.ts [--db <path>] [--json]
//   agent-chat lattice-stats [--json]
//
// JSON mode emits a single object so downstream tooling can
// consume the stats without parsing the markdown table.

import * as fs from "node:fs";
import * as path from "node:path";
import { LatticeStore } from "./sqlite-store.ts";

interface LatticeStats {
  db_path: string;
  db_size_bytes: number;
  questions: {
    total: number;
    by_status: Record<string, number>;
    by_posed_by: Record<string, number>;
    posed_at_range: { earliest: number; latest: number } | null;
    depth_distribution: Record<number, number>;
  };
  answers: {
    total: number;
    by_status: Record<string, number>;
    by_agent: Record<string, number>;
    by_quality_tier: Record<number, number>;
    auto_imported_count: number;
    authored_count: number;
    predictive_lift: { min: number; max: number; mean: number; median: number };
  };
  citations: { total: number };
  question_parents: { total: number };
}

function defaultDbPath(): string {
  const conv = process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
    "/data/lumeyon/agent-chat/conversations";
  return path.join(conv, "lattice.db");
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function getStats(dbPath: string): LatticeStats {
  const store = new LatticeStore(dbPath);
  const db = (store as any).db;  // direct access for aggregate queries

  const dbSize = fs.statSync(dbPath).size;

  // Questions
  const qTotal = (db.query(`SELECT COUNT(*) as c FROM questions`).get() as any).c;
  const qByStatus = Object.fromEntries(
    (db.query(`SELECT status, COUNT(*) as c FROM questions GROUP BY status`).all() as any[])
      .map((r) => [r.status, r.c]),
  );
  const qByPosedBy = Object.fromEntries(
    (db.query(`SELECT posed_by, COUNT(*) as c FROM questions GROUP BY posed_by ORDER BY c DESC`).all() as any[])
      .map((r) => [r.posed_by, r.c]),
  );
  const tsRow = db.query(`SELECT MIN(posed_at) as mn, MAX(posed_at) as mx FROM questions`).get() as any;
  const posedAtRange = tsRow.mn !== null
    ? { earliest: tsRow.mn, latest: tsRow.mx }
    : null;
  const qDepth = Object.fromEntries(
    (db.query(`SELECT depth, COUNT(*) as c FROM questions GROUP BY depth ORDER BY depth`).all() as any[])
      .map((r) => [r.depth, r.c]),
  );

  // Answers
  const aTotal = (db.query(`SELECT COUNT(*) as c FROM answers`).get() as any).c;
  const aByStatus = Object.fromEntries(
    (db.query(`SELECT status, COUNT(*) as c FROM answers GROUP BY status`).all() as any[])
      .map((r) => [r.status, r.c]),
  );
  const aByAgent = Object.fromEntries(
    (db.query(`SELECT by_agent, COUNT(*) as c FROM answers GROUP BY by_agent ORDER BY c DESC`).all() as any[])
      .map((r) => [r.by_agent, r.c]),
  );
  const aByTier = Object.fromEntries(
    (db.query(`SELECT quality_tier, COUNT(*) as c FROM answers GROUP BY quality_tier ORDER BY quality_tier`).all() as any[])
      .map((r) => [r.quality_tier, r.c]),
  );
  const autoImported = (db.query(
    `SELECT COUNT(*) as c FROM answers WHERE explanation LIKE '%auto-imported%'`,
  ).get() as any).c;
  const authored = aTotal - autoImported;

  // Predictive lift histogram
  const lifts = (db.query(`SELECT predictive_lift FROM answers`).all() as any[])
    .map((r) => r.predictive_lift as number);
  const liftMin = lifts.length > 0 ? Math.min(...lifts) : 0;
  const liftMax = lifts.length > 0 ? Math.max(...lifts) : 0;
  const liftMean = lifts.length > 0 ? lifts.reduce((a, b) => a + b, 0) / lifts.length : 0;
  const liftMedian = median(lifts);

  // Citations + question parents
  const citationsTotal = (db.query(`SELECT COUNT(*) as c FROM citations`).get() as any).c;
  const qpTotal = (db.query(`SELECT COUNT(*) as c FROM question_parents`).get() as any).c;

  store.close();

  return {
    db_path: dbPath,
    db_size_bytes: dbSize,
    questions: {
      total: qTotal,
      by_status: qByStatus,
      by_posed_by: qByPosedBy,
      posed_at_range: posedAtRange,
      depth_distribution: qDepth,
    },
    answers: {
      total: aTotal,
      by_status: aByStatus,
      by_agent: aByAgent,
      by_quality_tier: aByTier,
      auto_imported_count: autoImported,
      authored_count: authored,
      predictive_lift: { min: liftMin, max: liftMax, mean: liftMean, median: liftMedian },
    },
    citations: { total: citationsTotal },
    question_parents: { total: qpTotal },
  };
}

function formatHumanReadable(s: LatticeStats): string {
  const lines: string[] = [];
  lines.push(`# Lattice stats — ${s.db_path}`);
  lines.push("");
  lines.push(`**DB size:** ${(s.db_size_bytes / 1024).toFixed(1)} KB`);
  lines.push("");

  lines.push(`## Questions: ${s.questions.total}`);
  lines.push("");
  if (Object.keys(s.questions.by_status).length > 0) {
    lines.push(`**By status:** ${Object.entries(s.questions.by_status).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (Object.keys(s.questions.by_posed_by).length > 0) {
    lines.push(`**By posed_by:** ${Object.entries(s.questions.by_posed_by).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (s.questions.posed_at_range) {
    const { earliest, latest } = s.questions.posed_at_range;
    lines.push(`**Date range:** ${new Date(earliest * 1000).toISOString()} → ${new Date(latest * 1000).toISOString()}`);
  }
  if (Object.keys(s.questions.depth_distribution).length > 0) {
    lines.push(`**Depth distribution:** ${Object.entries(s.questions.depth_distribution).map(([k, v]) => `d${k}=${v}`).join(", ")}`);
  }
  lines.push("");

  lines.push(`## Answers: ${s.answers.total}`);
  lines.push("");
  if (Object.keys(s.answers.by_status).length > 0) {
    lines.push(`**By status:** ${Object.entries(s.answers.by_status).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (Object.keys(s.answers.by_agent).length > 0) {
    lines.push(`**By by_agent:** ${Object.entries(s.answers.by_agent).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (Object.keys(s.answers.by_quality_tier).length > 0) {
    lines.push(`**By quality_tier:** ${Object.entries(s.answers.by_quality_tier).map(([k, v]) => `tier${k}=${v}`).join(", ")}`);
  }
  lines.push(`**Authored vs auto-imported:** authored=${s.answers.authored_count}, auto-imported=${s.answers.auto_imported_count}`);
  const pct = s.answers.total > 0 ? (s.answers.authored_count / s.answers.total * 100).toFixed(1) : "0.0";
  lines.push(`**Authored %:** ${pct}%`);
  const l = s.answers.predictive_lift;
  lines.push(`**predictive_lift:** min=${l.min.toFixed(3)} mean=${l.mean.toFixed(3)} median=${l.median.toFixed(3)} max=${l.max.toFixed(3)}`);
  lines.push("");

  lines.push(`## Graph structure`);
  lines.push("");
  lines.push(`**Citations:** ${s.citations.total}`);
  lines.push(`**Question parents:** ${s.question_parents.total}`);
  lines.push("");

  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let dbPath: string | null = null;
  let jsonMode = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db") dbPath = args[++i];
    else if (a === "--json") jsonMode = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: stats.ts [--db <path>] [--json]");
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  const path_ = dbPath ?? defaultDbPath();
  if (!fs.existsSync(path_)) {
    console.error(`error: lattice DB not found at ${path_}`);
    console.error(`run \`bun scripts/lattice/import-from-kg.ts --all\` to populate it`);
    process.exit(66);
  }
  const stats = getStats(path_);
  if (jsonMode) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(formatHumanReadable(stats));
  }
}

export { getStats, formatHumanReadable, type LatticeStats };
