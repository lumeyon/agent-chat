// scripts/large-files.ts — large-block extraction for archive bodies.
//
// Round 12 slice 2 (lossless-claw backport, simplified). When sealing a
// BODY.md, sections that exceed ~25,000 tokens (text.length / 4 estimate;
// the project-wide token convention) get pulled out of the body and
// stored separately at <edge.dir>/archives/large-files/<sha256>.txt.
// The body retains a placeholder that records the full content's
// location, byte count, line count, plus the FIRST 80 + LAST 20 lines
// inline so cheap re-reads (search.ts grep, doctor) still see the
// flavor of the content without paying the full re-read cost.
//
// Placeholder shape:
//   <file ref="large-file:<sha>.txt" bytes="<n>" lines="<n>">
//   ... first 80 lines ...
//   ... [truncated, see large-files/<sha>.txt for full content] ...
//   ... last 20 lines ...
//   </file>
//
// search.ts expand --inline-large-files reassembles by reading the
// referenced file and substituting back. Adapted from
// /data/eyon/git/lossless-claw/src/large-files.ts; we EMIT placeholders
// (not parse them from inputs), so the helper is a one-way transform
// on raw section text.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const LARGE_BLOCK_TOKEN_THRESHOLD = 25_000;
// text.length / 4 token heuristic (project-wide convention).
export const LARGE_BLOCK_BYTE_THRESHOLD = LARGE_BLOCK_TOKEN_THRESHOLD * 4;

const HEAD_LINES = 80;
const TAIL_LINES = 20;

export type ExtractionResult = {
  // The transformed body. May be identical to input if no blocks needed
  // extraction. Idempotent on already-transformed bodies (placeholder
  // detection prevents re-extraction).
  body: string;
  // Number of large blocks that were pulled out.
  extracted: number;
  // Paths of the large-file companion files written.
  paths: string[];
};

export function largeFilesDir(edgeDir: string): string {
  return path.join(edgeDir, "archives", "large-files");
}

// extractLargeBlocks: walks a markdown body, identifies sections (split
// by `^---$` separators per the existing CONVO format), and for any
// section whose byte count exceeds LARGE_BLOCK_BYTE_THRESHOLD, replaces
// the section content with a `<file>` placeholder + writes the full
// content to a sha256-named companion file.
//
// Sections that already contain a `<file ref="large-file:..."` placeholder
// are passed through unchanged (extraction is idempotent).
export function extractLargeBlocks(body: string, edgeDir: string): ExtractionResult {
  const sections = splitSections(body);
  const outParts: string[] = [];
  const paths: string[] = [];
  let extracted = 0;

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const isSeparator = sec === "---";
    if (isSeparator) {
      outParts.push(sec);
      continue;
    }
    if (sec.length <= LARGE_BLOCK_BYTE_THRESHOLD) {
      outParts.push(sec);
      continue;
    }
    if (/<file\s+ref="large-file:/.test(sec)) {
      // Already extracted; idempotent pass-through.
      outParts.push(sec);
      continue;
    }
    const { placeholder, companionPath } = extractOne(sec, edgeDir);
    outParts.push(placeholder);
    paths.push(companionPath);
    extracted++;
  }

  // Re-stitch with the same `\n---\n` separators that splitSections
  // peeled off. splitSections preserves the separator tokens as their own
  // elements, so a simple join with "\n" is faithful.
  return { body: outParts.join("\n"), extracted, paths };
}

function splitSections(body: string): string[] {
  // Split on standalone "---" lines (markdown horizontal rule separator
  // used by agent-chat's section format). Preserve the separators as
  // their own array elements so downstream re-stitching keeps the body
  // byte-identical for non-extracted sections.
  const lines = body.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "---") {
      if (current.length) out.push(current.join("\n"));
      out.push("---");
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

function extractOne(sectionText: string, edgeDir: string): {
  placeholder: string;
  companionPath: string;
} {
  const sha = crypto.createHash("sha256").update(sectionText, "utf8").digest("hex");
  const dir = largeFilesDir(edgeDir);
  fs.mkdirSync(dir, { recursive: true });
  const companionPath = path.join(dir, `${sha}.txt`);
  // Idempotent write: if a previous seal already extracted this exact
  // content, the companion file already exists and we don't need to rewrite.
  if (!fs.existsSync(companionPath)) {
    fs.writeFileSync(companionPath, sectionText);
  }

  const lines = sectionText.split("\n");
  const totalBytes = Buffer.byteLength(sectionText, "utf8");
  const totalLines = lines.length;

  let inline: string;
  if (totalLines <= HEAD_LINES + TAIL_LINES + 1) {
    // Section is byte-large but line-small (e.g., one giant line). Keep it
    // inline as-is — head+tail truncation has no value.
    inline = sectionText;
  } else {
    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = lines.slice(-TAIL_LINES).join("\n");
    inline = head +
      `\n\n... [truncated, see large-files/${sha}.txt for full content] ...\n\n` +
      tail;
  }

  const placeholder =
    `<file ref="large-file:${sha}.txt" bytes="${totalBytes}" lines="${totalLines}">\n` +
    inline +
    `\n</file>`;

  return { placeholder, companionPath };
}

// inlineLargeFiles: reverse transform used by search.ts expand
// --inline-large-files. Walks the body, finds `<file ref="large-file:...">`
// blocks, replaces them with the companion content. Missing companion files
// are passed through with an obvious "[MISSING: <ref>]" marker so the
// failure is visible rather than silent.
export function inlineLargeFiles(body: string, edgeDir: string): string {
  const re = /<file\s+ref="large-file:([a-f0-9]+\.txt)"[^>]*>[\s\S]*?<\/file>/g;
  return body.replace(re, (_match, refName: string) => {
    const companionPath = path.join(largeFilesDir(edgeDir), refName);
    if (!fs.existsSync(companionPath)) {
      return `[MISSING large-file: ${refName} not found in ${largeFilesDir(edgeDir)}]`;
    }
    try {
      return fs.readFileSync(companionPath, "utf8");
    } catch (e: any) {
      return `[ERROR reading large-file: ${refName}: ${e.message}]`;
    }
  });
}
