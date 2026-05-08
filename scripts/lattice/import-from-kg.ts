#!/usr/bin/env bun
// import-from-kg.ts — bridge per-edge CONVO.md content into the global
// Inquiry Lattice's Question/Answer store.
//
// Walks a CONVO.md (and optionally its sealed archives), finds adjacent
// (user-turn, assistant-response) pairs, and upserts them as
// (Question, Answer) rows in the global lattice DB at <conv>/lattice.db.
//
// Idempotency: question_ids are canonical-form (Candidate A normalize +
// sha256), answer_ids are sha256(question_id, body, by_agent). INSERT
// statements use OR IGNORE so re-importing the same content is a no-op.
//
// What this is NOT (yet):
//   - Auto-wired into kg.ts. The lattice import is a separate command;
//     wiring it into the per-turn Stop hook is future work.
//   - Multi-edge dedup. Each edge's CONVO.md is imported independently;
//     same canonical_id from different edges naturally unifies because
//     the lattice keys on canonical_id.
//
// Usage:
//   bun scripts/lattice/import-from-kg.ts <edge_dir>
//     # Import a single edge's CONVO.md.
//   bun scripts/lattice/import-from-kg.ts --all [<conv_dir>]
//     # Walk every edge under <conv_dir>/<topology>/<edge>/ and import.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { LatticeStore, makeAnswerId } from "./sqlite-store.ts";
import { recordAnswer } from "./apprenticeship.ts";
import { normalizeString } from "../normalize/candidate-a.ts";
import type { Question, QualityTier } from "./types.ts";

// ─── Section parsing ───────────────────────────────────────────────────────

/** Header pattern: `## <agent> — <description> (UTC <iso8601>)` */
const SECTION_HEADER_RE = /^## (\S+)\s+—\s+(.+?)\s+\(UTC ([^)]+)\)\s*$/;

interface ParsedSection {
  agent: string;
  description: string;
  utc: string;        // ISO8601 string from the header
  body: string;       // section body excluding the `## ...` header line
}

/** Parse a CONVO.md text into ordered ParsedSection records.
 *  Sections that don't match the canonical header pattern are skipped
 *  (they're either header banners, archive breadcrumb HTML comments,
 *  embedded code-block headings, or other non-protocol content).
 */
