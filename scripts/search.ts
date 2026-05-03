// search.ts — grep / describe / expand over the per-edge archive index.
// Mirrors lossless-claw's escalation pattern (lcm_grep → lcm_describe →
// lcm_expand_query) but stays filesystem-only: index.jsonl is the cheap
// surface, SUMMARY.md is the medium surface, BODY.md is the cold surface.
//
// Most lookups stop at grep. Only walk to BODY.md when the SUMMARY.md's
// "Expand for details about:" footer says the thing you want is in there.
//
// Usage:
//   bun scripts/search.ts grep <pattern> [--peer p] [--since ISO] [--before ISO]
//                                        [--scope summaries|tldr|keywords|footer|all]
//                                        [--depth N] [--all-edges] [--json]
//   bun scripts/search.ts describe <archive-id>                         (full SUMMARY.md + META)
//   bun scripts/search.ts expand <archive-id> [--children]              (BODY.md for leaf, or
//                                                                        child SUMMARY.mds for condensed)
//                                  [--max-tokens N]                     (refuse if estimate exceeds; default 50_000
//                                                                        or $AGENT_CHAT_EXPAND_MAX_TOKENS)
//                                  [--delegate]                         (force subagent path; bypass cap refusal)
//                                  [--auto-route]                       (default ON; use expansion-policy decision;
//                                                                        --no-auto-route disables)
//                                  [--no-auto-route]
//   bun scripts/search.ts route <query> [--cap N] [--depth N] [--candidates N]
//                                                                       (print routing decision as JSON; round-12
//                                                                        adds the deterministic answer/shallow/delegate
//                                                                        decision matrix from expansion-policy.ts)
//   bun scripts/search.ts list [--peer p] [--depth N] [--all-edges] [--verbose]
//                                                                       (--verbose surfaces descendant_token_count)

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf, readIndex, type IndexEntry,
} from "./lib.ts";
import {
  decideExpansionRouting, type ExpansionRoutingAction,
} from "./expansion-policy.ts";
import {
  spawnExpansionSubagent,
} from "./subagent.ts";

function die(msg: string): never { console.error(msg); process.exit(2); }

function parseArgs(argv: string[]) {
  const [op, ...rest] = argv;
  const opts = {
    pattern: "" as string,
    archiveId: "" as string,
    query: "" as string,
    peer: "" as string,
    since: "" as string,
    before: "" as string,
    scope: "all" as "summaries" | "tldr" | "keywords" | "footer" | "all",
    depth: NaN as number,
    candidates: NaN as number,
    cap: NaN as number,
    maxTokens: NaN as number,
    allEdges: false,
    json: false,
    children: false,
    verbose: false,
    delegate: false,
    autoRoute: true,   // default ON for `expand` per Round 12 Phase-2 decision
  };
  let positional = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--peer") opts.peer = rest[++i] ?? "";
    else if (a === "--since") opts.since = rest[++i] ?? "";
    else if (a === "--before") opts.before = rest[++i] ?? "";
    else if (a === "--scope") opts.scope = (rest[++i] ?? "all") as typeof opts.scope;
    else if (a === "--depth") opts.depth = parseInt(rest[++i] ?? "", 10);
    else if (a === "--candidates") opts.candidates = parseInt(rest[++i] ?? "", 10);
    else if (a === "--cap") opts.cap = parseInt(rest[++i] ?? "", 10);
    else if (a === "--max-tokens") opts.maxTokens = parseInt(rest[++i] ?? "", 10);
    else if (a === "--all-edges") opts.allEdges = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--children") opts.children = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--delegate") opts.delegate = true;
    else if (a === "--auto-route") opts.autoRoute = true;
    else if (a === "--no-auto-route") opts.autoRoute = false;
    else if (!positional) positional = a;
  }
  if (op === "grep") opts.pattern = positional;
  else if (op === "describe" || op === "expand") opts.archiveId = positional;
  else if (op === "route") opts.query = positional;
  return { op, opts };
}

