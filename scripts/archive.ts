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
  buildSummaryPrompt, injectKeywordsIfMissing,
  type IndexEntry,
} from "./lib.ts";
import { runClaude, isLlmEnabled } from "./llm.ts";

const DEFAULT_FRESH_TAIL = 4;

function die(msg: string): never { console.error(msg); process.exit(2); }

function parseArgs(argv: string[]) {
  const [op, peer, ...rest] = argv;
  const opts: {
    freshTail: number;
    force: boolean;
    archiveId: string | null;
    noLlm: boolean;
    llm: boolean;
  } = {
    freshTail: DEFAULT_FRESH_TAIL, force: false, archiveId: null, noLlm: false, llm: false,
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--fresh-tail") opts.freshTail = parseInt(rest[++i] ?? "", 10);
    else if (rest[i] === "--force") opts.force = true;
    else if (rest[i] === "--no-llm") opts.noLlm = true;
    else if (rest[i] === "--llm") opts.llm = true;
    else if (!opts.archiveId && rest[i].startsWith("arch_")) opts.archiveId = rest[i];
  }
  if (!Number.isFinite(opts.freshTail) || opts.freshTail < 0) die("--fresh-tail must be >= 0");
  if (opts.llm && opts.noLlm) {
    die("--llm and --no-llm cannot be combined (configuration error). Pick one.");
  }
  return { op, peer, opts };
}

// Round 12: timestamp-injected source body. Each section gets `[<UTC ts>]`
// prepended so the LLM (or synthesizer) sees temporal context. Sections
// without a parseable timestamp fall back to `[unknown]`. The bare body
// (without timestamps) was the original input shape; this is the wrapping.
function bodyWithTimestamps(rawBody: string): string {
  const { sections } = parseSections(rawBody);
  if (sections.length === 0) return rawBody;
  return sections.map((s) => {
    const meta = sectionMeta(s);
    const tag = meta.ts ? `[${meta.ts}]` : "[unknown]";
    return `${tag}\n${s}`;
  }).join("\n\n");
}

// Round 12: try the LLM path first; fall back to the deterministic synthesizer
// on any failure (probe-fail, timeout, non-zero exit, validator-fail). Returns
// the SUMMARY.md text + a `source` discriminator for the META.yaml `synthesis`
// field. NEVER throws — auto must never block exit.
type SynthesizeResult = { summary: string; source: "llm" | "synth"; reason: string };

