// expansion-policy.ts — deterministic route-vs-delegate decision matrix for
// `search.ts expand`. Adapted from lossless-claw's `expansion-policy.ts`
// (general-purpose helpers verbatim: estimateExpansionTokens,
// classifyExpansionTokenRisk, normalizeDepth, normalizeTokenCap) with
// agent-chat-specific regex extensions for our vocabulary (rounds, phases,
// audit, decisions, chains).
//
// The decision matrix has three outcomes:
//   - answer_directly:    skip expansion (no candidates, or low-complexity probe)
//   - expand_shallow:     read candidates' SUMMARY.md inline (default path)
//   - delegate_traversal: shell out to a sub-agent (search.ts expand --delegate)
//
// Round 12 P0 finding (rhino): the verbatim lossless-claw regexes match 0/5
// of agent-chat's example "should-delegate" queries because lossless-claw
// was tuned for general LCM vocabulary (months/quarters/years/timeline).
// Agent-chat speaks "rounds, phases, audits, decisions, chains-of-X." The
// targeted additions below catch our vocabulary without false-positives on
// single-hop or id-direct queries.
//
// "Learning from past expansions" deliberately deferred (orion's spec); this
// is pure deterministic regex routing. If the regex misses fire in
// production, log them and tune; do not bolt on a feedback loop yet.

export type ExpansionRoutingIntent = "query_probe" | "explicit_expand";

export type ExpansionRoutingAction =
  | "answer_directly"
  | "expand_shallow"
  | "delegate_traversal";

export type ExpansionTokenRiskLevel = "low" | "moderate" | "high";

export type ExpansionRoutingInput = {
  intent: ExpansionRoutingIntent;
  query?: string;
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
  tokenCap: number;
  includeMessages?: boolean;
};

export type ExpansionRoutingDecision = {
  action: ExpansionRoutingAction;
  normalizedMaxDepth: number;
  candidateSummaryCount: number;
  estimatedTokens: number;
  tokenCap: number;
  tokenRiskRatio: number;
  tokenRiskLevel: ExpansionTokenRiskLevel;
  indicators: {
    broadTimeRange: boolean;
    multiHopRetrieval: boolean;
  };
  triggers: {
    directByNoCandidates: boolean;
    directByEmptyQuery: boolean;
    directByLowComplexityProbe: boolean;
    delegateByTokenRisk: boolean;
    delegateByBroadTimeRangeAndMultiHop: boolean;
  };
  reasons: string[];
};

// Threshold tuning notes (Round 12 Phase-2):
//   - directMaxCandidates: 2 (rhino tuned, was 1 in lossless-claw). At our
//     archive sizes (5-30/edge), 2 is the right trade-off — 1-2 summaries
//     fit comfortably in main context (~440-880 tokens), 3+ pushes toward
//     delegation territory anyway. Revisit at >50 archives/edge.
//   - All other thresholds carried verbatim from lossless-claw.
export const EXPANSION_ROUTING_THRESHOLDS = {
  defaultDepth: 3,
  minDepth: 1,
  maxDepth: 10,
  directMaxDepth: 2,
  directMaxCandidates: 2,
  moderateTokenRiskRatio: 0.35,
  highTokenRiskRatio: 0.7,
  baseTokensPerSummary: 220,
  includeMessagesTokenMultiplier: 1.9,
  perDepthTokenGrowth: 0.65,
  broadTimeRangeTokenMultiplier: 1.35,
  multiHopTokenMultiplier: 1.25,
  multiHopDepthThreshold: 3,
  multiHopCandidateThreshold: 5,
} as const;

// Lossless-claw originals (kept verbatim) + agent-chat additions for our
// vocabulary. Without the additions, queries like "across the last three
// rounds" wrongly route to answer_directly. See rhino's Phase-1 audit.
const BROAD_TIME_RANGE_PATTERNS: RegExp[] = [
  // lossless-claw originals
  /\b(last|past)\s+(month|months|quarter|quarters|year|years)\b/i,
  /\b(over|across|throughout)\s+(time|months|quarters|years)\b/i,
  /\b(timeline|chronology|history|long[-\s]?term)\b/i,
  /\bbetween\s+[^.]{0,40}\s+and\s+[^.]{0,40}\b/i,
  // agent-chat additions: rounds/phases/sprints/sessions vocabulary.
  // Tolerant of one or two words between the modifier and the noun
  // ("last three rounds", "across the last few phases") via a non-greedy
  // `(\w+\s+){0,2}?` interstitial — keeps the match scoped (won't drift
  // across a clause boundary) but covers the common count-words we miss
  // with a strict digits-only pattern.
  /\b(last|past|prior|previous)\s+(\w+\s+){0,2}?(rounds?|phases?|sprints?|sessions?)\b/i,
  /\b(across|over|throughout|spanning)\s+((all|the|every|each)\s+)?(\w+\s+){0,2}?(rounds?|phases?|sprints?|sessions?)\b/i,
];

