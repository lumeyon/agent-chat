#!/usr/bin/env bun
// scripts/scratch-condense.ts — Round-15e scratchpad DAG archival.
//
// The scratchpad (per-agent autobiographical narrative; Round-15d-α) has
// an 8KB cap. As an agent accumulates relationship history, the
// scratchpad grows. When it approaches the cap, the agent (or this
// helper, run periodically) needs to condense older content into
// "scratchpad archives" — preserving the load-bearing facts in a
// shorter form, freeing space for new working memory.
//
// Layout mirrors the CONVO.md archive DAG (Round-12 lossless-claw
// inspired):
//
//   <conversations>/.scratch/<agent>.md             (current scratchpad, ≤8KB)
//   <conversations>/.scratch/<agent>.archives/
//     d0/<arch_S_...>/BODY.md                       (verbatim old scratchpad)
//     d0/<arch_S_...>/SUMMARY.md                    (condensed)
//     d0/<arch_S_...>/META.yaml                     (timestamps, agent name)
//     d1/<arch_C_...>/                              (condensed-of-condensed)
//
// Trigger model (user directive: "agents in charge of their own memory"):
//   - Default: agents themselves emit a <scratch>...</scratch> block in
//     their cmdRun response with the new (condensed) scratchpad content.
//     cmdRun writes that back via writeScratch. The agent has decided
//     what to keep, what to condense, what to drop. No background poll.
//   - This script is the explicit-condense path: `bun scripts/scratch-
//     condense.ts <agent>` runs a one-shot condense on the current
//     scratchpad. Useful for batch maintenance + tests.
//
// Usage:
//   bun scripts/scratch-condense.ts <agent>          condense + archive
//   bun scripts/scratch-condense.ts <agent> --dry    show what would happen
//   bun scripts/scratch-condense.ts <agent> --list   list existing archives

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  CONVERSATIONS_DIR, SCRATCH_DIR, SCRATCHPAD_MAX_BYTES,
  scratchPath, readScratch, writeScratch,
  utcStamp, writeFileAtomic,
} from "./lib.ts";

function die(msg: string): never { console.error(msg); process.exit(2); }

function scratchArchiveDir(agent: string): string {
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(SCRATCH_DIR, `${safe}.archives`);
}

function archiveId(body: string): string {
  // Same shape as archive.ts: kind prefix + content sha256 prefix.
  const sha = crypto.createHash("sha256").update(body).digest("hex").slice(0, 8);
  const ts = utcStamp().replace(/[-:T]/g, "").slice(0, 14);
  return `arch_S_${ts}_${sha}`;
}

function listArchives(agent: string): string[] {
  const dir = path.join(scratchArchiveDir(agent), "d0");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function listCmd(agent: string): void {
  const archs = listArchives(agent);
  if (archs.length === 0) {
    console.log(`no scratchpad archives for ${agent}`);
    return;
  }
  console.log(`${archs.length} scratchpad archive(s) for ${agent}:`);
  for (const a of archs) {
    const meta = path.join(scratchArchiveDir(agent), "d0", a, "META.yaml");
    let line = `  ${a}`;
    if (fs.existsSync(meta)) {
      try {
        const text = fs.readFileSync(meta, "utf8");
        const m = text.match(/created_at:\s*(\S+)/);
        if (m) line += `  created_at=${m[1]}`;
      } catch {}
    }
    console.log(line);
  }
}

function condenseCmd(agent: string, dry: boolean): void {
  const cur = readScratch(agent);
  if (!cur.trim()) {
    console.log(`scratchpad for ${agent} is empty; nothing to condense.`);
    return;
  }
  if (cur.length < SCRATCHPAD_MAX_BYTES * 0.75) {
    console.log(
      `scratchpad for ${agent} is ${cur.length}/${SCRATCHPAD_MAX_BYTES} bytes ` +
      `(${Math.round(cur.length / SCRATCHPAD_MAX_BYTES * 100)}%); below 75% threshold, no condense needed.`,
    );
    return;
  }
  // Heuristic: keep the LAST 25% of content as the new scratchpad
  // (most recent context); archive the older 75% verbatim with a
  // synthesized SUMMARY noting it was an automatic batch-condense.
  // For the agent-managed memory model, the agent itself should
  // emit a smarter <scratch> directive — this is the fallback for
  // unattended cleanup.
  const keep = Math.floor(cur.length * 0.25);
  const archived = cur.slice(0, cur.length - keep);
  const newScratchpad = cur.slice(cur.length - keep);
  const aid = archiveId(archived);
  const adir = path.join(scratchArchiveDir(agent), "d0", aid);

  if (dry) {
    console.log(`[dry-run] would archive ${archived.length} bytes of scratchpad to ${adir}`);
    console.log(`[dry-run] would keep ${newScratchpad.length} bytes in current scratchpad`);
    return;
  }

  fs.mkdirSync(adir, { recursive: true });
  writeFileAtomic(path.join(adir, "BODY.md"), archived, { mode: 0o600 });
  // Minimal SUMMARY — the agent's own <scratch> directive would be
  // higher-fidelity. This is the unattended fallback.
  const summary =
    `# Auto-condensed scratchpad for ${agent}\n\n` +
    `## TL;DR\n${archived.split("\n")[0].trim() || "scratchpad batch-archive"}\n\n` +
    `## Decisions\n(see BODY.md for full content)\n\n` +
    `## Blockers\n(none)\n\n` +
    `## Follow-ups\n(none)\n\n` +
    `## Artifacts referenced\n(scratchpad-archive)\n\n` +
    `## Keywords\nscratchpad, ${agent}, autobiographical, condense\n\n` +
    `## Expand for details about:\n- full scratchpad content from the archived window; expand to BODY.md to recover.\n`;
  writeFileAtomic(path.join(adir, "SUMMARY.md"), summary, { mode: 0o600 });
  const meta =
    `id: "${aid}"\n` +
    `kind: "scratch"\n` +
    `agent: "${agent}"\n` +
    `created_at: "${utcStamp()}"\n` +
    `body_bytes: ${archived.length}\n`;
  writeFileAtomic(path.join(adir, "META.yaml"), meta, { mode: 0o600 });

  // Replace the current scratchpad with the kept tail.
  writeScratch(agent, newScratchpad);

  console.log(`scratchpad for ${agent} condensed:`);
  console.log(`  archive: ${aid}`);
  console.log(`  archived bytes: ${archived.length}`);
  console.log(`  retained bytes: ${newScratchpad.length}`);
  console.log(`  archive dir: ${adir}`);
}

const [agent, ...rest] = process.argv.slice(2);
if (!agent) die("usage: scratch-condense.ts <agent> [--dry|--list]");
if (rest.includes("--list")) {
  listCmd(agent);
} else {
  condenseCmd(agent, rest.includes("--dry"));
}
