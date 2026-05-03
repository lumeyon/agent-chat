// subagent.ts — expansion subagent helper. Wraps `runClaude` from llm.ts
// (carina's slice 1) with the subagent invariants vanguard designed at
// Round 12 Phase 1: candidate-ID prompt injection, post-hoc citation
// extraction, orphan-ID rejection, partial-stdout capture on timeout, env
// denylist + prompt-via-stdin to avoid argv leak.
//
// Returns a tagged-union result so callers can branch on the failure mode
// without throwing — vanguard's stable reason enum lets log scrapers
// categorize.
//
// Drops lossless-claw's `ExpansionAuthority` revocable-grants design:
// our threat model is single-user laptop, no external callers, so the
// call site (search.ts expand --delegate) IS the trust boundary. Token
// cap + timeout are sufficient defense-in-depth.
// TODO(hosted): see lossless-claw expansion-auth.ts when we ever ship a
// hosted variant where multiple users share a single claude budget.
//
// Lives in its own file so importing the helpers doesn't trigger the
// search.ts top-level dispatcher's argv parsing.

export type ExpansionSuccess = {
  ok: true;
  answer: string;
  citedIds: string[];
  tokensUsed: number;
};
export type ExpansionFailure = {
  ok: false;
  reason: "timeout" | "exit_nonzero" | "no_citations" | "token_cap" | "not_found" | "spawn_error";
  stderr: string;
  partialAnswer?: string;
  partialCitedIds?: string[];
};
export type ExpansionResult = ExpansionSuccess | ExpansionFailure;

export type ExpansionArgs = {
  archiveIds: string[];
  archivePaths: string[];
  candidateIdsForCitation: string[];
  tokenCap: number;
  timeoutMs: number;
};

export type Spawner = (args: ExpansionArgs) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  reason: "ok" | "not-found" | "timeout" | "exit" | "killed" | "spawn-error" | "reentrancy";
}>;

// Real spawner — uses carina's runClaude from scripts/llm.ts when available.
// Falls back to "not-found" when llm.ts is missing.
export const realClaudeSpawner: Spawner = async (a: ExpansionArgs) => {
  let runClaude: any;
  try { ({ runClaude } = await import("./llm.ts")); }
  catch { return { stdout: "", stderr: "scripts/llm.ts not present", code: null, reason: "not-found" }; }
  const prompt = renderSubagentPrompt(a);
  return runClaude({
    args: ["-p", "--output-format=text", ...a.archivePaths.flatMap((p) => ["--add-dir", p])],
    prompt,
    timeoutMs: a.timeoutMs,
  });
};

export function renderSubagentPrompt(a: ExpansionArgs): string {
  return [
    "You are an expansion subagent. Read the archives provided and produce a focused answer.",
    "",
    `Candidate archive IDs you may cite (cite at least one):`,
    ...a.candidateIdsForCitation.map((id) => `  - ${id}`),
    "",
    "Constraints:",
    `  - Total response < ${Math.floor(a.tokenCap * 4)} bytes (~${a.tokenCap} tokens).`,
    "  - Cite at least one of the IDs above. Cite by exact ID.",
    "  - Do not cite IDs not in the candidate list (no hallucinations).",
    "",
    "Produce a concise answer drawn from the archives. End with a `Cited:` line listing the IDs you used.",
  ].join("\n");
}

export async function spawnExpansionSubagent(
  args: ExpansionArgs,
  spawner: Spawner = realClaudeSpawner,
): Promise<ExpansionResult> {
  let r;
  try { r = await spawner(args); } catch (err) {
    return { ok: false, reason: "spawn_error", stderr: (err as Error).message };
  }
  if (r.reason === "not-found") {
    return { ok: false, reason: "not_found", stderr: r.stderr };
  }
  if (r.reason === "timeout" || r.reason === "killed") {
    // Vanguard's Phase-1 design: capture partial stdout for the fallback
    // to merge. Even a partial answer with one valid cite beats discarding
    // the work.
    const cited = extractCitedIds(r.stdout, args.candidateIdsForCitation);
    return {
      ok: false,
      reason: "timeout",
      stderr: r.stderr,
      partialAnswer: r.stdout,
      partialCitedIds: cited.validIds,
    };
  }
  if (r.code !== 0 || r.reason === "exit" || r.reason === "spawn-error" || r.reason === "reentrancy") {
    return { ok: false, reason: r.reason === "spawn-error" ? "spawn_error" : "exit_nonzero", stderr: r.stderr };
  }
  // Success path: enforce post-hoc invariants.
  const tokensUsed = Math.ceil(r.stdout.length / 4);
  if (tokensUsed > args.tokenCap) {
    return { ok: false, reason: "token_cap", stderr: r.stderr };
  }
  const cited = extractCitedIds(r.stdout, args.candidateIdsForCitation);
  // Vanguard's harden: require non-empty intersection AND no orphans.
  if (cited.validIds.length === 0 || cited.orphanIds.length > 0) {
    return { ok: false, reason: "no_citations", stderr: r.stderr };
  }
  return { ok: true, answer: r.stdout, citedIds: cited.validIds, tokensUsed };
}

// Extract `arch_(L|C)_<hex>` IDs from text. Partition into validIds (those
// in candidateIdsForCitation) vs orphanIds (extracted but not in the
// candidate set — LLM hallucination signal).
export function extractCitedIds(text: string, candidates: string[]): { validIds: string[]; orphanIds: string[] } {
  const candidateSet = new Set(candidates);
  const matches = Array.from(text.matchAll(/\barch_[LC]_[A-Za-z0-9_-]+\b/g), (m) => m[0]);
  const seen = new Set<string>();
  const validIds: string[] = [];
  const orphanIds: string[] = [];
  for (const id of matches) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (candidateSet.has(id)) validIds.push(id);
    else orphanIds.push(id);
  }
  return { validIds, orphanIds };
}
