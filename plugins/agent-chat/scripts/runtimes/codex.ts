// scripts/runtimes/codex.ts — Codex runtime adapter.
//
// agent-chat's wire protocol (CONVO.md, .turn, index.jsonl, archives/)
// is runtime-agnostic. This adapter wraps the Codex CLI's non-interactive
// dispatch surface so the same codebase can ship as a Claude Code plugin
// AND a Codex plugin from one repo.
//
// What this adapter does:
//   - dispatch(input) shells out to `codex exec <prompt>` (Codex's
//     non-interactive entrypoint, equivalent to `claude -p`). Honors
//     AGENT_CHAT_NO_LLM=1 hermeticity flag and AGENT_CHAT_INSIDE_LLM_CALL=1
//     reentrancy guard the same way runClaude does.
//   - scheduleWakeup(reason, delay) emits the same JSON directive shape
//     Claude's adapter does ({"schedule_wakeup": {"delay_seconds", "reason"}}).
//     The consumer is loop-driver.ts, not the CLI itself, so the directive
//     format is runtime-agnostic.
//
// What this adapter does NOT do:
//   - Touch the wire protocol. Codex agents read/write the same CONVO.md
//     / .turn / archives / dots / scratchpad files Claude agents do.
//     Cross-runtime mixing on the same petersen graph works because the
//     protocol is filesystem-mediated.
//
// Empirical findings (Round 15i, codex-cli 0.128.0):
//
//   1. CLI surface confirmed: `codex exec <prompt>` is the non-interactive
//      single-shot entry. Stdin can append a `<stdin>` block to the
//      prompt — useful for large payloads where shell argv length matters.
//      Verified by `codex exec --help`.
//
//   2. Marketplace add: `codex plugin marketplace add <owner>/<repo>` git-
//      clones the repo into ~/.codex/.tmp/marketplaces/<name>/. The
//      marketplace name is extracted from `.claude-plugin/marketplace.json`'s
//      `name` field (Codex tolerates the Claude-shaped manifest at the
//      marketplace level — only "name" is required). This works.
//
//   3. Plugin install: NOT TRIGGERED by `marketplace add`. Codex expects a
//      separate per-plugin enable step via config.toml entries
//      (`[plugins."<name>@<marketplace>"]\nenabled = true`) OR an
//      interactive prompt during agent startup. Pre-existing curated
//      plugins ship as `source: { source: "local", path: "..." }` objects
//      with an explicit `policy: { installation: "AVAILABLE" }` field,
//      which our marketplace.json doesn't have — Codex may silently skip
//      our plugins[] entries if the policy field is missing.
//
//   4. Hook events: NOT yet probed empirically. Skipped for v1; loop-
//      driver.ts handles scheduling at the bun/CLI layer instead of via
//      Codex hooks.
//
//   5. ScheduleWakeup analog in Codex: NONE found in the CLI surface
//      (no equivalent of Claude Code's ScheduleWakeup tool). The directive-
//      to-stdout pattern (matching Claude's adapter) sidesteps this — the
//      consumer is loop-driver, which handles the actual sleep+rerun via
//      bun's setTimeout in --interactive mode or an external cron in batch
//      mode.

import * as child_process from "node:child_process";
import type { RunClaudeResult } from "../llm.ts";
import { CACHE_WARM_DELAY_SEC } from "../lib.ts";

export type RuntimeName = "claude" | "codex";

export type EphemeralDispatchInput = {
  prompt: string;
  /** Per-call timeout in ms. Defaults to 90s (matches Claude adapter). */
  timeoutMs?: number;
};

export type EphemeralDispatchResult = RunClaudeResult;

