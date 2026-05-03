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
  condensedArchiveDir,
  appendIndexEntry, readIndex, writeYaml, sha256, renderSummaryStub,
  synthesizeAutoSummary,
  validateSummary, extractTldr, extractKeywords,
  writeFileAtomic, exclusiveWriteOrFail, lockTag,
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
if (!op || !peer) die("usage: archive.ts <plan|seal|auto|commit|abort|verify|doctor|list> <peer> [args]");

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
    // Acquire the edge lock for the duration of seal. Without this, two
    // concurrent seal calls could both compute the same archivable prefix,
    // both write distinct archive ids, and both truncate CONVO.md — second
    // truncation overwrites the first breadcrumb, orphaning the first
    // archive (keystone bonus #7).
    const lockBody = `${lockTag(id.name)} ${utcStamp()}\n`;
    try { exclusiveWriteOrFail(edge.lock, lockBody); }
    catch (err: any) {
      if (err.code === "EEXIST") {
        die(`edge is locked: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
      }
      throw err;
    }
    try {
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

      // Write BODY.md verbatim (the sealed source of truth). fsync before
      // the destructive CONVO.md truncation so a power loss between the
      // BODY write and the truncation cannot lose the archive content.
      const body = split.archivable;
      const bodyPath = path.join(adir, "BODY.md");
      const bfd = fs.openSync(bodyPath, "w");
      try { fs.writeFileSync(bfd, body); fs.fsyncSync(bfd); }
      finally { fs.closeSync(bfd); }

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

      // Truncate CONVO.md to header + breadcrumb + fresh tail. ATOMIC:
      // write to a tmpfile first then rename. A crash mid-write used to
      // leave CONVO.md half-truncated while BODY.md was already intact
      // (keystone CONVO.md restoration finding).
      const breadcrumb = `\n<!-- archive breadcrumb: ${aid} sealed at ${utcStamp()} (${archivedSections.length} sections, ${tr.earliest} → ${tr.latest}) — see archives/leaf/${aid}/ -->\n\n`;
      const newConvo = split.header.replace(/\n+$/, "\n") + breadcrumb + (split.freshTail ? `---\n\n${split.freshTail}` : "");
      writeFileAtomic(edge.convo, newConvo, { fsync: true });

      console.log(`sealed ${aid}`);
      console.log(`  BODY.md:    ${bodyPath}`);
      console.log(`  SUMMARY.md: ${path.join(adir, "SUMMARY.md")} (stub — fill it in, then run commit)`);
      console.log(`  META.yaml:  ${path.join(adir, "META.yaml")} (status: pending-commit)`);
      console.log("");
      console.log(`Next: edit the SUMMARY.md (fill every TODO, drop the comment blocks), then run:`);
      console.log(`  bun scripts/archive.ts commit ${peer} ${aid}`);
    } finally {
      try { fs.unlinkSync(edge.lock); } catch {}
    }
    break;
  }

  case "auto": {
    // Atomic seal + auto-synthesized SUMMARY + commit, in one CLI call.
    // Used by `agent-chat gc --auto-archive` and by long-running-conversation
    // tests. Quality is shallow (deterministic synthesis from section
    // metadata, not LLM) but the chain is exercised end-to-end:
    // `search.ts grep` finds the archived edge by extracted keywords;
    // `search.ts expand` returns the verbatim BODY.md.
    if (readTurn(edge.turn) !== "parked" && !opts.force) {
      die(`refuse to auto-archive — .turn is "${readTurn(edge.turn)}", not "parked". Park the edge first or pass --force.`);
    }
    const lockBody = `${lockTag(id.name)} ${utcStamp()}\n`;
    try { exclusiveWriteOrFail(edge.lock, lockBody); }
    catch (err: any) {
      if (err.code === "EEXIST") die(`edge is locked: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
      throw err;
    }
    try {
      const pending = pendingArchives();
      if (pending.length && !opts.force) die(`uncommitted archive(s) pending — commit them first or pass --force: ${pending.join(", ")}`);

      const convo = loadConvo();
      const split = splitForArchive(convo, opts.freshTail);
      if (split.archivableSectionCount === 0) die("nothing to archive — fresh tail covers all sections.");

      const archivedSections = parseSections(convo).sections.slice(0, split.archivableSectionCount);
      const tr = timeRangeOf(archivedSections);
      const aid = archiveId("leaf", tr.latest);
      const adir = leafArchiveDir(edge.dir, aid);
      fs.mkdirSync(adir, { recursive: true });

      // BODY.md — verbatim, fsync'd before any destructive op.
      const body = split.archivable;
      const bodyPath = path.join(adir, "BODY.md");
      const bfd = fs.openSync(bodyPath, "w");
      try { fs.writeFileSync(bfd, body); fs.fsyncSync(bfd); }
      finally { fs.closeSync(bfd); }

      // SUMMARY.md — synthesized deterministically from section metadata.
      // Validator-passing by construction (real-body sections + ≥3 keywords +
      // non-placeholder Expand-for-details + no TODO/FIXME/etc tokens).
      const summary = synthesizeAutoSummary({
        edgeId: edge.id,
        archiveId: aid,
        participants,
        earliestAt: tr.earliest,
        latestAt: tr.latest,
        sections: archivedSections,
      });
      const v = validateSummary(summary);
      if (!v.ok) {
        // Synthesis bug — should never trigger; surface loud and bail before
        // touching CONVO.md so the edge isn't mid-state.
        try { fs.rmSync(adir, { recursive: true, force: true }); } catch {}
        console.error(`auto-summary failed validation (synthesis bug):`);
        for (const issue of v.issues) console.error(`  - ${issue}`);
        process.exit(3);
      }
      fs.writeFileSync(path.join(adir, "SUMMARY.md"), summary);

      const tldr = extractTldr(summary);
      const keywords = extractKeywords(summary);
      const bodySha = sha256(body);

      // META.yaml — sealed (skip the pending-commit dance since validation
      // already passed).
      writeYaml(path.join(adir, "META.yaml"), {
        id: aid,
        edge_id: edge.id,
        topology: topo.topology,
        kind: "leaf",
        depth: 0,
        status: "sealed",
        participants,
        earliest_at: tr.earliest,
        latest_at: tr.latest,
        source_section_count: archivedSections.length,
        body_sha256: bodySha,
        keywords,
        tldr,
        created_at: utcStamp(),
        committed_at: utcStamp(),
        synthesis: "auto",
      });

      // Truncate CONVO.md to header + breadcrumb + fresh tail (atomic).
      const breadcrumb = `\n<!-- archive breadcrumb: ${aid} sealed (auto) at ${utcStamp()} (${archivedSections.length} sections, ${tr.earliest} → ${tr.latest}) — see archives/leaf/${aid}/ -->\n\n`;
      const newConvo = split.header.replace(/\n+$/, "\n") + breadcrumb + (split.freshTail ? `---\n\n${split.freshTail}` : "");
      writeFileAtomic(edge.convo, newConvo, { fsync: true });

      // Index entry — fsync'd so the validated archive is durable.
      const entry: IndexEntry = {
        id: aid,
        edge_id: edge.id,
        topology: topo.topology,
        kind: "leaf",
        depth: 0,
        earliest_at: tr.earliest,
        latest_at: tr.latest,
        participants,
        parents: [],
        descendant_count: 0,
        keywords,
        tldr,
        body_sha256: bodySha,
        path: adir,
      };
      appendIndexEntry(edge.dir, entry, { fsync: true });

      console.log(`auto-archived ${aid}`);
      console.log(`  sections:  ${archivedSections.length}`);
      console.log(`  keywords:  ${keywords.slice(0, 8).join(", ")}${keywords.length > 8 ? ", …" : ""}`);
      console.log(`  TL;DR:     ${tldr.slice(0, 120)}${tldr.length > 120 ? "…" : ""}`);
      console.log(`  BODY.md:   ${bodyPath}`);
    } finally {
      try { fs.unlinkSync(edge.lock); } catch {}
    }
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
    // fsync the index append so the just-validated archive is durable on
    // disk before we return success to the caller.
    appendIndexEntry(edge.dir, entry, { fsync: true });

    console.log(`committed ${aid} into ${edge.id} index`);
    console.log(`  keywords: ${keywords.join(", ")}`);
    console.log(`  TL;DR:    ${tldr.slice(0, 120)}${tldr.length > 120 ? "…" : ""}`);
    break;
  }

  case "abort": {
    // Rollback a pending-commit leaf archive: prepend BODY.md back into
    // CONVO.md (above the breadcrumb), remove the archive directory, and
    // refuse if status is sealed AND any other archive references it as a
    // parent (i.e. condense has folded it). Keystone CONVO.md restoration
    // request — without this, the only way to undo a misplaced seal was a
    // hand-copy of BODY.md.
    const aid = opts.archiveId;
    if (!aid) die("usage: archive.ts abort <peer> <arch_...>");
    const adir = leafArchiveDir(edge.dir, aid);
    if (!fs.existsSync(adir)) die(`no such archive: ${adir}`);
    const metaText = fs.readFileSync(path.join(adir, "META.yaml"), "utf8");
    const status = (metaText.match(/^status:\s*"?([^"\n]+)"?$/m) ?? [])[1] ?? "unknown";
    if (status === "sealed" && !opts.force) {
      // If sealed AND any condensed archive claims this as a parent → refuse
      // hard (cascade abort would invalidate the condensed nodes).
      const idx = readIndex(edge.dir);
      const refsByCondensed = idx.some((e) => e.kind === "condensed" && e.parents.includes(aid));
      if (refsByCondensed) die(`refuse to abort sealed ${aid} — referenced as a parent by a condensed archive. Aborting would orphan it.`);
      // Sealed but unfolded — still safer to require --force.
      die(`refuse to abort — ${aid} is status=sealed (already in index). Pass --force if you really want to revert.`);
    }
    const bodyPath = path.join(adir, "BODY.md");
    if (!fs.existsSync(bodyPath)) die(`no BODY.md to restore at ${bodyPath}`);
    const body = fs.readFileSync(bodyPath, "utf8");
    // Restore: replace the breadcrumb line for THIS aid (if present) with the
    // original body. If no breadcrumb is found (e.g. CONVO.md was rewritten
    // between seal and abort), prepend the body to the existing fresh tail.
    const convo = fs.readFileSync(edge.convo, "utf8");
    const breadcrumbRe = new RegExp(`\\n?<!--\\s+archive breadcrumb:\\s+${aid}[\\s\\S]*?-->\\n*`, "m");
    let restored: string;
    if (breadcrumbRe.test(convo)) {
      restored = convo.replace(breadcrumbRe, "\n" + body);
    } else {
      // No breadcrumb (manual edit?). Insert the body after the header preamble.
      const split = parseSections(convo);
      restored = split.header.replace(/\n+$/, "\n") + "\n" + body + "\n" + split.sections.join("\n\n---\n\n");
    }
    writeFileAtomic(edge.convo, restored, { fsync: true });
    // Remove the index entry if it was committed (with --force).
    const idx = readIndex(edge.dir).filter((e) => e.id !== aid);
    writeFileAtomic(path.join(edge.dir, "index.jsonl"), idx.map((e) => JSON.stringify(e)).join("\n") + (idx.length ? "\n" : ""), { fsync: true });
    fs.rmSync(adir, { recursive: true, force: true });
    console.log(`aborted ${aid}: BODY.md restored to CONVO.md, archive directory removed`);
    break;
  }

  case "verify": {
    // sha256(BODY.md) must equal META.yaml's body_sha256. Cheap integrity
    // check — keystone bonus.
    const aid = opts.archiveId;
    if (!aid) die("usage: archive.ts verify <peer> <arch_...>");
    const adir = leafArchiveDir(edge.dir, aid);
    if (!fs.existsSync(adir)) die(`no such archive: ${adir}`);
    const bodyPath = path.join(adir, "BODY.md");
    const metaText = fs.readFileSync(path.join(adir, "META.yaml"), "utf8");
    const recorded = (metaText.match(/^body_sha256:\s*"?([^"\n]+)"?$/m) ?? [])[1];
    if (!recorded) die(`META.yaml has no body_sha256 — cannot verify`);
    if (!fs.existsSync(bodyPath)) die(`BODY.md is missing at ${bodyPath}`);
    const actual = sha256(fs.readFileSync(bodyPath, "utf8"));
    if (actual !== recorded) {
      console.error(`MISMATCH ${aid}`);
      console.error(`  recorded: ${recorded}`);
      console.error(`  actual:   ${actual}`);
      process.exit(4);
    }
    console.log(`ok ${aid}: sha256 matches (${recorded.slice(0, 16)}...)`);
    break;
  }

  case "doctor": {
    // Drift detection across the edge's index. Reports (does NOT auto-fix):
    //   - paths that don't exist on disk
    //   - parents listed by condensed entries that aren't in the index
    //   - descendant_count that doesn't match the reachable leaf set
    //   - leaf BODY.md whose sha256 doesn't match META.yaml
    // Keystone P1 drift-prevention.
    const idx = readIndex(edge.dir);
    if (!idx.length) { console.log(`no archives for ${edge.id} — clean`); break; }
    const ids = new Set(idx.map((e) => e.id));
    let drift = 0;
    for (const e of idx) {
      if (!fs.existsSync(e.path)) {
        console.log(`drift ${e.id}: archive directory missing at ${e.path}`);
        drift++;
        continue;
      }
      if (e.kind === "condensed") {
        for (const p of e.parents) {
          if (!ids.has(p)) {
            console.log(`drift ${e.id}: condensed parent ${p} not in index`);
            drift++;
          }
        }
        // descendant_count check: walk parents transitively, count leaves.
        const seen = new Set<string>();
        function leafCount(aid: string): number {
          if (seen.has(aid)) return 0;
          seen.add(aid);
          const node = idx.find((x) => x.id === aid);
          if (!node) return 0;
          if (node.kind === "leaf") return 1;
          return node.parents.reduce((acc, p) => acc + leafCount(p), 0);
        }
        const reachable = e.parents.reduce((acc, p) => acc + leafCount(p), 0);
        if (reachable !== e.descendant_count) {
          console.log(`drift ${e.id}: descendant_count=${e.descendant_count} but reachable leaves=${reachable}`);
          drift++;
        }
      }
      if (e.kind === "leaf" && e.body_sha256) {
        const bodyPath = path.join(e.path, "BODY.md");
        if (fs.existsSync(bodyPath)) {
          const actual = sha256(fs.readFileSync(bodyPath, "utf8"));
          if (actual !== e.body_sha256) {
            console.log(`drift ${e.id}: BODY.md sha256 mismatch (recorded=${e.body_sha256.slice(0, 16)}..., actual=${actual.slice(0, 16)}...)`);
            drift++;
          }
        }
      }
    }
    if (drift === 0) console.log(`${edge.id}: ${idx.length} archives, no drift`);
    else { console.log(`${edge.id}: ${drift} drift item(s) reported`); process.exit(5); }
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
