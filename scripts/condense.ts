// condense.ts — fold N same-depth archives into one depth+1 archive.
// Mirrors lossless-claw's condensed pass: sibling summaries at depth d are
// combined into a single summary at depth d+1, with parent links preserved
// so the agent can drill back down via search.ts expand.
//
// Usage:
//   bun scripts/condense.ts plan <peer> [--depth d]                     dry-run; show eligible groups
//   bun scripts/condense.ts seal <peer> [--depth d] [--limit N]         seal one condensed archive
//                                                                       from the N oldest unfolded
//                                                                       archives at depth d (default
//                                                                       d=0, N=4)
//   bun scripts/condense.ts commit <peer> <archive-id>                  validate + finalize
//
// Same two-step seal/commit dance as archive.ts: the script writes a stub
// SUMMARY.md the agent fills in, then commit gates the index entry on a
// passing validator.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf,
  utcStamp, archiveId, condensedArchiveDir, archivesRoot,
  appendIndexEntry, readIndex, writeYaml, renderSummaryStub,
  validateSummary, extractTldr, extractKeywords,
  type IndexEntry,
} from "./lib.ts";

const DEFAULT_DEPTH = 0;
const DEFAULT_LIMIT = 4;       // condense 4 leaves into 1 d1 by default

function die(msg: string): never { console.error(msg); process.exit(2); }

function parseArgs(argv: string[]) {
  const [op, peer, ...rest] = argv;
  const opts: { depth: number; limit: number; archiveId: string | null } = {
    depth: DEFAULT_DEPTH, limit: DEFAULT_LIMIT, archiveId: null,
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--depth") opts.depth = parseInt(rest[++i] ?? "", 10);
    else if (rest[i] === "--limit") opts.limit = parseInt(rest[++i] ?? "", 10);
    else if (!opts.archiveId && rest[i].startsWith("arch_")) opts.archiveId = rest[i];
  }
  if (!Number.isFinite(opts.depth) || opts.depth < 0) die("--depth must be >= 0");
  if (!Number.isFinite(opts.limit) || opts.limit < 2) die("--limit must be >= 2");
  return { op, peer, opts };
}

const { op, peer, opts } = parseArgs(process.argv.slice(2));
if (!op || !peer) die("usage: condense.ts <plan|seal|commit> <peer> [args]");

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);
const edge = edges.find((e) => e.peer === peer);
if (!edge) die(`${peer} is not a neighbor of ${id.name} in topology ${id.topology}`);
const participants: [string, string] = [id.name, peer].sort() as [string, string];

function eligibleAtDepth(depth: number): IndexEntry[] {
  // "Eligible" = at depth d and not already a parent of any depth-(d+1) entry.
  const idx = readIndex(edge.dir);
  const folded = new Set<string>();
  for (const e of idx) if (e.depth === depth + 1) for (const p of e.parents) folded.add(p);
  return idx
    .filter((e) => e.depth === depth && !folded.has(e.id))
    .sort((a, b) => a.earliest_at.localeCompare(b.earliest_at));
}

function pendingCondensed(): string[] {
  // Pending = condensed archive directory exists but no index entry.
  const root = path.join(archivesRoot(edge.dir), "condensed");
  if (!fs.existsSync(root)) return [];
  const indexed = new Set(readIndex(edge.dir).map((e) => e.id));
  const out: string[] = [];
  for (const bucket of fs.readdirSync(root)) {
    const bdir = path.join(root, bucket);
    if (!fs.statSync(bdir).isDirectory()) continue;
    for (const a of fs.readdirSync(bdir)) {
      if (!indexed.has(a)) out.push(a);
    }
  }
  return out;
}