/** Default timeout matches Claude adapter (90s). */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Run a single ephemeral Codex invocation via `codex exec`. Honors
 * AGENT_CHAT_NO_LLM=1 (returns "not-found" reason) and
 * AGENT_CHAT_INSIDE_LLM_CALL=1 (reentrancy refusal). Same shape as
 * Claude adapter so cross-runtime callers can swap one for the other.
 *
 * Returns RunClaudeResult — the discriminated-union shape both runtimes
 * share. {stdout: null, reason: "not-found"} on missing CLI;
 * {stdout: null, reason: "reentrancy"} on AGENT_CHAT_INSIDE_LLM_CALL=1;
 * {stdout, code: 0, stderr: "", reason: undefined} on success.
 */
export async function dispatch(input: EphemeralDispatchInput): Promise<EphemeralDispatchResult> {
  // Reentrancy guard — refuse to recurse into the LLM if we're already
  // inside a dispatch. Same defense as scripts/llm.ts:runClaude.
  if (process.env.AGENT_CHAT_INSIDE_LLM_CALL === "1") {
    return { stdout: null, stderr: "", code: null, reason: "reentrancy" };
  }
  // Hermeticity flag — tests and offline harnesses can opt out of the
  // real LLM call without modifying the call site.
  if (process.env.AGENT_CHAT_NO_LLM === "1") {
    return { stdout: null, stderr: "AGENT_CHAT_NO_LLM=1", code: null, reason: "not-found" };
  }
  // Probe `codex` on PATH. If absent, return "not-found" so the caller
  // can fall back gracefully (matches runClaude's missing-binary path).
  const probe = child_process.spawnSync("which", ["codex"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    return {
      stdout: null,
      stderr: "codex CLI not found on PATH. Install codex-cli or set runtime: claude in agents.<topology>.yaml.",
      code: null,
      reason: "not-found",
    };
  }
  const codexBin = probe.stdout.trim();

  // Spawn codex exec with the prompt as the positional argument. Pass the
  // reentrancy sentinel via env so any descendant agent-chat invocation
  // (e.g. archive.ts auto inside a Codex-driven sub-relay) refuses to
  // re-enter the LLM. Mirrors scripts/llm.ts:scrubChildEnv.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_NAME;
  delete env.AGENT_TOPOLOGY;
  delete env.AGENT_CHAT_USER;
  env.AGENT_CHAT_INSIDE_LLM_CALL = "1";

  const r = child_process.spawnSync(codexBin, ["exec", input.prompt], {
    encoding: "utf8",
    timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env,
  });

  if (r.error && (r.error as any).code === "ETIMEDOUT") {
    return {
      stdout: null,
      stderr: `codex exec timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      code: null,
      reason: "timeout",
    };
  }
  // Round-15l: return reason="ok" on success for shape symmetry with the
  // Claude adapter (runClaude returns "ok" — see llm.ts:289). Pre-fix this
  // returned reason=undefined on success which forced cmdRun to do an
  // ad-hoc `r.reason == null || r.reason === "ok"` check; symmetric shape
  // lets the cross-runtime call site treat both adapters identically.
  return {
    stdout: r.stdout ?? null,
    stderr: r.stderr ?? "",
    code: r.status,
    reason: r.status === 0 ? "ok" : "error",
  };
}

/**
 * Emit a ScheduleWakeup directive. Codex has no native ScheduleWakeup
 * tool, so we use the same JSON-to-stdout pattern as the Claude adapter:
 * the consumer is loop-driver.ts, which handles the actual sleep+rerun
 * via setTimeout (interactive mode) or external cron (batch mode).
 *
 * Mock mode (AGENT_CHAT_LOOP_MOCK_WAKEUP=1) emits the WOULD_WAKE format
 * for hermetic test assertions — same as Claude adapter.
 */
export function scheduleWakeup(reason: string, delaySeconds: number = CACHE_WARM_DELAY_SEC): void {
  if (process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP === "1") {
    console.log(`WOULD_WAKE delay_seconds=${delaySeconds} reason=${reason}`);
    return;
  }
  console.log(JSON.stringify({
    schedule_wakeup: { delay_seconds: delaySeconds, reason },
  }));
}

/** Identity tag for per-runtime routing. */
export const RUNTIME_NAME: RuntimeName = "codex";