export function parseSections(content: string): ParsedSection[] {
  // Split on lines that start a `## ` block (matches embedded `## ...` too,
  // but the regex below filters non-protocol headers).
  const parts = content.split(/(?=^## )/m).filter((p) => p.trim().startsWith("## "));
  const out: ParsedSection[] = [];
  for (const part of parts) {
    const newlineIdx = part.indexOf("\n");
    const headerLine = (newlineIdx < 0 ? part : part.slice(0, newlineIdx)).trim();
    const m = SECTION_HEADER_RE.exec(headerLine);
    if (!m) continue;  // not a protocol section header
    const [, agent, description, utc] = m;
    let body = newlineIdx < 0 ? "" : part.slice(newlineIdx + 1);
    // Strip trailing `→ <next>` arrow protocol markers and `---` separators
    // in any order. Repeat until stable so chained markers all strip.
    // K-imp-2 fix (NL5 keystone): the prior /m flag made `$` match
    // end-of-LINE, which stripped INTERNAL "→ name" / "---" lines from
    // body content (data corruption). Without /m, `$` only matches
    // end-of-string, so only the TRAILING markers strip — which is the
    // intent.
    let prev: string;
    do {
      prev = body;
      body = body.trimEnd();
      body = body.replace(/[\n\s]*---\s*$/, "");
      body = body.replace(/[\n\s]*→\s*\S+\s*$/, "");
    } while (body !== prev);
    body = body.trim();
    out.push({ agent, description, utc, body });
  }
  return out;
}

// ─── Q/A pairing ──────────────────────────────────────────────────────────

interface QAPair {
  /** The "asking" section — user turn for human→AI, the prior agent's section for AI→AI. */
  user: ParsedSection;
  /** The "answering" section — assistant response for human→AI, the responding agent's section for AI→AI. */
  assistant: ParsedSection;
  /** Pair shape for downstream tagging. */
  kind: "human_to_ai" | "ai_to_ai";
}

/** Description prefixes that indicate a section is NOT a substantive
 *  question or answer (handoffs, parks, proposals, etc.). These are
 *  protocol-level moves rather than dialogue content. */
const NON_QA_DESCRIPTION_PREFIXES: string[] = [
  "handoff",         // "## orion — handoff to lumeyon"
  "park",            // "## boss — parking"
  "parked",
  "parking",
  "propose subgraph",
  "subgraph spawn",
];

function isNonQaSection(s: ParsedSection): boolean {
  const desc = s.description.toLowerCase();
  return NON_QA_DESCRIPTION_PREFIXES.some((p) => desc.startsWith(p));
}

/** Find adjacent Q→A pairs in a section list.
 *
 *  Two patterns are recognized:
 *    1. human → AI: section i has description "user turn" and section
 *       i+1 has "assistant response". The historical pattern produced
 *       by record-turn.
 *    2. AI → AI: section i and section i+1 have DIFFERENT agents,
 *       neither is a non-QA section (handoff/park/etc.), and both
 *       have arbitrary topic descriptions. This captures inter-agent
 *       dialogue (e.g., orion → lumeyon → orion exchanges).
 *
 *  Pairs the FIRST applicable pattern; sections already consumed by
 *  the previous pair are skipped (so a 4-section AI-to-AI dialog
 *  produces 2 pairs, not 3).
 */
export function pairSections(sections: ParsedSection[]): QAPair[] {
  const pairs: QAPair[] = [];
  let i = 0;
  while (i + 1 < sections.length) {
    const a = sections[i];
    const b = sections[i + 1];
    let matched = false;

    // Pattern 1 — human → AI
    if (a.description.toLowerCase().startsWith("user turn")
        && b.description.toLowerCase().startsWith("assistant response")) {
      pairs.push({ user: a, assistant: b, kind: "human_to_ai" });
      i += 2;
      matched = true;
    }

    // Pattern 2 — AI → AI
    if (!matched
        && a.agent !== b.agent
        && !isNonQaSection(a)
        && !isNonQaSection(b)
        // Reject if either looks like a human→AI half (e.g., a "user turn"
        // section without a matching "assistant response" partner — those
        // shouldn't pair with arbitrary next sections).
        && !a.description.toLowerCase().startsWith("user turn")
        && !b.description.toLowerCase().startsWith("user turn")
        && !a.description.toLowerCase().startsWith("assistant response")
        && !b.description.toLowerCase().startsWith("assistant response")) {
      pairs.push({ user: a, assistant: b, kind: "ai_to_ai" });
      i += 2;
      matched = true;
    }

    if (!matched) i += 1;
  }
  return pairs;
}

/** K-imp-5 fix (NL13 keystone): discriminate PRIMARY KEY conflicts from
 *  other recordAnswer errors. Pre-fix, importPairs's catch block treated
 *  EVERY thrown error as "already imported" → aDup++. That silently
 *  miscounted non-PK errors (FK violations, CHECK constraints, dual-
 *  output enforcement) as duplicates, hiding real failures.
 *
 *  Returns true if the error is a PK / UNIQUE constraint conflict
 *  (genuine "already imported" case). False for all other error
 *  classes — the caller should propagate or log them, not silently
 *  swallow them as duplicates. */
export function isPrimaryKeyConflict(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "").toLowerCase();
  // SQLite emits "UNIQUE constraint failed: <table>.<column>" for
  // PK / UNIQUE collisions. Match conservatively: must mention
  // "unique constraint" specifically, not other constraint types.
  return /unique constraint failed/.test(msg);
}

/** K-imp-8 fix (NL10 keystone): strict ISO-8601 UTC parser. The protocol
 *  specifies `UTC YYYY-MM-DDTHH:MM:SSZ` (with optional fractional seconds).
 *  Date.parse is too permissive — it accepts offsets like `+0500`, missing
 *  `Z` suffix, and `space-separator` variants, all of which interpret time
 *  in non-UTC zones and silently shift the imported timestamp.
 *
 *  Returns NaN (consistent with Date.parse's failure shape) for any string
 *  that doesn't match the strict format. importPairs's existing
 *  `Number.isNaN(userMs)` check then skips the pair as malformed. */
const STRICT_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
function parseStrictUtc(s: string): number {
  if (!STRICT_UTC_RE.test(s)) return NaN;
  return Date.parse(s);
}

// ─── canonical_id producer (must match kg.ts) ──────────────────────────────

function canonicalIdOf(text: string): string {
  const normalized = normalizeString(text);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `v1:${hash}`;
}

// ─── Import driver ─────────────────────────────────────────────────────────

export interface ImportResult {
  edge_dir: string;
  sections_parsed: number;
  pairs_found: number;
  questions_inserted: number;
  questions_already_existed: number;
  answers_inserted: number;
  answers_already_existed: number;
  /** Number of sealed leaf archives walked (live CONVO.md doesn't count). */
  archives_walked: number;
}

/** Import all (Q, A) pairs from an edge's CONVO.md AND every sealed
 *  leaf archive's BODY.md into the lattice.
 *
 *  The live CONVO.md typically holds only the most recent few sections
 *  (the rest gets sealed into archives at the >200-line threshold). For
 *  a fully populated lattice we MUST also walk archives/leaf/*\/BODY.md
 *  — that's where the bulk of historical Q/A lives.
 */
export function importEdgeConvo(
  store: LatticeStore,
  edgeDir: string,
  context: string = edgeDir,
): ImportResult {
  let qIns = 0, qDup = 0, aIns = 0, aDup = 0;
  let sectionsParsed = 0;
  let pairsFound = 0;
  let archivesWalked = 0;

  // Build the list of source files to import: live CONVO.md + every
  // archives/leaf/*\/BODY.md.
  type Source = { filePath: string; subContext: string };
  const sources: Source[] = [];

  const convoPath = path.join(edgeDir, "CONVO.md");
  if (fs.existsSync(convoPath)) {
    sources.push({ filePath: convoPath, subContext: `${context}#live` });
  }

  const leafDir = path.join(edgeDir, "archives", "leaf");
  if (fs.existsSync(leafDir)) {
    for (const arc of fs.readdirSync(leafDir).sort()) {
      const arcDir = path.join(leafDir, arc);
      if (!fs.statSync(arcDir).isDirectory()) continue;
      const bodyPath = path.join(arcDir, "BODY.md");
      if (fs.existsSync(bodyPath)) {
        sources.push({ filePath: bodyPath, subContext: `${context}#${arc}` });
        archivesWalked++;
      }
    }
  }

  if (sources.length === 0) {
    return {
      edge_dir: edgeDir, sections_parsed: 0, pairs_found: 0,
      questions_inserted: 0, questions_already_existed: 0,
      answers_inserted: 0, answers_already_existed: 0,
      archives_walked: 0,
    };
  }

  for (const src of sources) {
    const content = fs.readFileSync(src.filePath, "utf8");
    const sections = parseSections(content);
    sectionsParsed += sections.length;
    const pairs = pairSections(sections);
    pairsFound += pairs.length;
    const ctx = src.subContext;
    importPairs(store, pairs, ctx, (cnts) => {
      qIns += cnts.qIns;
      qDup += cnts.qDup;
      aIns += cnts.aIns;
      aDup += cnts.aDup;
    });
  }

  return {
    edge_dir: edgeDir,
    sections_parsed: sectionsParsed,
    pairs_found: pairsFound,
    questions_inserted: qIns,
    questions_already_existed: qDup,
    answers_inserted: aIns,
    answers_already_existed: aDup,
    archives_walked: archivesWalked,
  };
}

/** Internal: convert Q/A pairs into store rows. Extracted from
 *  importEdgeConvo so the same logic is used across CONVO.md and
 *  archived BODY.md sources. */
function importPairs(
  store: LatticeStore,
  pairs: QAPair[],
  context: string,
  tally: (cnts: { qIns: number; qDup: number; aIns: number; aDup: number }) => void,
): void {
  let qIns = 0, qDup = 0, aIns = 0, aDup = 0;
  let skippedMalformedTimestamps = 0;

  for (const { user, assistant } of pairs) {
    // Defend against malformed UTC strings — Date.parse returns NaN
    // for unrecognized formats AND silently accepts non-strict-UTC
    // formats (e.g. "+0500" offsets, missing Z, space separator)
    // that shift timestamps in subtle ways. K-imp-8 fix (NL10
    // keystone): require strict ISO-8601 UTC with Z suffix BEFORE
    // Date.parse. Skip non-conforming strings as malformed.
    const userMs = parseStrictUtc(user.utc);
    const assistantMs = parseStrictUtc(assistant.utc);
    if (Number.isNaN(userMs) || Number.isNaN(assistantMs)) {
      skippedMalformedTimestamps++;
      continue;
    }
    const questionId = canonicalIdOf(user.body);
    const posedAt = Math.floor(userMs / 1000);

    // K-imp-4 fix (NL18 keystone): race-safe atomic insert.
    // Pre-fix this was getQuestion → if-null-putQuestion, which is the
    // textbook check-then-act race. Two parallel importers reading at the
    // same moment both saw null, both proceeded to putQuestion, and the
    // second collided with "UNIQUE constraint failed: questions.id".
    // Post-fix: tryPutQuestion uses INSERT OR IGNORE (atomic at the SQL
    // level). On success the row is ours; on miss the row already exists
    // and we re-read for the existing record (only when we actually need
    // it for downstream lookups).
    //
    // Insert as "open" first, then promote to "answered" via
    // setQuestionStatus after the answer is recorded. Pre-iter-5 this
    // was status="answered"+best_answer_id=null, which transiently
    // violated the joint-consistency invariant the iter-5 guard now
    // enforces (sqlite-store.ts:enforceQuestionStatusInvariant).
    const q: Question = {
      id: questionId,
      framing: user.body,
      status: "open",
      best_answer_id: null,
      posed_at: posedAt,
      posed_by: user.agent,
      posed_in_context: context,
      depth: 0,
    };
    const inserted = store.tryPutQuestion(q);
    let existing: Question | null;
    if (inserted) {
      qIns++;
      existing = null;
    } else {
      qDup++;
      existing = store.getQuestion(questionId);
    }

    // Detect ephemeral peer review responses (sections written by the
    // ephemeral-peer-review CLI). These ARE substantive content (the
    // peer's actual review), not transcript scrape, so they get an
    // authored explanation + tier 3 (peer-validated) instead of the
    // tier-5 auto-imported placeholder.
    const isPeerReviewResponse = assistant.description
      .toLowerCase()
      .startsWith("ephemeral peer review response");

    const explanation = isPeerReviewResponse
      ? `Peer review response from ${assistant.agent} to orion's review request. Body content IS the substantive review — bullet points naming real issues per the QUALITY BAR rule.`
      : "(auto-imported from CONVO.md; no original explanation captured at write time. " +
        "Subsequent answers in the lattice will require explanations per Apprenticeship Substrate forcing function 1.)";
    const qualityTier: QualityTier = isPeerReviewResponse ? 3 : 5;

    try {
      // K-imp-6 fix (NL22 / keystone NL5 finding): capture the inserted
      // Answer's id and use it directly to pin best_answer_id. Pre-fix
      // the code called queryAnswers(limit:1) with default
      // order_by=predictive_lift_desc; with imported answers all carrying
      // predictive_lift=0, SQLite's tie-break (typically ROWID/insertion
      // order) decided which row was "top" — usually the OLDEST, not the
      // just-inserted one. The condition then often refused to update
      // because the existing best_answer_id matched the queried-top.
      // Net effect: re-importing a Q/A pair with a new agent's response
      // didn't repoint best_answer_id at the new answer (the comment's
      // stated intent). Now: deterministic pin via recordAnswer's return.
      const insertedAnswer = recordAnswer(store, {
        question_id: questionId,
        body: assistant.body,
        by_agent: assistant.agent,
        explanation,
        predictive_lift: 0,
        status: "accepted",     // the assistant did answer; conservatively mark as accepted
        quality_tier: qualityTier,
        validator_id: null,
        created_at: Math.floor(assistantMs / 1000),
      });
      aIns++;
      if (!existing || existing.best_answer_id !== insertedAnswer.id) {
        store.setQuestionStatus(questionId, "answered", insertedAnswer.id);
      }
    } catch (e) {
      // K-imp-5 fix (NL13): discriminate PK conflicts from other errors.
      // Pre-fix this catch ate ALL errors as aDup++, silently masking
      // FK violations, CHECK failures, dual-output enforcement throws,
      // etc. Now: PK conflict → aDup++; everything else → propagate.
      if (!isPrimaryKeyConflict(e)) {
        // Non-PK error — surface it. Re-throw so the import fails loudly
        // rather than silently miscounting.
        throw e;
      }
      // PRIMARY KEY conflict (already imported). Count as dup.
      // For ephemeral peer review responses, RETROACTIVELY upgrade an
      // existing auto-imported placeholder to the authored explanation
      // and tier — happens when a peer review was imported BEFORE this
      // detection logic existed. Idempotent: subsequent re-imports of
      // an already-upgraded answer are no-ops because explanation and
      // tier already match.
      aDup++;
      if (isPeerReviewResponse) {
        // K-imp-7 fix (NL25 / keystone NL5 finding): compute the answer
        // id directly via makeAnswerId. Pre-fix the code did
        // queryAnswers(limit:5) + find() to locate the answer matching
        // (by_agent, body) — same SHAPE as K-imp-6. When the question
        // had 6+ accepted answers and the target was at rank 6+ by
        // predictive_lift_desc, the SQL limit truncated it out and the
        // retro-upgrade silently no-op'd. Post-fix: the answer's id is
        // deterministic from (question_id, body, by_agent) and we just
        // PK-conflicted on it (the catch block ABOVE confirmed it
        // exists), so getAnswer(makeAnswerId(...)) is correct AND
        // cheaper than the queryAnswers+find dance.
        const existingId = makeAnswerId(questionId, assistant.body, assistant.agent);
        const existingAns = store.getAnswer(existingId);
        if (existingAns && (existingAns.explanation ?? "").includes("auto-imported")) {
          store.setAnswerExplanation(existingAns.id, explanation);
          store.setAnswerQualityTier(existingAns.id, qualityTier);
        }
      }
    }
  }

  if (skippedMalformedTimestamps > 0) {
    console.error(`# importPairs[${context}]: skipped ${skippedMalformedTimestamps} pair(s) with malformed UTC timestamps`);
  }
  tally({ qIns, qDup, aIns, aDup });
}

/** Walk all edges under <conv>/<topology>/<edge>/ and import each. */
export function importAllEdges(store: LatticeStore, convDir: string): ImportResult[] {
  const results: ImportResult[] = [];
  if (!fs.existsSync(convDir)) return results;
  for (const topo of fs.readdirSync(convDir)) {
    if (topo.startsWith(".")) continue;
    const topoDir = path.join(convDir, topo);
    if (!fs.statSync(topoDir).isDirectory()) continue;
    for (const edge of fs.readdirSync(topoDir)) {
      const edgeDir = path.join(topoDir, edge);
      if (!fs.statSync(edgeDir).isDirectory()) continue;
      const convoPath = path.join(edgeDir, "CONVO.md");
      if (!fs.existsSync(convoPath)) continue;
      results.push(importEdgeConvo(store, edgeDir, `${topo}/${edge}`));
    }
  }
  return results;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function defaultLatticeDbPath(convDir: string): string {
  return path.join(convDir, "lattice.db");
}

function defaultConvDir(): string {
  return process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
    "/data/lumeyon/agent-chat/conversations";
}

function printResult(r: ImportResult): void {
  console.log(`  ${r.edge_dir}`);
  console.log(`    archives_walked=${r.archives_walked}  sections_parsed=${r.sections_parsed}  pairs_found=${r.pairs_found}`);
  console.log(`    questions: +${r.questions_inserted} (already existed: ${r.questions_already_existed})`);
  console.log(`    answers:   +${r.answers_inserted} (already existed: ${r.answers_already_existed})`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const convDir = defaultConvDir();
  const dbPath = process.env.AGENT_CHAT_LATTICE_DB ?? defaultLatticeDbPath(convDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new LatticeStore(dbPath);
  try {
    if (args[0] === "--all") {
      const targetConv = args[1] ?? convDir;
      const results = importAllEdges(store, targetConv);
      console.log(`# imported all edges under ${targetConv} into ${dbPath}`);
      for (const r of results) printResult(r);
      const tot = results.reduce(
        (acc, r) => ({
          q_ins: acc.q_ins + r.questions_inserted,
          a_ins: acc.a_ins + r.answers_inserted,
        }),
        { q_ins: 0, a_ins: 0 },
      );
      console.log(`# totals: ${tot.q_ins} questions, ${tot.a_ins} answers inserted`);
    } else if (args[0]) {
      const edgeDir = path.resolve(args[0]);
      const result = importEdgeConvo(store, edgeDir);
      console.log(`# imported ${edgeDir} into ${dbPath}`);
      printResult(result);
    } else {
      console.error("usage: import-from-kg.ts <edge_dir> | --all [<conv_dir>]");
      process.exit(2);
    }
    const stats = store.stats();
    console.log(`# lattice stats: ${JSON.stringify(stats)}`);
  } finally {
    store.close();
  }
}
