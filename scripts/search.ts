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
//                                        [--scope summaries|tldr|keywords|all]
//                                        [--depth N] [--all-edges] [--json]
//   bun scripts/search.ts describe <archive-id>                         (full SUMMARY.md + META)
//   bun scripts/search.ts expand <archive-id> [--children]              (BODY.md for leaf, or
//                                                                        child SUMMARY.mds for condensed)
//   bun scripts/search.ts list [--peer p] [--depth N] [--all-edges]     (index entries by edge)

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf, readIndex, type IndexEntry,
} from "./lib.ts";

function die(msg: string): never { console.error(msg); process.exit(2); }

function parseArgs(argv: string[]) {
  const [op, ...rest] = argv;
  const opts = {
    pattern: "" as string,
    archiveId: "" as string,
    peer: "" as string,
    since: "" as string,
    before: "" as string,
    scope: "all" as "summaries" | "tldr" | "keywords" | "all",
    depth: NaN as number,
    allEdges: false,
    json: false,
    children: false,
  };
  let positional = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--peer") opts.peer = rest[++i] ?? "";
    else if (a === "--since") opts.since = rest[++i] ?? "";
    else if (a === "--before") opts.before = rest[++i] ?? "";
    else if (a === "--scope") opts.scope = (rest[++i] ?? "all") as typeof opts.scope;
    else if (a === "--depth") opts.depth = parseInt(rest[++i] ?? "", 10);
    else if (a === "--all-edges") opts.allEdges = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--children") opts.children = true;
    else if (!positional) positional = a;
  }
  if (op === "grep") opts.pattern = positional;
  else if (op === "describe" || op === "expand") opts.archiveId = positional;
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

switch (op) {
  case "grep": {
    if (!opts.pattern) die("usage: search.ts grep <pattern> [filters]");
    let re: RegExp;
    try { re = new RegExp(opts.pattern, "i"); } catch (err) { die(`bad regex: ${(err as Error).message}`); }
    const entries = filterByCommon(loadAllEntries());
    const hits: { entry: IndexEntry; where: string; snippet: string }[] = [];
    for (const e of entries) {
      const candidates: { where: string; text: string }[] = [];
      // Order matters: we `break` on first hit, so the richest source goes
      // FIRST (rhino's free-win catch). Pre-fix, the 240-char tldr always
      // won over the much richer SUMMARY.md, even with --scope all.
      if (opts.scope === "all" || opts.scope === "summaries") {
        const sp = path.join(e.path, "SUMMARY.md");
        if (fs.existsSync(sp)) candidates.push({ where: "summary", text: fs.readFileSync(sp, "utf8") });
      }
      if (opts.scope === "all" || opts.scope === "tldr") candidates.push({ where: "tldr", text: e.tldr ?? "" });
      if (opts.scope === "all" || opts.scope === "keywords") candidates.push({ where: "keywords", text: (e.keywords ?? []).join(" ") });
      for (const c of candidates) {
        const m = c.text.match(re);
        if (m) {
          const idx0 = c.text.search(re);
          const start = Math.max(0, idx0 - 60);
          const end = Math.min(c.text.length, idx0 + (m[0].length ?? 0) + 80);
          const snippet = c.text.slice(start, end).replace(/\s+/g, " ").trim();
          hits.push({ entry: e, where: c.where, snippet });
          break; // one hit per archive is enough; describe to drill in
        }
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(hits, null, 2));
      break;
    }
    if (!hits.length) { console.log("no matches"); break; }
    for (const h of hits) {
      console.log(`${h.entry.id}  d${h.entry.depth} ${h.entry.kind.padEnd(9)} ${h.entry.edge_id}  [${h.where}]`);
      console.log(`    ${h.snippet}`);
    }
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
    if (!opts.archiveId) die("usage: search.ts expand <arch_...> [--children]");
    const found = findById(opts.archiveId);
    if (!found) die(`no such archive: ${opts.archiveId}`);
    const e = found.entry;
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
    }
    break;
  }

  default:
    die(`unknown op: ${op}`);
}
