// archive.ts — seal the prefix of CONVO.md (everything before the fresh tail)
// into a depth-0 leaf archive. Inspired by lossless-claw's leaf-pass:
// raw sections → BODY.md (verbatim, sealed) plus SUMMARY.md (agent-written,
// must end with the "Expand for details about:" footer) plus META.yaml.
//
// Usage:
//   bun scripts/archive.ts plan <peer>                            (dry-run: show what would seal)
//   bun scripts/archive.ts seal <peer> [--fresh-tail N] [--force]
//                                                              (writes BODY.md + stub SUMMARY.md;
//                                                               truncates CONVO.md;
//                                                               appends pending entry to index.jsonl —
//                                                               but ONLY after the agent fills the
//                                                               summary and runs `commit`)
//   bun scripts/archive.ts commit <peer> <archive-id>            (validate + finalize: index entry
//                                                               written, archive marked sealed)
//   bun scripts/archive.ts list <peer>                           (list archives for an edge)
//
// The two-step seal/commit dance exists because the SUMMARY.md is written by
// the agent in conversation context, not by a script LLM call. The seal step
// freezes the body; commit gates the index update on a passing validator.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf, ensureEdgeFiles,
  readTurn, writeTurnAtomic, utcStamp, parseSections, splitForArchive,
  sectionMeta, timeRangeOf, archiveId, leafArchiveDir, archivesRoot,
  appendIndexEntry, readIndex, writeYaml, sha256, renderSummaryStub,
  validateSummary, extractTldr, extractKeywords,
  type IndexEntry,
} from "./lib.ts";

const DEFAULT_FRESH_TAIL = 4;

function die(msg: string): never { console.error(msg); process.exit(2); }

function parseArgs(argv: string[]) {
  const [op, peer, ...rest] = argv;
  const opts: { freshTail: number; force: boolean; archiveId: string | null } = {
    freshTail: DEFAULT_FRESH_TAIL, force: false, archiveId: null,
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--fresh-tail") opts.freshTail = parseInt(rest[++i] ?? "", 10);
    else if (rest[i] === "--force") opts.force = true;
    else if (!opts.archiveId && rest[i].startsWith("arch_")) opts.archiveId = rest[i];
  }
  if (!Number.isFinite(opts.freshTail) || opts.freshTail < 0) die("--fresh-tail must be >= 0");
  return { op, peer, opts };
}

const { op, peer, opts } = parseArgs(process.argv.slice(2));
if (!op || !peer) die("usage: archive.ts <plan|seal|commit|list> <peer> [args]");

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);
const edge = edges.find((e) => e.peer === peer);
if (!edge) die(`${peer} is not a neighbor of ${id.name} in topology ${id.topology}`);
const participants: [string, string] = [id.name, peer].sort() as [string, string];

function loadConvo(): string {
  if (!fs.existsSync(edge.convo)) die(`no CONVO.md at ${edge.convo} — initialize the edge first`);
  return fs.readFileSync(edge.convo, "utf8");
}

function pendingArchives(): string[] {
  // An archive whose BODY.md exists but which doesn't yet have an index entry
  // is "pending commit". Useful so the agent doesn't accidentally re-seal.
  const root = path.join(archivesRoot(edge.dir), "leaf");
  if (!fs.existsSync(root)) return [];
  const indexed = new Set(readIndex(edge.dir).map((e) => e.id));
  return fs.readdirSync(root).filter((d) => !indexed.has(d));
}

