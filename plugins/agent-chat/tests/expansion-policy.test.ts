// Slice 3 (Round 12) tests — keystone owns:
// 1. Expansion routing decision matrix (expansion-policy.ts).
// 2. Footer parsing for expansion hints (search.ts grep).
// 3. Subagent delegation with DI mock spawner (search.ts spawnExpansionSubagent).
// 4. Descendant token count on archive entries.
// 5. Sidecar incremental auto-compaction trigger.

import { test, expect, describe } from "bun:test";
import { decideExpansionRouting } from "../scripts/expansion-policy.ts";
import { spawnExpansionSubagent } from "../scripts/subagent.ts";

// ---------------------------------------------------------------------------
// 1. Routing decision matrix — 9-query fixture (rhino's Phase-1 design)
// ---------------------------------------------------------------------------

describe("decideExpansionRouting — 9-query fixture from rhino", () => {
  function decide(query: string, opts: { candidates?: number; depth?: number } = {}) {
    return decideExpansionRouting({
      intent: "query_probe",
      query,
      candidateSummaryCount: opts.candidates ?? 2,
      tokenCap: 50000,
      requestedMaxDepth: opts.depth ?? 1,
    });
  }

  test("empty query → answer_directly (rhino's edge-case guard)", () => {
    const d = decide("", { candidates: 5 });
    expect(d.action).toBe("answer_directly");
    expect(d.triggers.directByEmptyQuery).toBe(true);
  });

  test("no-pattern single-hop query → answer_directly when depth+candidates allow", () => {
    const d = decide("what was decision X", { candidates: 1, depth: 1 });
    expect(d.action).toBe("answer_directly");
  });

  test("id-direct query → answer_directly (no broad-time, no multi-hop)", () => {
    const d = decide("what's in archive arch_L_abc", { candidates: 1 });
    expect(d.action).toBe("answer_directly");
  });

  test("agent-chat vocabulary: chain-of-decisions detected as multi-hop", () => {
    const d = decide("what's the chain of decisions on locking");
    expect(d.indicators.multiHopRetrieval).toBe(true);
    expect(d.indicators.broadTimeRange).toBe(false);
  });

  test("agent-chat vocabulary: across the last three rounds → broad-time", () => {
    const d = decide("across the last three rounds");
    expect(d.indicators.broadTimeRange).toBe(true);
  });

  test("agent-chat vocabulary: 'what did petersen audit decide' → multi-hop", () => {
    const d = decide("what did petersen audit decide");
    expect(d.indicators.multiHopRetrieval).toBe(true);
  });

  test("BOTH broad-time AND multi-hop → delegate", () => {
    const d = decide("audit trail across rounds");
    expect(d.action).toBe("delegate_traversal");
    expect(d.indicators.broadTimeRange).toBe(true);
    expect(d.indicators.multiHopRetrieval).toBe(true);
  });

  test("year-range fallback (lossless-claw original): 2 years ≥2 apart", () => {
    const d = decide("changes between 2024 and 2027");
    expect(d.indicators.broadTimeRange).toBe(true);
  });

  test("root cause query → multi-hop indicator (lossless-claw original)", () => {
    const d = decide("root cause of latch contention");
    expect(d.indicators.multiHopRetrieval).toBe(true);
  });

  test("high token-risk → delegate even without broad+multi", () => {
    // Lots of candidates blow past the high-risk ratio.
    const d = decideExpansionRouting({
      intent: "query_probe",
      query: "what was decision X",
      candidateSummaryCount: 200,
      tokenCap: 5000,
      requestedMaxDepth: 1,
    });
    expect(d.action).toBe("delegate_traversal");
    expect(d.tokenRiskLevel).toBe("high");
  });

  test("zero candidates → answer_directly (no candidates trigger)", () => {
    const d = decide("anything", { candidates: 0 });
    expect(d.action).toBe("answer_directly");
    expect(d.triggers.directByNoCandidates).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. spawnExpansionSubagent with DI mock spawner (vanguard's design)
// ---------------------------------------------------------------------------

describe("spawnExpansionSubagent — DI mock spawner", () => {
  const archiveIds = ["arch_L_abc123", "arch_L_def456"];
  const baseArgs = {
    archiveIds,
    archivePaths: ["/tmp/fake/abc", "/tmp/fake/def"],
    candidateIdsForCitation: archiveIds,
    tokenCap: 50000,
    timeoutMs: 1000,
  };

  test("happy path: cited IDs are valid (set intersection non-empty, no orphans)", async () => {
    const spawner = async () => ({
      stdout: "The decision was X. Cited: arch_L_abc123",
      stderr: "",
      code: 0,
      reason: "ok" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.citedIds).toEqual(["arch_L_abc123"]);
      expect(r.tokensUsed).toBeGreaterThan(0);
    }
  });

  test("orphan ID rejection (vanguard's harden against LLM hallucination)", async () => {
    const spawner = async () => ({
      stdout: "The answer cites arch_L_abc123 and arch_L_HALLUCINATED",
      stderr: "",
      code: 0,
      reason: "ok" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_citations");
    }
  });

  test("no citations at all → no_citations reason", async () => {
    const spawner = async () => ({
      stdout: "Plain answer with no archive IDs",
      stderr: "",
      code: 0,
      reason: "ok" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_citations");
  });

  test("token cap exceeded post-hoc", async () => {
    const spawner = async () => ({
      stdout: "X".repeat(50000) + " arch_L_abc123",  // 50k chars / 4 = 12500 tokens, well under cap
      stderr: "",
      code: 0,
      reason: "ok" as const,
    });
    const tightCap = { ...baseArgs, tokenCap: 100 };  // cap of 100 tokens = 400 bytes; 50k chars exceeds
    const r = await spawnExpansionSubagent(tightCap, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("token_cap");
  });

  test("timeout: partial stdout captured for fallback merge", async () => {
    const spawner = async () => ({
      stdout: "Partial answer with arch_L_abc123 captured before kill",
      stderr: "killed",
      code: null,
      reason: "timeout" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("timeout");
      expect(r.partialAnswer).toContain("Partial answer");
      expect(r.partialCitedIds).toEqual(["arch_L_abc123"]);
    }
  });

  test("non-zero exit → exit_nonzero reason", async () => {
    const spawner = async () => ({
      stdout: "",
      stderr: "claude failed",
      code: 1,
      reason: "exit" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("exit_nonzero");
  });

  test("not-found (claude binary missing or llm.ts not yet shipped) → not_found reason", async () => {
    const spawner = async () => ({
      stdout: "",
      stderr: "claude not on PATH",
      code: null,
      reason: "not-found" as const,
    });
    const r = await spawnExpansionSubagent(baseArgs, spawner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});
