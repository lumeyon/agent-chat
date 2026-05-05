// scripts/loop-driver.ts — Round-15a slice 1 (lumeyon): ScheduleWakeup wrapper.
//
// Calls cmdRun({once: true}) once. If any work was processed OR any edge
// still has actionable state, calls ScheduleWakeup to fire the next tick
// CACHE_WARM_DELAY_SEC seconds later. Otherwise terminates the loop quietly.
//
// `ScheduleWakeup` is Claude Code's harness primitive — not callable from
// arbitrary processes. The driver is intended to run UNDER `/loop` skill
// context (or any harness providing the equivalent re-injection). For
// non-Claude-Code use OR test environments, the AGENT_CHAT_LOOP_MOCK_WAKEUP=1
// env hook prints a single line to stdout describing what would have been
// scheduled, then exits 0. Keystone's slice-3 cache-warm scheduled-loop test
// parses this for `WOULD_WAKE delay_seconds=(\d+)` to assert the constant
// reaches the loop driver intact.
//
// This is the third hermetic-test env hook in our codebase, alongside
// AGENT_CHAT_NO_LLM (Round-12 carina) and AGENT_CHAT_HEARTBEAT_INTERVAL=0
// (Round-13 lumeyon). Same pattern: env-var opt-in, default-real, single-LoC
// override surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveIdentity, loadTopology, edgesOf, readTurn, CACHE_WARM_DELAY_SEC, SKILL_ROOT } from "./lib.ts";

// ScheduleWakeup is a Claude Code harness primitive provided through MCP.
// Not callable as a top-level import. The mock path is the test surface;
// the real path delegates to whatever the user's harness wires.
function scheduleWakeup(delaySeconds: number, reason: string): void {
  if (process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP === "1") {
    console.log(`WOULD_WAKE delay_seconds=${delaySeconds} reason=${reason}`);
    return;
  }
  // Real Claude Code harness path: emit a structured directive to stdout
  // that /loop skill context picks up. This shape is the same as Ruflo's
  // ScheduleWakeup tool invocation. When run outside /loop, the directive
  // is logged but no-op'd.
  console.log(JSON.stringify({
    schedule_wakeup: { delay_seconds: delaySeconds, reason },
  }));
}

async function main(): Promise<void> {
  // Run one tick. If cmdRun reports work was done OR edges still have our
  // turn (peer flipped during the tick), re-arm. Otherwise quietly exit.
  // Shell-out via execPath rather than dynamic import — agent-chat.ts is
  // a CLI script with argv-driven top-level dispatch; importing would
  // re-execute its top-level switch statement on the harness's own argv.
  //
  // Round-15a Phase-4 carina-CRITICAL: spawnSync resolves relative paths
  // against `process.cwd()` by default. When `/loop` fires from a user's
  // project directory (NOT the skill root), `"scripts/agent-chat.ts"`
  // resolves wrong and ENOENT-fails. Use absolute SKILL_ROOT join + cwd
  // pin so the spawn works regardless of caller's cwd.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/agent-chat.ts"), "run"], {
    cwd: SKILL_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`[loop-driver] cmdRun exited ${r.status}; aborting loop.`);
    process.exit(r.status ?? 1);
  }
  // Post-tick: re-peek every edge to decide whether another tick is needed.
  // Two re-arm signals:
  //   1. Any edge has .turn=<self> (we either skipped it for safety/lock
  //      reasons, or a peer flipped during runClaude).
  //   2. (Future): index.jsonl mtime advanced (peer appended new content
  //      that doesn't go through the turn flip). Round-15a-v1 only checks
  //      .turn=self; the mtime path lands when carina's slice 2 wires
  //      record-turn into ephemeral mode.
  const id = resolveIdentity();
  const topo = loadTopology(id.topology);
  const edges = edgesOf(topo, id.name);
  let pending = 0;
  for (const edge of edges) {
    const turn = readTurn(edge.turn);
    if (turn === id.name && !fs.existsSync(edge.lock)) pending++;
  }
  if (pending > 0) {
    scheduleWakeup(CACHE_WARM_DELAY_SEC, "agent-chat next tick");
    console.error(`[loop-driver] ${pending} edge(s) pending; scheduled next tick in ${CACHE_WARM_DELAY_SEC}s.`);
  } else {
    console.error(`[loop-driver] no work pending; loop terminated.`);
  }
}

void main();
