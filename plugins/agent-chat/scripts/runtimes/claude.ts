// scripts/runtimes/claude.ts — Claude Code runtime adapter (Round 15b).
//
// agent-chat is runtime-agnostic by design (filesystem-first wire
// protocol). Round 15b makes the adapter explicit so the same codebase
// can ship as a Claude Code plugin AND a Codex plugin from one repo.
//
// What this adapter does:
//   - Wraps `claude -p` shell-out (the existing scripts/llm.ts:runClaude
//     primitive) as the canonical Claude-runtime ephemeral dispatcher.
//   - Wraps `ScheduleWakeup` directives for cache-warm self-rescheduling
//     (the existing scripts/loop-driver.ts pattern).
//
// What this adapter does NOT do:
//   - Replace the wire protocol. CONVO.md / .turn / index.jsonl /
//     archives/ are unchanged across runtimes.
//   - Swap out the per-agent identity model. SessionRecord lookup
//     still goes through resolveIdentity; the adapter is invoked by
//     callers who already have an identity resolved.
//
// Round 15b status: skeleton + types pinned. The actual `runClaude` and
// `scheduleWakeup` primitives already live at scripts/llm.ts and
// scripts/loop-driver.ts. This module is a thin facade so the codex.ts
// adapter has a symmetric counterpart and future Round-16+ work can
// route per-agent runtime choices through one switch.
//
// See docs/round-15b-codex-probe.md for the open empirical questions.

import { runClaude, type RunClaudeResult } from "../llm.ts";
import { CACHE_WARM_DELAY_SEC } from "../lib.ts";

export type RuntimeName = "claude" | "codex";

export type EphemeralDispatchInput = {
  prompt: string;
  /** Per-call timeout in ms. Defaults to 90s (matches cmdRun's existing budget). */
  timeoutMs?: number;
};

export type EphemeralDispatchResult = RunClaudeResult;

/**
 * Run a single ephemeral Claude invocation. Wraps `claude -p` via the
 * existing runClaude primitive. Honors AGENT_CHAT_NO_LLM=1 and the
 * reentrancy sentinel.
 */
export async function dispatch(input: EphemeralDispatchInput): Promise<EphemeralDispatchResult> {
  return runClaude({
    prompt: input.prompt,
    timeoutMs: input.timeoutMs ?? 90_000,
  });
}

/**
 * Emit a ScheduleWakeup directive (or its mock equivalent) to keep the
 * prompt cache warm between iterations of an agent-chat loop. Real
 * scheduling is the harness's job — this function emits the directive
 * to stdout for /loop skill context to pick up.
 *
 * Mirrors the loop-driver.ts logic so the runtime split surface stays
 * uniform: any caller wanting to schedule a wakeup goes through the
 * adapter rather than reaching into loop-driver internals.
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

/** Identity tag — useful for diagnostics and per-runtime routing. */
export const RUNTIME_NAME: RuntimeName = "claude";