switch (op) {
  case "plan": {
    const eligible = eligibleAtDepth(opts.depth);
    console.log(`edge:                 ${edge.id}`);
    console.log(`depth:                ${opts.depth} → ${opts.depth + 1}`);
    console.log(`eligible archives:    ${eligible.length}`);
    if (eligible.length < opts.limit) {
      console.log(`(below --limit ${opts.limit}; nothing to condense yet)`);
    } else {
      console.log(`would fold the oldest ${opts.limit}:`);
      for (const e of eligible.slice(0, opts.limit)) {
        console.log(`  ${e.id}  ${e.earliest_at} → ${e.latest_at}  ${e.tldr.slice(0, 80)}`);
      }
    }
    const pending = pendingCondensed();
    if (pending.length) console.log(`\npending uncommitted condensed: ${pending.join(", ")}`);
    break;
  }

  case "seal": {
    const eligible = eligibleAtDepth(opts.depth);
    if (eligible.length < opts.limit) die(`only ${eligible.length} eligible at depth ${opts.depth}; need >= ${opts.limit}`);
    const group = eligible.slice(0, opts.limit);
    const earliest = group[0].earliest_at;
    const latest = group[group.length - 1].latest_at;
    const targetDepth = opts.depth + 1;
    const aid = archiveId("condensed", latest);
    const adir = condensedArchiveDir(edge.dir, targetDepth, aid);
    fs.mkdirSync(adir, { recursive: true });

    // Build the source text: the SUMMARY.md of each parent, concatenated with
    // a header so the agent can see the time range and id of each child.
    const blocks: string[] = [];
    for (const e of group) {
      const summaryPath = path.join(e.path, "SUMMARY.md");
      const txt = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "(missing SUMMARY.md)";
      blocks.push(`<!-- parent: ${e.id} (${e.earliest_at} → ${e.latest_at}) -->\n${txt}`);
    }
    const sourceText = blocks.join("\n\n----\n\n");

    const stub = renderSummaryStub({
      edgeId: edge.id,
      archiveId: aid,
      kind: "condensed",
      depth: targetDepth,
      participants,
      earliestAt: earliest,
      latestAt: latest,
      sourceLabel: `${group.length} depth-${opts.depth} summaries`,
      sourceText,
    });
    fs.writeFileSync(path.join(adir, "SUMMARY.md"), stub);

    const descendantSum = group.reduce((acc, e) => acc + (e.descendant_count || 0) + (e.kind === "leaf" ? 1 : 0), 0);

    writeYaml(path.join(adir, "META.yaml"), {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "condensed",
      depth: targetDepth,
      status: "pending-commit",
      participants,
      earliest_at: earliest,
      latest_at: latest,
      parents: group.map((e) => e.id),
      descendant_count: descendantSum,
      created_at: utcStamp(),
    });

    console.log(`sealed ${aid} at depth ${targetDepth}`);
    console.log(`  folds: ${group.map((e) => e.id).join(", ")}`);
    console.log(`  SUMMARY.md: ${path.join(adir, "SUMMARY.md")} (stub — fill it in, then run commit)`);
    console.log(`  META.yaml:  ${path.join(adir, "META.yaml")} (status: pending-commit)`);
    console.log("");
    console.log(`Next: edit the SUMMARY.md (fill every TODO), then run:`);
    console.log(`  bun scripts/condense.ts commit ${peer} ${aid}`);
    break;
  }

  case "commit": {
    const aid = opts.archiveId;
    if (!aid) die("usage: condense.ts commit <peer> <arch_...>");
    // Find the depth bucket containing this archive.
    const root = path.join(archivesRoot(edge.dir), "condensed");
    let adir = "";
    let depth = 0;
    if (fs.existsSync(root)) {
      for (const bucket of fs.readdirSync(root)) {
        const tryDir = path.join(root, bucket, aid);
        if (fs.existsSync(tryDir)) { adir = tryDir; depth = parseInt(bucket.replace(/^d/, ""), 10); break; }
      }
    }
    if (!adir) die(`no such condensed archive: ${aid}`);

    const summaryPath = path.join(adir, "SUMMARY.md");
    const summary = fs.readFileSync(summaryPath, "utf8");
    const v = validateSummary(summary);
    if (!v.ok) {
      console.error(`SUMMARY.md is not ready:`);
      for (const issue of v.issues) console.error(`  - ${issue}`);
      process.exit(3);
    }

    const tldr = extractTldr(summary);
    const keywords = extractKeywords(summary);

    const metaText = fs.readFileSync(path.join(adir, "META.yaml"), "utf8");
    const earliest = (metaText.match(/^earliest_at:\s*"?([^"\n]+)"?$/m) ?? [])[1] ?? utcStamp();
    const latest = (metaText.match(/^latest_at:\s*"?([^"\n]+)"?$/m) ?? [])[1] ?? utcStamp();
    // parents come back inline-encoded as JSON; pull each out.
    const parentsLine = (metaText.match(/^parents:\s*(\[.*\])$/m) ?? [])[1] ?? "[]";
    const parents: string[] = JSON.parse(parentsLine);
    const descendantSum = parseInt((metaText.match(/^descendant_count:\s*(\d+)/m) ?? ["0", "0"])[1], 10);

    writeYaml(path.join(adir, "META.yaml"), {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "condensed",
      depth,
      status: "sealed",
      participants,
      earliest_at: earliest,
      latest_at: latest,
      parents,
      descendant_count: descendantSum,
      keywords,
      tldr,
      committed_at: utcStamp(),
    });

    // Refuse if any declared parent has been removed from the index since
    // seal (manual delete, racing abort). Without this, a commit would
    // create structural drift that the doctor command would later flag
    // (keystone P1 drift-prevention).
    const idx = readIndex(edge.dir);
    const knownIds = new Set(idx.map((e) => e.id));
    const missing = parents.filter((p) => !knownIds.has(p));
    if (missing.length) {
      die(`refuse to commit — declared parent(s) missing from index: ${missing.join(", ")}. ` +
          `Run \`bun scripts/archive.ts doctor ${peer}\` to inspect, then remove or re-seal.`);
    }

    const cleanSummary = summary.replace(/<!--[\s\S]*?-->\s*\n?/g, "");
    fs.writeFileSync(summaryPath, cleanSummary);

    const entry: IndexEntry = {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "condensed",
      depth,
      earliest_at: earliest,
      latest_at: latest,
      participants,
      parents,
      descendant_count: descendantSum,
      keywords,
      tldr,
      path: adir,
    };
    appendIndexEntry(edge.dir, entry, { fsync: true });

    console.log(`committed condensed ${aid} (depth ${depth}, folds ${parents.length} parent(s), ${descendantSum} leaf descendants)`);
    break;
  }

  default:
    die(`unknown op: ${op}`);
}