async function tryLlmThenSynth(args: {
  edgeId: string;
  archiveId: string;
  participants: [string, string];
  earliestAt: string;
  latestAt: string;
  archivedSections: string[];
  rawBody: string;
  llmEnabled: boolean;
}): Promise<SynthesizeResult> {
  const { edgeId, archiveId, participants, earliestAt, latestAt, archivedSections, rawBody, llmEnabled } = args;
  const synthFallback = (): SynthesizeResult => {
    const summary = synthesizeAutoSummary({
      edgeId, archiveId, participants, earliestAt, latestAt, sections: archivedSections,
    });
    return { summary, source: "synth", reason: "synthesizer" };
  };
  if (!llmEnabled) return synthFallback();
  // Strictly sequential per cadence: LLM → validator → either use it or synth.
  // Never parallel (round-9 first-hit-wins corruption surface).
  const prompt = buildSummaryPrompt({
    edgeId, archiveId, kind: "leaf", depth: 0, participants, earliestAt, latestAt,
    sourceLabel: `${archivedSections.length} raw section(s) from CONVO.md (timestamps injected)`,
    sourceText: bodyWithTimestamps(rawBody),
  });
  let result;
  try {
    result = await runClaude({ prompt });
  } catch (err: any) {
    console.error(`[agent-chat] LLM call threw unexpectedly: ${err?.message ?? err}; falling back to synthesizer.`);
    return synthFallback();
  }
  if (result.reason !== "ok" || !result.stdout) {
    console.error(`[agent-chat] LLM ${result.reason} (${result.code ?? "no-code"}); falling back to synthesizer.`);
    return synthFallback();
  }
  // Apply keyword backfill BEFORE validator so a missing/short Keywords
  // section doesn't immediately fall back to synth.
  const llmSummary = injectKeywordsIfMissing(result.stdout);
  const v = validateSummary(llmSummary);
  if (!v.ok) {
    console.error(`[agent-chat] LLM output failed validator (${v.issues.length} issue${v.issues.length === 1 ? "" : "s"}); falling back to synthesizer.`);
    for (const issue of v.issues.slice(0, 3)) console.error(`  - ${issue}`);
    return synthFallback();
  }
  return { summary: llmSummary, source: "llm", reason: "llm" };
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
      const body = split.archivable;
      const aid = archiveId("leaf", tr.latest, body);

      // Round 12 slice 2: idempotency guard. If a re-seal of the SAME body
      // lands (same content → same content-addressed aid), branch to no-op.
      // Without this, content-addressed re-seal would EEXIST on dir create
      // or duplicate the index entry. Old random-tail archives never match
      // (their tails are random); backward compat is free. Lyra Phase-1.
      {
        const existing = readIndex(edge.dir).find((e) => e.id === aid);
        if (existing) {
          console.error(`already sealed as ${aid}; no-op`);
          process.exit(0);
        }
      }

      const adir = leafArchiveDir(edge.dir, aid);
      fs.mkdirSync(adir, { recursive: true });

      // Write BODY.md verbatim (the sealed source of truth). fsync before
      // the destructive CONVO.md truncation so a power loss between the
      // BODY write and the truncation cannot lose the archive content.
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
      const body = split.archivable;
      const aid = archiveId("leaf", tr.latest, body);

      // Round 12 slice 2: idempotency guard (auto path). Same shape as the
      // manual seal site — content-addressed re-auto on identical body
      // returns no-op rather than EEXIST'ing or duplicating the index.
      {
        const existing = readIndex(edge.dir).find((e) => e.id === aid);
        if (existing) {
          console.error(`already sealed as ${aid}; no-op`);
          process.exit(0);
        }
      }

      const adir = leafArchiveDir(edge.dir, aid);
      fs.mkdirSync(adir, { recursive: true });

      // BODY.md — verbatim, fsync'd before any destructive op.
      const bodyPath = path.join(adir, "BODY.md");
      const bfd = fs.openSync(bodyPath, "w");
      try { fs.writeFileSync(bfd, body); fs.fsyncSync(bfd); }
      finally { fs.closeSync(bfd); }

      // Round 12: try the LLM path first; fall back to deterministic
      // synthesizer on any failure (probe-fail, timeout, non-zero exit,
      // validator-fail). Strictly sequential per cadence (NEVER parallel —
      // round-9 first-hit-wins corruption surface). The synthesizer fallback
      // is validator-passing by construction (real-body sections + ≥3
      // keywords + non-placeholder Expand-for-details).
      const llmCheck = isLlmEnabled({ noLlmFlag: opts.noLlm, llmFlag: opts.llm });
      const synthesisResult = await tryLlmThenSynth({
        edgeId: edge.id,
        archiveId: aid,
        participants,
        earliestAt: tr.earliest,
        latestAt: tr.latest,
        archivedSections,
        rawBody: body,
        llmEnabled: llmCheck.enabled,
      });
      const summary = synthesisResult.summary;
      const v = validateSummary(summary);
      if (!v.ok) {
        // Both LLM and synth failed — surface loud and bail before touching
        // CONVO.md so the edge isn't mid-state. Synth shouldn't fail validation
        // (it's validator-passing by construction); if it does, that's a
        // synthesis bug worth surfacing, not a fallback case.
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
        synthesis: synthesisResult.source === "llm" ? "llm" : "auto",
      });

      // Truncate CONVO.md to header + breadcrumb + fresh tail (atomic).
      const breadcrumb = `\n<!-- archive breadcrumb: ${aid} sealed (auto) at ${utcStamp()} (${archivedSections.length} sections, ${tr.earliest} → ${tr.latest}) — see archives/leaf/${aid}/ -->\n\n`;
      const newConvo = split.header.replace(/\n+$/, "\n") + breadcrumb + (split.freshTail ? `---\n\n${split.freshTail}` : "");
      writeFileAtomic(edge.convo, newConvo, { fsync: true });

      // Index entry — fsync'd so the validated archive is durable.
      // Round 12 feature 12 (keystone): descendant_token_count for leaves
      // is text.length / 4 of BODY.md content (rhino-confirmed convention).
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
        descendant_token_count: Math.ceil(body.length / 4),
        keywords,
        tldr,
        body_sha256: bodySha,
        path: adir,
      };
      appendIndexEntry(edge.dir, entry, { fsync: true });

      // Round 12 slice 2: FTS5 upsert alongside the index. Try/catch so a
      // FTS write failure does not block the index commit (filesystem
      // authoritative; FTS derived). Errors flow to <edge>/.fts-corrupt.
      try {
        const { upsertEntry } = await import("./fts.ts");
        const { extractExpandTopics, extractSummaryBody } = await import("./lib.ts");
        await upsertEntry(edge.dir, entry, {
          tldr,
          summary_body: extractSummaryBody(summary),
          keywords: keywords.join(" "),
          expand_topics: extractExpandTopics(summary),
        });
      } catch (err: any) {
        console.error(`[archive auto] FTS upsert failed (non-blocking): ${err?.message ?? err}`);
      }

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

    // Re-read BODY.md to compute descendant_token_count (Round 12 feature 12).
    // BODY.md was written earlier in seal; we need its size now for the
    // text.length / 4 heuristic.
    const bodyPath = path.join(adir, "BODY.md");
    const bodyTokens = fs.existsSync(bodyPath)
      ? Math.ceil(fs.statSync(bodyPath).size / 4)
      : 0;
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
      descendant_token_count: bodyTokens,
      keywords,
      tldr,
      body_sha256: bodySha,
      path: adir,
    };
    // fsync the index append so the just-validated archive is durable on
    // disk before we return success to the caller.
    appendIndexEntry(edge.dir, entry, { fsync: true });

    // Round 12 slice 2: FTS5 upsert alongside the index. Non-blocking;
    // see auto-archive site comment.
    try {
      const { upsertEntry } = await import("./fts.ts");
      const { extractExpandTopics, extractSummaryBody } = await import("./lib.ts");
      await upsertEntry(edge.dir, entry, {
        tldr,
        summary_body: extractSummaryBody(cleanSummary),
        keywords: keywords.join(" "),
        expand_topics: extractExpandTopics(cleanSummary),
      });
    } catch (err: any) {
      console.error(`[archive commit] FTS upsert failed (non-blocking): ${err?.message ?? err}`);
    }

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
    // Round 12 slice 2: 8-point integrity check suite (lossless-claw
    // backport, expanded from the prior 4-check drift loop). Reports
    // pass|warn|fail per check; doctor exits non-zero only on fail-level
    // findings. Adapted from /data/eyon/git/lossless-claw/src/integrity.ts.
    //
    // Plus a 9th check `orphan_body_without_meta` (orion Phase-2
    // cross-slice resolution) covering carina's lock-strategy-(b)
    // intermediate state where BODY.md exists but META.yaml has not been
    // written yet — invisible to all read paths but worth surfacing as
    // a gc hint.
    //
    // New flag: --rebuild-fts invokes fts.rebuildFromIndex(edge.dir) to
    // rebuild the FTS5 index from index.jsonl + per-archive SUMMARY.md.
    // Recovery primitive for SQLITE_CORRUPT or any drift between fts.db
    // and index.jsonl.
    if (process.argv.includes("--rebuild-fts")) {
      const fts = await import("./fts.ts");
      const lib = await import("./lib.ts");
      const { rebuilt, skipped } = await fts.rebuildFromIndex(edge.dir, (entry) => {
        const sp = path.join(entry.path, "SUMMARY.md");
        if (!fs.existsSync(sp)) return null;
        const txt = fs.readFileSync(sp, "utf8");
        return {
          tldr: lib.extractTldr(txt),
          summary_body: lib.extractSummaryBody(txt),
          keywords: lib.extractKeywords(txt).join(" "),
          expand_topics: lib.extractExpandTopics(txt),
        };
      });
      console.log(`rebuilt fts.db for ${edge.id}: ${rebuilt} entries indexed, ${skipped} skipped (no SUMMARY.md)`);
      break;
    }

    const idx = readIndex(edge.dir);
    if (!idx.length) { console.log(`no archives for ${edge.id} — clean`); break; }
    const ids = new Set(idx.map((e) => e.id));
    let warns = 0;
    let fails = 0;
    const report = (level: "pass" | "warn" | "fail", check: string, msg: string) => {
      console.log(`${level.padEnd(4)} ${check.padEnd(34)} ${msg}`);
      if (level === "warn") warns++;
      if (level === "fail") fails++;
    };

    // 1. archives_present — every IndexEntry's path exists.
    {
      const missing = idx.filter((e) => !fs.existsSync(e.path));
      if (missing.length === 0) report("pass", "archives_present", `all ${idx.length} archive directories exist`);
      else for (const m of missing) report("fail", "archives_present", `${m.id}: directory missing at ${m.path}`);
    }

    // 2. archive_ordinals_contiguous — index sorted by earliest_at has no
    //    suspicious >7d gaps suggesting an orphaned mid-archive deletion.
    {
      const sorted = [...idx].sort((a, b) => a.earliest_at.localeCompare(b.earliest_at));
      const gaps: string[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = Date.parse(sorted[i - 1].latest_at);
        const next = Date.parse(sorted[i].earliest_at);
        if (Number.isFinite(prev) && Number.isFinite(next) && next - prev > 7 * 24 * 3600 * 1000) {
          gaps.push(`${sorted[i - 1].id} → ${sorted[i].id}: ${Math.round((next - prev) / (24 * 3600 * 1000))}d gap`);
        }
      }
      if (gaps.length === 0) report("pass", "archive_ordinals_contiguous", `no >7d gaps across ${sorted.length} archives`);
      else for (const g of gaps) report("warn", "archive_ordinals_contiguous", g);
    }

    // 3. leaf_body_sha256_matches — per-leaf BODY.md sha check.
    {
      let leafChecked = 0, leafFail = 0;
      for (const e of idx) {
        if (e.kind !== "leaf" || !e.body_sha256) continue;
        leafChecked++;
        const bodyPath = path.join(e.path, "BODY.md");
        if (!fs.existsSync(bodyPath)) {
          report("fail", "leaf_body_sha256_matches", `${e.id}: BODY.md missing`);
          leafFail++;
          continue;
        }
        const actual = sha256(fs.readFileSync(bodyPath, "utf8"));
        if (actual !== e.body_sha256) {
          report("fail", "leaf_body_sha256_matches", `${e.id}: sha mismatch (recorded=${e.body_sha256.slice(0, 16)}..., actual=${actual.slice(0, 16)}...)`);
          leafFail++;
        }
      }
      if (leafFail === 0) report("pass", "leaf_body_sha256_matches", `all ${leafChecked} leaf bodies match`);
    }

    // 4. condensed_lineage — every condensed has non-empty parents AND
    //    every parent ID is in the index.
    {
      let condensedChecked = 0, lineageFail = 0;
      for (const e of idx) {
        if (e.kind !== "condensed") continue;
        condensedChecked++;
        if (!e.parents?.length) {
          report("fail", "condensed_lineage", `${e.id}: no parents (condensed must reference >= 1)`);
          lineageFail++;
          continue;
        }
        for (const p of e.parents) {
          if (!ids.has(p)) {
            report("fail", "condensed_lineage", `${e.id}: parent ${p} not in index`);
            lineageFail++;
          }
        }
      }
      if (lineageFail === 0) report("pass", "condensed_lineage", `all ${condensedChecked} condensed entries have valid lineage`);
    }

    // 5. no_orphan_archives — every leaf is fresh-tail-protected OR
    //    referenced by a condensed parent. WARN level.
    {
      const referencedByCondensed = new Set<string>();
      for (const e of idx) if (e.kind === "condensed") for (const p of e.parents ?? []) referencedByCondensed.add(p);
      const sortedLeaves = idx.filter((e) => e.kind === "leaf")
        .sort((a, b) => b.earliest_at.localeCompare(a.earliest_at));
      const freshTailWindow = new Set(sortedLeaves.slice(0, 4).map((e) => e.id));
      const orphans: string[] = [];
      for (const e of idx) {
        if (e.kind !== "leaf") continue;
        if (freshTailWindow.has(e.id)) continue;
        if (referencedByCondensed.has(e.id)) continue;
        orphans.push(e.id);
      }
      if (orphans.length === 0) report("pass", "no_orphan_archives", `every leaf is fresh-tail-protected or has a condensed parent`);
      else for (const o of orphans) report("warn", "no_orphan_archives", `${o}: leaf with no condensed parent`);
    }

    // 6. descendant_count_consistency — recompute and check drift.
    {
      let condensedChecked = 0, countFail = 0;
      for (const e of idx) {
        if (e.kind !== "condensed") continue;
        condensedChecked++;
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
          report("fail", "descendant_count_consistency", `${e.id}: descendant_count=${e.descendant_count} but reachable=${reachable}`);
          countFail++;
        }
      }
      if (countFail === 0) report("pass", "descendant_count_consistency", `all ${condensedChecked} condensed counts match reachable leaf set`);
    }

    // 7. no_duplicate_ids — catastrophic if true.
    {
      const seen = new Map<string, number>();
      for (const e of idx) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      const dups = [...seen.entries()].filter(([, n]) => n > 1);
      if (dups.length === 0) report("pass", "no_duplicate_ids", `all ${idx.length} ids unique`);
      else for (const [id, n] of dups) report("fail", "no_duplicate_ids", `${id}: appears ${n}× in index.jsonl`);
    }

    // 8. fts_in_sync — every IndexEntry has a row in fts.db. WARN with
    //    --rebuild-fts hint. Skipped silently if fts.db absent.
    {
      const fts = await import("./fts.ts");
      const ftsDbExists = fs.existsSync(fts.ftsDbPath(edge.dir));
      if (!ftsDbExists) {
        report("pass", "fts_in_sync", "fts.db absent (lazy-create); skipping check");
      } else {
        let ftsChecked = 0, ftsMissing = 0;
        for (const e of idx) {
          ftsChecked++;
          if (!fts.hasEntry(edge.dir, e.id)) {
            report("warn", "fts_in_sync", `${e.id}: not in fts.db — run \`bun scripts/archive.ts doctor ${peer} --rebuild-fts\``);
            ftsMissing++;
          }
        }
        if (ftsMissing === 0) report("pass", "fts_in_sync", `all ${ftsChecked} archives indexed in fts.db`);
      }
    }

    // 9. orphan_body_without_meta — carina lock-strategy-(b) intermediate
    //    state. WARN level; gc would reap.
    {
      const leafDir = path.join(archivesRoot(edge.dir), "leaf");
      const orphans: string[] = [];
      if (fs.existsSync(leafDir)) {
        for (const aid of fs.readdirSync(leafDir)) {
          const adir = path.join(leafDir, aid);
          if (!fs.statSync(adir).isDirectory()) continue;
          const bodyExists = fs.existsSync(path.join(adir, "BODY.md"));
          const metaExists = fs.existsSync(path.join(adir, "META.yaml"));
          if (bodyExists && !metaExists) orphans.push(aid);
        }
      }
      if (orphans.length === 0) report("pass", "orphan_body_without_meta", `no BODY.md files without META.yaml`);
      else for (const o of orphans) report("warn", "orphan_body_without_meta", `${o}: BODY.md present, META.yaml missing — run \`gc\` to reap`);
    }

    console.log("");
    console.log(`${edge.id}: ${idx.length} archives, ${warns} warning(s), ${fails} failure(s)`);
    if (fails > 0) process.exit(5);
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