switch (op) {
  case "plan": {
    const convo = loadConvo();
    const split = splitForArchive(convo, opts.freshTail);
    console.log(`edge:                ${edge.id}`);
    console.log(`sections total:      ${split.sectionCount}`);
    console.log(`sections to archive: ${split.archivableSectionCount}`);
    console.log(`fresh tail:          ${split.sectionCount - split.archivableSectionCount} (kept verbatim)`);
    console.log(`bytes archivable:    ${split.archivable.length}`);
    console.log(`bytes fresh tail:    ${split.freshTail.length}`);
    const pending = pendingArchives();
    if (pending.length) console.log(`pending uncommitted: ${pending.join(", ")}`);
    if (split.archivableSectionCount === 0) {
      console.log("nothing to archive — fresh tail covers all sections.");
    }
    break;
  }

  case "seal": {
    if (readTurn(edge.turn) !== "parked" && !opts.force) {
      die(`refuse to seal — .turn is "${readTurn(edge.turn)}", not "parked". Park the edge first or pass --force.`);
    }
    if (fs.existsSync(edge.lock)) die(`edge is locked: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
    const pending = pendingArchives();
    if (pending.length && !opts.force) die(`uncommitted archive(s) pending — commit them first: ${pending.join(", ")}`);

    const convo = loadConvo();
    const split = splitForArchive(convo, opts.freshTail);
    if (split.archivableSectionCount === 0) die("nothing to archive — fresh tail covers all sections.");

    const archivedSections = parseSections(convo).sections.slice(0, split.archivableSectionCount);
    const tr = timeRangeOf(archivedSections);
    const aid = archiveId("leaf", tr.latest);
    const adir = leafArchiveDir(edge.dir, aid);
    fs.mkdirSync(adir, { recursive: true });

    // Write BODY.md verbatim (the sealed source of truth).
    const body = split.archivable;
    fs.writeFileSync(path.join(adir, "BODY.md"), body);

    // Write SUMMARY.md as a stub the agent fills in.
    const stub = renderSummaryStub({
      edgeId: edge.id,
      archiveId: aid,
      kind: "leaf",
      depth: 0,
      participants,
      earliestAt: tr.earliest,
      latestAt: tr.latest,
      sourceLabel: `${archivedSections.length} raw section(s) from CONVO.md`,
      sourceText: body,
    });
    fs.writeFileSync(path.join(adir, "SUMMARY.md"), stub);

    // META is partial until commit. Mark status pending.
    writeYaml(path.join(adir, "META.yaml"), {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "leaf",
      depth: 0,
      status: "pending-commit",
      participants,
      earliest_at: tr.earliest,
      latest_at: tr.latest,
      source_section_count: archivedSections.length,
      body_sha256: sha256(body),
      created_at: utcStamp(),
    });

    // Truncate CONVO.md to header + breadcrumb + fresh tail.
    const breadcrumb = `\n<!-- archive breadcrumb: ${aid} sealed at ${utcStamp()} (${archivedSections.length} sections, ${tr.earliest} → ${tr.latest}) — see archives/leaf/${aid}/ -->\n\n`;
    const newConvo = split.header.replace(/\n+$/, "\n") + breadcrumb + (split.freshTail ? `---\n\n${split.freshTail}` : "");
    fs.writeFileSync(edge.convo, newConvo);

    console.log(`sealed ${aid}`);
    console.log(`  BODY.md:    ${path.join(adir, "BODY.md")}`);
    console.log(`  SUMMARY.md: ${path.join(adir, "SUMMARY.md")} (stub — fill it in, then run commit)`);
    console.log(`  META.yaml:  ${path.join(adir, "META.yaml")} (status: pending-commit)`);
    console.log("");
    console.log(`Next: edit the SUMMARY.md (fill every TODO, drop the comment blocks), then run:`);
    console.log(`  bun scripts/archive.ts commit ${peer} ${aid}`);
    break;
  }

  case "commit": {
    const aid = opts.archiveId;
    if (!aid) die("usage: archive.ts commit <peer> <arch_...>");
    const adir = leafArchiveDir(edge.dir, aid);
    if (!fs.existsSync(adir)) die(`no such archive: ${adir}`);

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

    // Re-read META so we keep created_at + body_sha256 consistent.
    const metaText = fs.readFileSync(path.join(adir, "META.yaml"), "utf8");
    const earliest = (metaText.match(/^earliest_at:\s*"?([^"\n]+)"?$/m) ?? [])[1] ?? utcStamp();
    const latest = (metaText.match(/^latest_at:\s*"?([^"\n]+)"?$/m) ?? [])[1] ?? utcStamp();
    const bodySha = (metaText.match(/^body_sha256:\s*"?([^"\n]+)"?$/m) ?? [])[1];

    // Rewrite META with status sealed.
    writeYaml(path.join(adir, "META.yaml"), {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "leaf",
      depth: 0,
      status: "sealed",
      participants,
      earliest_at: earliest,
      latest_at: latest,
      body_sha256: bodySha,
      keywords,
      tldr,
      committed_at: utcStamp(),
    });

    // Strip lingering HTML comments from SUMMARY.md (clean public form).
    const cleanSummary = summary.replace(/<!--[\s\S]*?-->\s*\n?/g, "");
    fs.writeFileSync(summaryPath, cleanSummary);

    const entry: IndexEntry = {
      id: aid,
      edge_id: edge.id,
      topology: topo.topology,
      kind: "leaf",
      depth: 0,
      earliest_at: earliest,
      latest_at: latest,
      participants,
      parents: [],
      descendant_count: 0,
      keywords,
      tldr,
      body_sha256: bodySha,
      path: adir,
    };
    appendIndexEntry(edge.dir, entry);

    console.log(`committed ${aid} into ${edge.id} index`);
    console.log(`  keywords: ${keywords.join(", ")}`);
    console.log(`  TL;DR:    ${tldr.slice(0, 120)}${tldr.length > 120 ? "…" : ""}`);
    break;
  }

  case "list": {
    const idx = readIndex(edge.dir);
    if (!idx.length) { console.log(`no archives for ${edge.id}`); break; }
    for (const e of idx) {
      console.log(`${e.id}  d${e.depth} ${e.kind.padEnd(9)} ${e.earliest_at} → ${e.latest_at}`);
      if (e.tldr) console.log(`    ${e.tldr}`);
      if (e.keywords.length) console.log(`    keywords: ${e.keywords.join(", ")}`);
    }
    const pending = pendingArchives();
    if (pending.length) console.log(`\npending (uncommitted): ${pending.join(", ")}`);
    break;
  }

  default:
    die(`unknown op: ${op}`);
}