const MULTI_HOP_QUERY_PATTERNS: RegExp[] = [
  // lossless-claw originals
  /\b(root\s+cause|causal\s+chain|chain\s+of\s+events)\b/i,
  /\b(multi[-\s]?hop|multi[-\s]?step|cross[-\s]?summary)\b/i,
  /\bhow\s+did\b.+\blead\s+to\b/i,
  // agent-chat additions: chain-of-decisions/audits/reviews vocabulary
  /\b(chain|trail|sequence)\s+of\s+(decisions?|fixes?|edits?|reviews?|audits?|events?|changes?)\b/i,
  /\b(audit|review)\s+(trail|across|over|spanning|history)\b/i,
  /\bwhat\s+did\b.+\b(audit|review|round|phase|session)\s+(decide|conclude|find|determine|recommend)\b/i,
];

function normalizeDepth(requestedMaxDepth?: number): number {
  if (typeof requestedMaxDepth !== "number" || !Number.isFinite(requestedMaxDepth)) {
    return EXPANSION_ROUTING_THRESHOLDS.defaultDepth;
  }
  const rounded = Math.trunc(requestedMaxDepth);
  return Math.max(
    EXPANSION_ROUTING_THRESHOLDS.minDepth,
    Math.min(EXPANSION_ROUTING_THRESHOLDS.maxDepth, rounded),
  );
}

function normalizeTokenCap(tokenCap: number): number {
  if (!Number.isFinite(tokenCap)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.trunc(tokenCap));
}

export function detectBroadTimeRangeIndicator(query?: string): boolean {
  if (!query) return false;
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (BROAD_TIME_RANGE_PATTERNS.some((p) => p.test(trimmed))) return true;
  // Year-range fallback (lossless-claw): two 4-digit years ≥2 years apart
  // in the same query implies a time range that's too broad for direct.
  const years = Array.from(trimmed.matchAll(/\b(?:19|20)\d{2}\b/g), (m) => Number(m[0]));
  if (years.length < 2) return false;
  const earliest = Math.min(...years);
  const latest = Math.max(...years);
  return latest - earliest >= 2;
}

export function detectMultiHopIndicator(input: {
  query?: string;
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
}): boolean {
  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));
  if (normalizedMaxDepth >= EXPANSION_ROUTING_THRESHOLDS.multiHopDepthThreshold) return true;
  if (candidateSummaryCount >= EXPANSION_ROUTING_THRESHOLDS.multiHopCandidateThreshold) return true;
  if (!input.query) return false;
  const trimmed = input.query.trim();
  if (!trimmed) return false;
  return MULTI_HOP_QUERY_PATTERNS.some((p) => p.test(trimmed));
}

export function estimateExpansionTokens(input: {
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
  includeMessages?: boolean;
  broadTimeRangeIndicator?: boolean;
  multiHopIndicator?: boolean;
}): number {
  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));
  if (candidateSummaryCount === 0) return 0;
  const includeMessagesMultiplier = input.includeMessages
    ? EXPANSION_ROUTING_THRESHOLDS.includeMessagesTokenMultiplier
    : 1;
  const depthMultiplier =
    1 + (normalizedMaxDepth - 1) * EXPANSION_ROUTING_THRESHOLDS.perDepthTokenGrowth;
  const timeRangeMultiplier = input.broadTimeRangeIndicator
    ? EXPANSION_ROUTING_THRESHOLDS.broadTimeRangeTokenMultiplier
    : 1;
  const multiHopMultiplier = input.multiHopIndicator
    ? EXPANSION_ROUTING_THRESHOLDS.multiHopTokenMultiplier
    : 1;
  const perSummaryEstimate =
    EXPANSION_ROUTING_THRESHOLDS.baseTokensPerSummary *
    includeMessagesMultiplier *
    depthMultiplier *
    timeRangeMultiplier *
    multiHopMultiplier;
  return Math.max(0, Math.ceil(perSummaryEstimate * candidateSummaryCount));
}

