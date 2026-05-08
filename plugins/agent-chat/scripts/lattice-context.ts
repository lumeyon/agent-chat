// lattice-context.ts — ALT-A-2 — pushContext wired into the agent runtime.
//
// Per the Apprenticeship Substrate's forcing function 4 (cross-domain push),
// every agent action is preceded by automatic retrieval of the top-K most
// relevant prior Q/A from the lattice. The agent doesn't query — the
// substrate pushes context.
//
// This module is the bridge between agent-chat's cmdRun (per-turn dispatcher)
// and the global lattice's pushContext().
//
// Usage:
//   const block = await composePushedContextBlock({
//     query, latticeDbPath, k, exclude_agent: id.name,
//   });
//   prompt = roleBlock + ... + block + ... + tailBlock;
//
// Behavior:
//   - Returns "" if the lattice DB doesn't exist (no error, just no block).
//   - Excludes answers BY the current agent (don't push our own past
//     answers as "prior knowledge" — that's narcissistic and uninformative).
//   - Truncates each pushed answer to a budget so the block doesn't dominate
//     the prompt window.
//   - Wraps in a clearly-delimited markdown block so the agent knows where
//     pushed context ends and the conversation tail begins.

import * as fs from "node:fs";
import { LatticeStore } from "../../../scripts/lattice/sqlite-store.ts";
import { pushContext } from "../../../scripts/lattice/apprenticeship.ts";
import type { QualityTier } from "../../../scripts/lattice/types.ts";

export interface PushContextBlockOptions {
  /** The query string used to retrieve relevant priors. Typically the
   *  most recent peer message body (what THIS agent is about to respond to). */
  query: string;
  /** Path to the global lattice DB (`<conv>/lattice.db`). */
  latticeDbPath: string;
  /** Top-K hits to include. Default 3 — keeps the prompt block bounded. */
  k?: number;
  /** Agent whose own answers should be EXCLUDED. Push priors authored
   *  by OTHER agents only — pushing our own past words back to us is
   *  uninformative. */
  exclude_agent?: string;
  /** Minimum quality tier (1=gold, 5=raw). Default 5 (no filter). */
  quality_tier_min?: QualityTier;
  /** Per-answer body byte budget. Default 600 (~150 tokens). */
  body_budget_bytes?: number;
}

export async function composePushedContextBlock(
  opts: PushContextBlockOptions,
): Promise<string> {
  const k = opts.k ?? 3;
  const bodyBudget = opts.body_budget_bytes ?? 600;

  if (!fs.existsSync(opts.latticeDbPath)) {
    return "";  // no lattice yet; quietly skip
  }
  if (!opts.query || !opts.query.trim()) {
    return "";  // no query → no retrieval
  }

  const store = new LatticeStore(opts.latticeDbPath);
  try {
    const hits = await pushContext(store, opts.query, {
      k: k + (opts.exclude_agent ? 5 : 0),  // over-fetch when filtering
      answered_only: true,
      quality_tier_min: opts.quality_tier_min,
    });

    // Filter out hits whose best_answer is by the excluded agent.
    let kept = hits;
    if (opts.exclude_agent) {
      kept = hits.filter((h) => h.best_answer && h.best_answer.by_agent !== opts.exclude_agent);
    }
    kept = kept.slice(0, k);

    if (kept.length === 0) {
      return "";
    }

    const lines: string[] = [
      `Relevant prior knowledge from the lattice (top-${kept.length} most-similar prior Q/A by embedding cosine):`,
      "",
    ];
    for (let i = 0; i < kept.length; i++) {
      const h = kept[i];
      if (!h.best_answer) continue;
      const framing = truncateForBudget(h.question.framing, 240);
      const answerBody = truncateForBudget(h.best_answer.body, bodyBudget);
      const explanation = h.best_answer.explanation
        ? truncateForBudget(h.best_answer.explanation, 240)
        : "";
      lines.push(
        `${i + 1}. **Q (cosine ${h.cosine.toFixed(2)}, posed_by ${h.question.posed_by}):** ${framing}`,
      );
      lines.push(`   **A (by ${h.best_answer.by_agent}):** ${answerBody}`);
      if (explanation && !explanation.toLowerCase().includes("auto-imported")) {
        lines.push(`   _why:_ ${explanation}`);
      }
      lines.push("");
    }
    lines.push("---", "");
    return lines.join("\n");
  } finally {
    store.close();
  }
}

function truncateForBudget(s: string, budget: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= budget) return t;
  return t.slice(0, budget - 1).trimEnd() + "…";
}

/** Extract the most recent peer (i.e., not-this-agent) section's body
 *  from a CONVO.md sections array. Returns "" if no peer section found.
 *
 *  Used as the query input to composePushedContextBlock — what THIS
 *  agent is about to respond to is the natural retrieval key.
 */
export function extractMostRecentPeerBody(sections: string[], myAgentName: string): string {
  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i];
    const headerLine = sec.split("\n", 1)[0] || "";
    // header: "## <agent> — <topic> (UTC ...)"
    const m = /^## (\S+)\s+—\s+/.exec(headerLine);
    if (!m) continue;
    const author = m[1];
    if (author === myAgentName) continue;
    // Found a peer's section — extract body (lines after header).
    const nl = sec.indexOf("\n");
    let body = nl < 0 ? "" : sec.slice(nl + 1);
    // Strip trailing arrow + separator. NL12 / carina LC5 fix: same
    // bug class as K-imp-2 in import-from-kg.ts — the prior /m flag made
    // `$` match end-of-LINE, stripping internal `→ name` and `---`
    // lines from body content. Without /m, `$` only matches end-of-
    // string, so only the TRUE trailing markers strip (the intent).
    body = body.replace(/\n*→\s*\S+\s*$/, "").replace(/\n*---\s*$/, "").trim();
    return body;
  }
  return "";
}
