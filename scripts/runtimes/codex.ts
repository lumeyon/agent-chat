// scripts/runtimes/codex.ts — Codex runtime adapter (Round 15b skeleton).
//
// agent-chat's wire protocol (CONVO.md, .turn, index.jsonl, archives/)
// is runtime-agnostic. Round 15b adds Codex-runtime support so the
// same codebase can ship as a plugin for both Claude Code and Codex.
//
// What this adapter SHOULD do (full implementation gated on Codex
// empirical work — see docs/round-15b-codex-probe.md):
//   - Wrap `codex exec <prompt>` (or the equivalent ephemeral
//     invocation Codex's CLI exposes) as the per-call dispatcher.
//   - For self-rescheduling: emit a CronCreate-equivalent directive
//     since Codex docs do NOT document a ScheduleWakeup analog
//     (verified Round-13 + Round-14). The fallback is external cron
//     OR a long-living Claude session that dispatches Codex children.
//
// What this adapter does NOT do:
//   - Touch the wire protocol. Codex agents read/write the same
//     CONVO.md / .turn / index.jsonl / archives/ files Claude agents
//     do. Cross-runtime mixing on the same petersen graph works
//     because the protocol is filesystem-mediated.
//
// Round 15b STATUS: SKELETON ONLY.
//
// The dispatch + scheduleWakeup functions throw `RUNTIME_NOT_IMPLEMENTED`
// errors. Filing them as throws-rather-than-stubs is deliberate — a
// caller invoking the codex adapter accidentally (e.g. via a `runtime:
// codex` field in agents.<topology>.yaml that future Round-16+ adds)
// gets a loud failure instead of silent no-op behavior. Same anti-
// pattern defense vanguard's verdict-rigor frame produced in Round 14.
//
// The empirical work needed before this adapter ships behaviorally:
//
// 1. Verify `codex exec <prompt>` is the real CLI entrypoint for
//    non-interactive single-prompt invocation. Or `codex run`. Or
//    something else — Codex's CLI evolved through 2025 and the
//    documented API may not match current binary behavior.
//
// 2. Verify Codex inherits CLAUDE_SESSION_ID (or its equivalent) so
//    Round-15c's Contract A pre-write pattern works for Codex
//    children too. If Codex doesn't honor an inherited session-key
//    env var, the adapter has to invent its own propagation channel.
//
// 3. Probe Codex's hook event taxonomy. The published docs are
//    silent on event names; the empirical approach (rhino's protocol
//    queued at Round 14) is to register hooks for every plausible
//    name (PreToolUse, PreCommand, PreEdit, PreSubmit, PreSession,
//    PrePrompt, etc.) and observe which fire on a representative run.
//
// 4. Decide the wakeup mechanism. Three paths:
//    (a) External cron — agnostic to runtime, most invasive setup.
//    (b) MCP push notification — if Codex exposes one.
//    (c) Long-living Claude orchestrator that dispatches Codex
//        children. Couples cross-runtime work to a Claude session
//        being alive somewhere.
//
// Round 15b will land as a separate commit when these are answered.

import type { RunClaudeResult } from "../llm.ts";
import { CACHE_WARM_DELAY_SEC } from "../lib.ts";

export type EphemeralDispatchInput = {
  prompt: string;
  timeoutMs?: number;
};

export type EphemeralDispatchResult = RunClaudeResult;

const RUNTIME_NOT_IMPLEMENTED = (op: string): Error => new Error(
  `[runtimes/codex] ${op} not yet implemented. ` +
  `Round-15b skeleton — full implementation requires Codex empirical work. ` +
  `See docs/round-15b-codex-probe.md for the open questions.`,
);

/**
 * Dispatch a single ephemeral Codex invocation. NOT YET IMPLEMENTED;
 * throws to make accidental routing surface loudly.
 */
export async function dispatch(_input: EphemeralDispatchInput): Promise<EphemeralDispatchResult> {
  throw RUNTIME_NOT_IMPLEMENTED("dispatch");
}

/**
 * Emit a wakeup directive for Codex. NOT YET IMPLEMENTED; throws.
 *
 * Note: Codex docs document NO ScheduleWakeup analog (verified
 * 2026-05-04). This function will likely emit a CronCreate-style
 * directive OR delegate to an external cron — final shape pending
 * empirical work.
 */
export function scheduleWakeup(_reason: string, _delaySeconds: number = CACHE_WARM_DELAY_SEC): void {
  throw RUNTIME_NOT_IMPLEMENTED("scheduleWakeup");
}

/** Identity tag for per-runtime routing. */
export const RUNTIME_NAME: "codex" = "codex";
