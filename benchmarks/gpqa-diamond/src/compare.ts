#!/usr/bin/env bun
// compare.ts — JOIN three result files (codex, claude, agent-chat) by id
// and emit aggregate accuracy, paired wins, per-domain breakdown, and
// side-by-side diagnostic for agent-chat flips and 3-way disagreements.
//
// Usage:
//   bun compare.ts [--codex PATH] [--claude PATH] [--ac PATH] [--show-flips] [--show-disagreements]
//
// Defaults: results/{codex,claude,agent-chat}.jsonl
//
// Filters: agent-chat rows whose `error` starts with the disk-fill marker
// (`claude draft cli exited 1: Configuration error`) are dropped; the
// JOIN is then restricted to ids present in all three sets so accuracy
// numbers are PAIRED.

import * as fs from "node:fs";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RESULTS_DIR = path.join(HERE, "..", "results");

interface BaselineRow {
  id: string;
  domain: string;
  subdomain?: string;
  answer_extracted: string | null;
  answer_expected: string;
  correct: boolean;
  response?: string;
  error?: string;
}

interface AgentChatRow extends BaselineRow {
  peer?: string;
  claude_draft_letter?: string | null;
  claude_draft_response?: string;
  codex_critique_response?: string;
  claude_revised_response?: string;
}

const DISK_FILL_MARKER = "claude draft cli exited 1: Configuration error";

function loadJsonl<T extends { id: string }>(p: string): Map<string, T> {
  const m = new Map<string, T>();
  if (!fs.existsSync(p)) {
    console.error(`# missing: ${p}`);
    return m;
  }
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as T;
      m.set(r.id, r);
    } catch {
      /* tolerate malformed line */
    }
  }
  return m;
}