const { op, opts } = parseArgs(process.argv.slice(2));
if (!op) die("usage: search.ts <grep|describe|expand|list> ...");

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);

function targetEdges() {
  if (opts.allEdges || !opts.peer) return edges;
  const e = edges.find((x) => x.peer === opts.peer);
  if (!e) die(`${opts.peer} is not a neighbor of ${id.name}`);
  return [e];
}

function loadAllEntries(): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of targetEdges()) {
    const idx = readIndex(e.dir);
    out.push(...idx);
  }
  return out;
}

function filterByCommon(entries: IndexEntry[]): IndexEntry[] {
  return entries.filter((e) => {
    if (opts.since && e.latest_at < opts.since) return false;
    if (opts.before && e.earliest_at > opts.before) return false;
    if (Number.isFinite(opts.depth) && e.depth !== opts.depth) return false;
    return true;
  });
}

function findById(aid: string): { entry: IndexEntry } | null {
  // Search every neighbor's index for the archive id.
  for (const e of edges) {
    const idx = readIndex(e.dir);
    const hit = idx.find((x) => x.id === aid);
    if (hit) return { entry: hit };
  }
  return null;
}

async function runOp() {
switch (op) {
  case "grep": {
    if (!opts.pattern) die("usage: search.ts grep <pattern> [filters]");

    // Round 12 slice 2: FTS5 fast path. When `fts.db` exists on every
    // target edge AND scope is "all", route through bm25-ranked SQLite
    // FTS5 query. Hits returned in bm25-ranked order; format mirrors the
    // regex-fallback path so consumers see identical output. When fts.db
    // is missing on any edge, fall through to the regex path so mixed-
    // overlay deployments (some edges sealed pre-FTS, some post) still
    // work correctly. Other scope filters (footer/tldr/keywords) keep
    // using regex — keystone owns those scope-rank semantics on the
    // regex path; FTS5 has its own bm25 weights for column-scoped queries.
    const ftsEligible = opts.scope === "all";
    if (ftsEligible) {
      const tEdges = targetEdges();
      const ftsDbModule = await import("./fts.ts");
      const allHaveFts = tEdges.every((e) => fs.existsSync(ftsDbModule.ftsDbPath(e.dir)));
      if (allHaveFts && tEdges.length > 0) {
        type FtsHit = { entry: IndexEntry; where: string; snippet: string; rank: number };
        const ftsHits: FtsHit[] = [];
        for (const e of tEdges) {
          const idx = readIndex(e.dir);
          const idxById = new Map(idx.map((x) => [x.id, x]));
          const rows = ftsDbModule.query(e.dir, opts.pattern, 100);
          for (const row of rows) {
            const entry = idxById.get(row.archive_id);
            if (!entry) continue;
            // Apply common filters (since/before/depth) on the index entry.
            if (opts.since && entry.latest_at < opts.since) continue;
            if (opts.before && entry.earliest_at > opts.before) continue;
            if (Number.isFinite(opts.depth) && entry.depth !== opts.depth) continue;
            // bm25 returns NEGATIVE scores; flip to positive so higher = better
            // when sorting alongside rank-fallback paths.
            ftsHits.push({
              entry, where: "fts", snippet: row.tldr.slice(0, 140), rank: -row.rank,
            });
          }
        }
        ftsHits.sort((a, b) => b.rank - a.rank);
        if (opts.json) { console.log(JSON.stringify(ftsHits, null, 2)); break; }
        if (!ftsHits.length) { console.log("no matches"); break; }
        for (const h of ftsHits) {
          console.log(`${h.entry.id}  d${h.entry.depth} ${h.entry.kind.padEnd(9)} ${h.entry.edge_id}  [fts:${h.rank.toFixed(2)}]`);
          console.log(`    ${h.snippet}`);
        }
        break;
      }
      // fts.db missing on at least one target edge — fall through to regex.
    }

    let re: RegExp;
    try { re = new RegExp(opts.pattern, "i"); } catch (err) { die(`bad regex: ${(err as Error).message}`); }
    const entries = filterByCommon(loadAllEntries());
    const hits: { entry: IndexEntry; where: string; snippet: string; rank: number }[] = [];
    for (const e of entries) {
      const candidates: { where: string; text: string; rank: number }[] = [];
      // Order matters: we `break` on first hit, so the richest source goes
      // FIRST (rhino's free-win catch from Round 10). Pre-fix, the 240-char
      // tldr always won over the much richer SUMMARY.md.
      // Round 12: footer (Expand-for-details) added with rank 2.5x to match
      // lumeyon's bm25 weighting on the fts5 path. Footer is checked
      // BEFORE the body of SUMMARY.md so a footer hint match labels
      // correctly even when the body also matches.
      if (opts.scope === "all" || opts.scope === "footer" || opts.scope === "summaries") {
        const sp = path.join(e.path, "SUMMARY.md");
        if (fs.existsSync(sp)) {
          const summary = fs.readFileSync(sp, "utf8");
          const footer = extractFooter(summary);
          if (footer) candidates.push({ where: "expand-hint", text: footer, rank: 2.5 });
          if (opts.scope !== "footer") {
            candidates.push({ where: "summary", text: summary, rank: 1.0 });
          }
        }
      }
      if (opts.scope === "all" || opts.scope === "tldr") candidates.push({ where: "tldr", text: e.tldr ?? "", rank: 2.0 });
      if (opts.scope === "all" || opts.scope === "keywords") candidates.push({ where: "keywords", text: (e.keywords ?? []).join(" "), rank: 1.5 });
      for (const c of candidates) {
        const m = c.text.match(re);
        if (m) {
          const idx0 = c.text.search(re);
          const start = Math.max(0, idx0 - 60);
          const end = Math.min(c.text.length, idx0 + (m[0].length ?? 0) + 80);
          const snippet = c.text.slice(start, end).replace(/\s+/g, " ").trim();
          hits.push({ entry: e, where: c.where, snippet, rank: c.rank });
          break; // one hit per archive is enough; describe to drill in
        }
      }
    }
    // Stable sort by rank descending so footer-hint hits surface before
    // plain summary hits when both fire across different archives.
    hits.sort((a, b) => b.rank - a.rank);

    if (opts.json) {
      console.log(JSON.stringify(hits, null, 2));
      break;
    }
    if (!hits.length) { console.log("no matches"); break; }
    for (const h of hits) {
      const tag = h.where === "expand-hint" ? "[expand-hint]" : `[${h.where}]`;
      console.log(`${h.entry.id}  d${h.entry.depth} ${h.entry.kind.padEnd(9)} ${h.entry.edge_id}  ${tag}`);
      console.log(`    ${h.snippet}`);
    }
    break;
  }

  case "route": {
    // Round 12 feature 9: deterministic routing decision over a query.
    // Used directly by humans to inspect a routing call, and indirectly
    // by `expand` when --auto-route is on.
    if (!opts.query) die("usage: search.ts route <query> [--cap N] [--depth N] [--candidates N]");
    const cap = Number.isFinite(opts.cap) ? opts.cap
      : parseInt(process.env.AGENT_CHAT_EXPAND_MAX_TOKENS ?? "50000", 10);
    const candidates = Number.isFinite(opts.candidates) ? opts.candidates : 1;
    const decision = decideExpansionRouting({
      intent: "query_probe",
      query: opts.query,
      candidateSummaryCount: candidates,
      tokenCap: cap,
      requestedMaxDepth: Number.isFinite(opts.depth) ? opts.depth : undefined,
    });
    console.log(JSON.stringify(decision, null, 2));
    break;
  }

  case "describe": {
    if (!opts.archiveId) die("usage: search.ts describe <arch_...>");
    const found = findById(opts.archiveId);
    if (!found) die(`no such archive in any of my edges: ${opts.archiveId}`);
    const e = found.entry;
    console.log(`# ${e.id}  d${e.depth} ${e.kind}  ${e.edge_id}`);
    console.log(`time:        ${e.earliest_at} → ${e.latest_at}`);
    console.log(`participants: ${e.participants.join(", ")}`);
    if (e.parents?.length) console.log(`parents:     ${e.parents.join(", ")}`);
    if (e.descendant_count) console.log(`descendants: ${e.descendant_count}`);
    if (e.body_sha256) console.log(`body sha:    ${e.body_sha256}`);
    console.log(`path:        ${e.path}`);
    console.log("");
    const sp = path.join(e.path, "SUMMARY.md");
    if (fs.existsSync(sp)) {
      console.log(fs.readFileSync(sp, "utf8"));
    } else {
      console.log("(no SUMMARY.md present)");
    }
    break;
  }

  case "expand": {
    if (!opts.archiveId) die("usage: search.ts expand <arch_...> [--children] [--max-tokens N] [--delegate] [--auto-route]");
    const found = findById(opts.archiveId);
    if (!found) die(`no such archive: ${opts.archiveId}`);
    const e = found.entry;
    const cap = Number.isFinite(opts.maxTokens) ? opts.maxTokens
      : parseInt(process.env.AGENT_CHAT_EXPAND_MAX_TOKENS ?? "50000", 10);

    // Round 12 feature 8: pre-flight token estimate. Refuse if estimate
    // exceeds cap, unless --delegate (subagent path) or --auto-route fires.
    // For a leaf: BODY.md byte count / 4. For --children: sum SUMMARY.md
    // sizes / 4 across the parent set.
    let estimatedTokens = 0;
    let candidateCount = 0;
    if (e.kind === "leaf" && !opts.children) {
      const bp = path.join(e.path, "BODY.md");
      if (fs.existsSync(bp)) estimatedTokens = Math.ceil(fs.statSync(bp).size / 4);
      candidateCount = 1;
    } else if (e.kind === "condensed" || opts.children) {
      candidateCount = e.parents?.length ?? 0;
      for (const pid of e.parents ?? []) {
        const sub = findById(pid);
        if (!sub) continue;
        const sp = path.join(sub.entry.path, "SUMMARY.md");
        if (fs.existsSync(sp)) estimatedTokens += Math.ceil(fs.statSync(sp).size / 4);
      }
    }

    // Routing decision (default-on, --no-auto-route disables). When
    // --delegate is explicit, skip routing — user already chose the path.
    let action: ExpansionRoutingAction = "expand_shallow";
    if (!opts.delegate && opts.autoRoute) {
      const decision = decideExpansionRouting({
        intent: "explicit_expand",
        candidateSummaryCount: candidateCount,
        tokenCap: cap,
      });
      action = decision.action;
    }
    if (opts.delegate) action = "delegate_traversal";

    // Cap enforcement — refuse if estimate > cap AND we're not delegating
    // (delegation has its own subagent token budget).
    if (action !== "delegate_traversal" && estimatedTokens > cap) {
      die(
        `expansion would exceed cap (~${estimatedTokens} tokens, cap ${cap}). ` +
        `Pass --max-tokens N to raise, or --delegate to route to a subagent.`,
      );
    }

    if (action === "delegate_traversal") {
      // Subagent delegation. Carina ships scripts/llm.ts with runClaude;
      // keystone wraps it in spawnExpansionSubagent. Until carina lands,
      // the integration falls through to expand_shallow with a stderr note.
      const subagentResult = await spawnExpansionSubagent({
        archiveIds: [e.id, ...(e.parents ?? [])],
        archivePaths: [e.path, ...(e.parents ?? []).map((pid) => findById(pid)?.entry.path).filter(Boolean) as string[]],
        candidateIdsForCitation: [e.id, ...(e.parents ?? [])],
        tokenCap: cap,
        timeoutMs: 90000,
      });
      if (subagentResult.ok) {
        console.log(subagentResult.answer);
        if (subagentResult.citedIds.length) {
          console.log("");
          console.log(`# cited: ${subagentResult.citedIds.join(", ")}`);
        }
        break;
      }
      // Subagent fallback: stderr warning + fall through to expand_shallow.
      // Vanguard's Phase-1 design: stable reason enum so log scrapers can
      // categorize, partial-stdout citations merged into the shallow result.
      console.error(`warning: subagent expansion failed (${subagentResult.reason}); falling back to shallow grep. Results may be incomplete.`);
      if (subagentResult.partialAnswer) {
        console.error(`(partial subagent output captured before fallback: ${subagentResult.partialAnswer.slice(0, 200)}…)`);
      }
      // Fall through to expand_shallow below.
    }

    // expand_shallow / answer_directly path (default).
    if (e.kind === "leaf" && !opts.children) {
      const bp = path.join(e.path, "BODY.md");
      if (!fs.existsSync(bp)) die(`leaf has no BODY.md at ${bp}`);
      console.log(fs.readFileSync(bp, "utf8"));
      break;
    }
    // condensed (or --children on a leaf, which is meaningless): walk parents.
    if (e.kind === "leaf") die("leaf has no children — drop --children");
    if (!e.parents?.length) { console.log("(condensed has no parent ids — corrupted index?)"); break; }
    // Cycle guard: a manually-edited META.yaml could create
    // `arch_A.parents=[arch_B], arch_B.parents=[arch_A]` and crash this
    // expand into an infinite loop if anyone adds transitive walking later.
    // Cheap insurance now (~5 lines) so the future variant doesn't hang.
    // Keystone #5.
    const visited = new Set<string>();
    visited.add(e.id);
    for (const pid of e.parents) {
      if (visited.has(pid)) { console.log(`---\n${pid}: already visited (cycle in parent chain)`); continue; }
      visited.add(pid);
      const sub = findById(pid);
      if (!sub) { console.log(`---\n${pid}: NOT FOUND in index`); continue; }
      const sp = path.join(sub.entry.path, "SUMMARY.md");
      console.log(`\n========= ${pid}  d${sub.entry.depth} ${sub.entry.kind}  ${sub.entry.earliest_at} → ${sub.entry.latest_at} =========`);
      if (fs.existsSync(sp)) console.log(fs.readFileSync(sp, "utf8"));
      else console.log("(no SUMMARY.md)");
    }
    break;
  }

  case "list": {
    const entries = filterByCommon(loadAllEntries())
      .sort((a, b) => a.earliest_at.localeCompare(b.earliest_at));
    if (!entries.length) { console.log("no archives"); break; }
    for (const e of entries) {
      console.log(`${e.id}  d${e.depth} ${e.kind.padEnd(9)} ${e.edge_id}  ${e.earliest_at} → ${e.latest_at}`);
      if (e.tldr) console.log(`    ${e.tldr.slice(0, 140)}`);
      if (opts.verbose) {
        // Round 12 feature 12: surface descendant_token_count on --verbose.
        // Optional field for backward-compat — legacy entries treat as 0.
        const tokens = (e as any).descendant_token_count ?? 0;
        console.log(`    descendant_token_count: ${tokens}`);
      }
    }
    break;
  }

  default:
    die(`unknown op: ${op}`);
}
}  // end runOp

void runOp();

// ---------------------------------------------------------------------------
// Helpers (Round 12 — Slice 3 keystone)
// ---------------------------------------------------------------------------

// Extract the body of the `## Expand for details about:` section from a
// SUMMARY.md text. Returns the body text (one line per drop-or-compress
// hint) or null when the section is missing/empty. Used by `grep` to
// score footer hits 2.5x a body hit (matches lumeyon's bm25 weighting on
// the fts5 path; this is the regex-fallback equivalent).
function extractFooter(summary: string): string | null {
  // Match the heading line then capture everything until the next `## `
  // heading or end-of-file. Tolerant of fractional-seconds timestamps and
  // setext / atx variants (lumeyon's section parser handles those upstream;
  // we only need to find ATX h2 here).
  const m = summary.match(/^##\s+Expand for details about:?\s*$([\s\S]*?)(?=^##\s+|\Z)/m);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
}

// Subagent delegation helper moved to scripts/subagent.ts so importing
// `spawnExpansionSubagent` for tests doesn't trigger search.ts's top-level
// dispatcher (which would die on a missing op).