export function classifyExpansionTokenRisk(input: {
  estimatedTokens: number;
  tokenCap: number;
}): { ratio: number; level: ExpansionTokenRiskLevel } {
  const estimatedTokens = Math.max(0, Math.trunc(input.estimatedTokens));
  const tokenCap = normalizeTokenCap(input.tokenCap);
  const ratio = estimatedTokens / tokenCap;
  if (ratio >= EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio) return { ratio, level: "high" };
  if (ratio >= EXPANSION_ROUTING_THRESHOLDS.moderateTokenRiskRatio) return { ratio, level: "moderate" };
  return { ratio, level: "low" };
}

export function decideExpansionRouting(
  input: ExpansionRoutingInput,
): ExpansionRoutingDecision {
  // Empty-query guard (rhino's edge case): without this, an empty query
  // with non-zero candidates falls through to expand_shallow, which is the
  // wrong intent — nothing to route. Explicit answer_directly is correct.
  const trimmed = input.query?.trim() ?? "";
  const directByEmptyQuery = trimmed === "" && input.intent === "query_probe";

  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));
  const tokenCap = normalizeTokenCap(input.tokenCap);
  const broadTimeRange = detectBroadTimeRangeIndicator(input.query);
  const multiHopRetrieval = detectMultiHopIndicator({
    query: input.query,
    requestedMaxDepth: normalizedMaxDepth,
    candidateSummaryCount,
  });
  const estimatedTokens = estimateExpansionTokens({
    requestedMaxDepth: normalizedMaxDepth,
    candidateSummaryCount,
    includeMessages: input.includeMessages,
    broadTimeRangeIndicator: broadTimeRange,
    multiHopIndicator: multiHopRetrieval,
  });
  const tokenRisk = classifyExpansionTokenRisk({ estimatedTokens, tokenCap });

  const directByNoCandidates = candidateSummaryCount === 0;
  const directByLowComplexityProbe =
    input.intent === "query_probe" &&
    !directByNoCandidates &&
    !directByEmptyQuery &&
    normalizedMaxDepth <= EXPANSION_ROUTING_THRESHOLDS.directMaxDepth &&
    candidateSummaryCount <= EXPANSION_ROUTING_THRESHOLDS.directMaxCandidates &&
    tokenRisk.level === "low" &&
    !broadTimeRange &&
    !multiHopRetrieval;

  const delegateByTokenRisk = tokenRisk.level === "high";
  const delegateByBroadTimeRangeAndMultiHop = broadTimeRange && multiHopRetrieval;

  const shouldDirect = directByNoCandidates || directByEmptyQuery || directByLowComplexityProbe;
  const shouldDelegate =
    !shouldDirect && (delegateByTokenRisk || delegateByBroadTimeRangeAndMultiHop);

  const action: ExpansionRoutingAction = shouldDirect
    ? "answer_directly"
    : shouldDelegate
      ? "delegate_traversal"
      : "expand_shallow";

  const reasons: string[] = [];
  if (directByNoCandidates) reasons.push("No candidate summary IDs are available.");
  if (directByEmptyQuery) reasons.push("Empty query string — nothing to route.");
  if (directByLowComplexityProbe) {
    reasons.push("Query probe is low complexity and below retrieval-risk thresholds.");
  }
  if (delegateByTokenRisk) {
    reasons.push(
      `Estimated token risk ratio ${tokenRisk.ratio.toFixed(2)} meets delegate threshold ` +
        `${EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio.toFixed(2)}.`,
    );
  }
  if (delegateByBroadTimeRangeAndMultiHop) {
    reasons.push("Broad time-range request combined with multi-hop retrieval indicators.");
  }
  if (action === "expand_shallow") {
    reasons.push("Complexity is bounded; use direct/shallow expansion.");
  }

  return {
    action,
    normalizedMaxDepth,
    candidateSummaryCount,
    estimatedTokens,
    tokenCap,
    tokenRiskRatio: tokenRisk.ratio,
    tokenRiskLevel: tokenRisk.level,
    indicators: { broadTimeRange, multiHopRetrieval },
    triggers: {
      directByNoCandidates,
      directByEmptyQuery,
      directByLowComplexityProbe,
      delegateByTokenRisk,
      delegateByBroadTimeRangeAndMultiHop,
    },
    reasons,
  };
}