function parseArgs(argv: string[]): { codex: string; claude: string; ac: string; showFlips: boolean; showDisagreements: boolean } {
  const out: any = {
    codex: path.join(RESULTS_DIR, "codex.jsonl"),
    claude: path.join(RESULTS_DIR, "claude.jsonl"),
    ac: path.join(RESULTS_DIR, "agent-chat.jsonl"),
    showFlips: false,
    showDisagreements: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--codex") out.codex = argv[++i];
    else if (a === "--claude") out.claude = argv[++i];
    else if (a === "--ac") out.ac = argv[++i];
    else if (a === "--show-flips") out.showFlips = true;
    else if (a === "--show-disagreements") out.showDisagreements = true;
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? "  -" : ((n / d) * 100).toFixed(1) + "%";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const codex = loadJsonl<BaselineRow>(args.codex);
  const claude = loadJsonl<BaselineRow>(args.claude);
  const acAll = loadJsonl<AgentChatRow>(args.ac);

  // Drop disk-fill polluted rows from agent-chat
  const acPolluted = new Set<string>();
  for (const [id, r] of acAll) {
    if (r.error?.startsWith(DISK_FILL_MARKER)) acPolluted.add(id);
  }
  const ac = new Map<string, AgentChatRow>();
  for (const [id, r] of acAll) if (!acPolluted.has(id)) ac.set(id, r);

  // Paired set: ids in all three
  const paired: string[] = [];
  for (const id of ac.keys()) {
    if (codex.has(id) && claude.has(id)) paired.push(id);
  }
  paired.sort();

  console.log(`# files:`);
  console.log(`#   codex:      ${args.codex}  (${codex.size} rows)`);
  console.log(`#   claude:     ${args.claude}  (${claude.size} rows)`);
  console.log(`#   agent-chat: ${args.ac}  (${acAll.size} total, ${acPolluted.size} disk-fill polluted, ${ac.size} valid)`);
  console.log(`# paired (id in all three, ac valid): n=${paired.length}`);
  console.log("");

  // Aggregate accuracy on paired set
  let cxC = 0, clC = 0, acC = 0;
  for (const id of paired) {
    if (codex.get(id)!.correct) cxC++;
    if (claude.get(id)!.correct) clC++;
    if (ac.get(id)!.correct) acC++;
  }
  const n = paired.length;
  console.log(`Accuracy (paired, n=${n}):`);
  console.log(`  codex:      ${cxC}/${n}  (${pct(cxC, n)})`);
  console.log(`  claude:     ${clC}/${n}  (${pct(clC, n)})`);
  console.log(`  agent-chat: ${acC}/${n}  (${pct(acC, n)})`);
  console.log("");

  // Paired wins
  const acFixesClaude: string[] = [];   // ac right, claude wrong
  const acBreaksClaude: string[] = [];  // claude right, ac wrong
  const acFixesCodex: string[] = [];
  const acBreaksCodex: string[] = [];
  for (const id of paired) {
    const aR = ac.get(id)!.correct;
    const clR = claude.get(id)!.correct;
    const cxR = codex.get(id)!.correct;
    if (aR && !clR) acFixesClaude.push(id);
    if (!aR && clR) acBreaksClaude.push(id);
    if (aR && !cxR) acFixesCodex.push(id);
    if (!aR && cxR) acBreaksCodex.push(id);
  }
  console.log(`Paired wins (agent-chat vs single-model):`);
  console.log(`  vs claude: ac fixes ${acFixesClaude.length}, ac breaks ${acBreaksClaude.length}, net ${acFixesClaude.length - acBreaksClaude.length}`);
  console.log(`  vs codex:  ac fixes ${acFixesCodex.length}, ac breaks ${acBreaksCodex.length}, net ${acFixesCodex.length - acBreaksCodex.length}`);
  console.log("");

  // Per-domain breakdown
  type Stats = { codex: [number, number]; claude: [number, number]; ac: [number, number] };
  const byDomain: Record<string, Stats> = {};
  for (const id of paired) {
    const d = ac.get(id)!.domain.split("/")[0] ?? "unknown";
    if (!byDomain[d]) byDomain[d] = { codex: [0, 0], claude: [0, 0], ac: [0, 0] };
    byDomain[d].codex[1]++; byDomain[d].claude[1]++; byDomain[d].ac[1]++;
    if (codex.get(id)!.correct) byDomain[d].codex[0]++;
    if (claude.get(id)!.correct) byDomain[d].claude[0]++;
    if (ac.get(id)!.correct) byDomain[d].ac[0]++;
  }
  console.log(`Per-domain (paired):`);
  console.log(`  ${"domain".padEnd(12)}  ${"codex".padEnd(12)}  ${"claude".padEnd(12)}  ${"agent-chat".padEnd(12)}`);
  for (const [d, s] of Object.entries(byDomain).sort()) {
    const fmt = (p: [number, number]) => `${p[0]}/${p[1]} (${pct(p[0], p[1])})`.padEnd(12);
    console.log(`  ${d.padEnd(12)}  ${fmt(s.codex)}  ${fmt(s.claude)}  ${fmt(s.ac)}`);
  }
  console.log("");

  // Flip ledger (draft -> revised)
  const flipsFix: AgentChatRow[] = [];
  const flipsBreak: AgentChatRow[] = [];
  const flipsNeutral: AgentChatRow[] = [];
  let nonFlips = 0;
  for (const id of paired) {
    const r = ac.get(id)!;
    const draft = r.claude_draft_letter ?? null;
    const final = r.answer_extracted;
    const expected = r.answer_expected;
    if (draft && final && draft !== final) {
      const draftR = draft === expected;
      const finalR = final === expected;
      if (!draftR && finalR) flipsFix.push(r);
      else if (draftR && !finalR) flipsBreak.push(r);
      else flipsNeutral.push(r);
    } else nonFlips++;
  }
  console.log(`Flip ledger (draft -> revised):`);
  console.log(`  flips total: ${flipsFix.length + flipsBreak.length + flipsNeutral.length}  (no-change: ${nonFlips})`);
  console.log(`    fix     (wrong→right): ${flipsFix.length}`);
  console.log(`    break   (right→wrong): ${flipsBreak.length}`);
  console.log(`    neutral (wrong→wrong): ${flipsNeutral.length}`);
  console.log(`    net flip effect: ${flipsFix.length - flipsBreak.length}`);
  console.log("");

  // Optional: print flip details
  if (args.showFlips) {
    const fmtRow = (label: string, r: AgentChatRow) => {
      console.log(`  --- ${label}: ${r.id} ${r.domain}/${r.subdomain ?? ""} (peer=${r.peer}) ---`);
      console.log(`      draft=${r.claude_draft_letter} → revised=${r.answer_extracted} (expected=${r.answer_expected})`);
      console.log(`      critique excerpt: ${(r.codex_critique_response ?? "").replace(/\n/g, " ").slice(0, 280)}`);
    };
    console.log(`# Flip details (--show-flips):`);
    for (const r of flipsFix) fmtRow("FIX", r);
    for (const r of flipsBreak) fmtRow("BREAK", r);
    for (const r of flipsNeutral) fmtRow("NEUTRAL", r);
    console.log("");
  }

  // Optional: print 3-way disagreements (each model picked a different letter, or any not-3-agree)
  if (args.showDisagreements) {
    const disagreements: string[] = [];
    for (const id of paired) {
      const cx = codex.get(id)!.answer_extracted;
      const cl = claude.get(id)!.answer_extracted;
      const a = ac.get(id)!.answer_extracted;
      if (cx !== cl || cl !== a) disagreements.push(id);
    }
    console.log(`# 3-way disagreement cases (--show-disagreements): ${disagreements.length}`);
    for (const id of disagreements) {
      const r = ac.get(id)!;
      const cxRow = codex.get(id)!;
      const clRow = claude.get(id)!;
      console.log(`  ${id}  ${r.domain}/${r.subdomain ?? ""}  expected=${r.answer_expected}`);
      console.log(`    codex=${cxRow.answer_extracted}${cxRow.correct ? "✓" : "✗"}  claude=${clRow.answer_extracted}${clRow.correct ? "✓" : "✗"}  agent-chat=${r.answer_extracted}${r.correct ? "✓" : "✗"}  (peer=${r.peer})`);
    }
  }
}

main();
