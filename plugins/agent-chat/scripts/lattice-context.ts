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
import { truncateToUtf8Bytes, utf8ByteLength } from "./utf8.ts";

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
  /** Minimum cosine similarity for a hit to be included. Default
   *  undefined (no filter — all top-K hits emitted regardless of
   *  cosine). NL15 / carina LC1 fix: pass e.g. 0.4 to filter out
   *  sparse-corpus pollution where pushContext returns top-K even
   *  for low-similarity hits. iter-4 documented the production-
   *  corpus baseline at cosines 0.21-0.31; 0.4 is the substrate-
   *  readiness threshold. */
  min_cosine?: number;
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
    // LC2 fix (NL19 / carina NL12 finding): pass exclude_agent into
    // pushContext directly. Pre-fix this module over-fetched k+5
    // candidates and applied the exclude_agent filter in memory; that
    // buffer exhausted and dropped eligible peer hits when the calling
    // agent dominated the top of the cosine ranking. Now pushContext
    // walks the ranked list, skipping ineligible hits, and returns up
    // to k eligible peer hits regardless of how many of the top-K
    // candidates are by the calling agent.
    const hits = await pushContext(store, opts.query, {
      k,
      answered_only: true,
      quality_tier_min: opts.quality_tier_min,
      exclude_agent: opts.exclude_agent,
    });

    let kept = hits;
    // LC1 fix (NL15 / carina NL12 finding): apply min_cosine floor
    // BEFORE the top-K slice. pushContext returns top-K hits regardless
    // of cosine — without a floor, sparse-corpus content (cosines 0.2-0.3)
    // pollutes pushed prompts with barely-relevant priors. Filter only
    // if min_cosine is explicitly provided; default behavior unchanged
    // for backwards compat.
    if (opts.min_cosine !== undefined) {
      kept = kept.filter((h) => h.cosine >= opts.min_cosine!);
    }
    // LC3 fix (NL27 / carina NL12 finding): drop hits whose best_answer
    // is null BEFORE counting. pushContext can return null-best_answer
    // hits in its default branch (no exclude_agent) when filters reject
    // every accepted answer for a question — the for-loop below already
    // skips those in OUTPUT, but the header line (`top-${kept.length}`)
    // and the i+1 numbering would otherwise lie about the actual content
    // emitted. NL19's LC2 fix already handles the exclude_agent-set
    // branch in pushContext itself; LC3 covers the unset branch here at
    // the consumer.
    kept = kept.filter((h) => h.best_answer !== null);
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

/** LC4 fix (NL23 / carina NL12 finding): truncate by UTF-8 BYTES, not by
 *  UTF-16 code units. The previous implementation used `t.length` and
 *  `t.slice(...)` — both of which operate on UTF-16 code units. See
 *  utf8.ts for the underlying primitive and the full bug context.
 *
 *  This wrapper composes utf8.ts's `truncateToUtf8Bytes` with the
 *  budget≤0 → "" rule and a 3-byte ellipsis suffix when the budget has
 *  room for it (the ellipsis "…" / U+2026 is 3 UTF-8 bytes; budgets
 *  below 3 truncate without a marker rather than overshooting). */
export function truncateForBudget(s: string, budget: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (budget <= 0) return "";
  if (utf8ByteLength(t) <= budget) return t;
  const ELLIPSIS_BYTES = 3;  // "…" (U+2026) = E2 80 A6 in UTF-8
  if (budget < ELLIPSIS_BYTES) {
    return truncateToUtf8Bytes(t, budget);
  }
  return truncateToUtf8Bytes(t, budget - ELLIPSIS_BYTES).trimEnd() + "…";
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
