// scripts/loop-driver.ts — Round-15a slice 1 (lumeyon): ScheduleWakeup wrapper.
// Round-15e: extended with --interactive cadence + stuck-recovery + tick
// extension support. Same shape as Ruflo's autopilot-loop pattern.
//
// Usage:
//   bun scripts/loop-driver.ts                       single tick + 270s ScheduleWakeup if pending
//   bun scripts/loop-driver.ts --interactive         tight 1-3s tick loop until idle (real-time deliberation)
//   bun scripts/loop-driver.ts --max-tick-seconds N  override the 270s cache-warm delay
//
// `ScheduleWakeup` is Claude Code's harness primitive — not callable from
// arbitrary processes. The driver is intended to run UNDER `/loop` skill
// context (or any harness providing the equivalent re-injection). For
// non-Claude-Code use OR test environments, the AGENT_CHAT_LOOP_MOCK_WAKEUP=1
// env hook prints a single line to stdout describing what would have been
// scheduled, then exits 0.
//
// Stuck-recovery (Round-15e): if a peer agent's edge has held our turn
// for >stuck-tick-timeout (default 300s = the Round-13 STUCK_TURN_TIMEOUT_MS
// constant), and no progress signal has fired (no lock, no CONVO.md
// growth), loop-driver re-dispatches a fresh `agent-chat run` for that
// edge specifically (with --speaker propagated if known). Closes the
// gap between Round-13's stuck-detection and "actually un-stick" under
// ephemeral-only execution.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveIdentity, loadTopology, edgesOf, readTurn, CACHE_WARM_DELAY_SEC, SKILL_ROOT } from "./lib.ts";

// Default stuck-tick timeout matches Round-13's STUCK_TURN_TIMEOUT_MS
// (300s = 5 min) so the auto-redispatch threshold is the same as the
// detection threshold. Configurable via env or --stuck-tick-seconds.
const DEFAULT_STUCK_TICK_SEC = 300;

type Args = {
  interactive: boolean;
  maxTickSec: number;
  stuckTickSec: number;
  /** Tight-poll cadence for --interactive mode. */
  interactiveTickSec: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    interactive: false,
    maxTickSec: CACHE_WARM_DELAY_SEC,
    stuckTickSec: parseInt(process.env.AGENT_CHAT_STUCK_TICK_SEC ?? "", 10) || DEFAULT_STUCK_TICK_SEC,
    interactiveTickSec: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interactive") a.interactive = true;
    else if (argv[i] === "--max-tick-seconds") a.maxTickSec = parseInt(argv[++i] ?? "", 10);
    else if (argv[i] === "--stuck-tick-seconds") a.stuckTickSec = parseInt(argv[++i] ?? "", 10);
    else if (argv[i] === "--interactive-tick-seconds") a.interactiveTickSec = parseInt(argv[++i] ?? "", 10);
  }
  return a;
}

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

async function runTick(): Promise<{ status: number }> {
  const { spawnSync } = await import("node:child_process");
  // Round-15a Phase-4 carina-CRITICAL: spawnSync uses absolute SKILL_ROOT
  // join + cwd pin so the spawn works regardless of caller's cwd.
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/agent-chat.ts"), "run"], {
    cwd: SKILL_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  return { status: r.status ?? 1 };
}

type EdgeStatus = {
  edgeId: string;
  peer: string;
  hasTurn: boolean;
  turnAgeSec: number;
  hasLock: boolean;
  convoMtimeAgeSec: number;
};

function probeEdges(): { id: { name: string }; statuses: EdgeStatus[] } {
  const id = resolveIdentity();
  const topo = loadTopology(id.topology);
  const edges = edgesOf(topo, id.name);
  const now = Date.now();
  const statuses: EdgeStatus[] = [];
  for (const edge of edges) {
    const turn = readTurn(edge.turn);
    let turnAgeSec = 0;
    try { turnAgeSec = Math.round((now - fs.statSync(edge.turn).mtimeMs) / 1000); } catch {}
    let convoMtimeAgeSec = Number.POSITIVE_INFINITY;
    try { convoMtimeAgeSec = Math.round((now - fs.statSync(edge.convo).mtimeMs) / 1000); } catch {}
    statuses.push({
      edgeId: edge.id,
      peer: edge.peer,
      hasTurn: turn === id.name,
      turnAgeSec,
      hasLock: fs.existsSync(edge.lock),
      convoMtimeAgeSec,
    });
  }
  return { id, statuses };
}

// Round-15e: stuck-recovery probe. An edge is "stuck-on-own-turn" when:
//   - turn = me
//   - turn age > stuckTickSec
//   - no lock held (lock = work in progress; not stuck)
//   - convo not recently grown (no progress)
// Returns the list of stuck edges that need auto-redispatch.
function findStuckEdges(statuses: EdgeStatus[], stuckTickSec: number): EdgeStatus[] {
  return statuses.filter((s) =>
    s.hasTurn &&
    s.turnAgeSec > stuckTickSec &&
    !s.hasLock &&
    s.convoMtimeAgeSec > stuckTickSec,
  );
}

async function singleTickPass(args: Args): Promise<{ pending: number; stuck: number; status: number }> {
  const r = await runTick();
  if (r.status !== 0) {
    console.error(`[loop-driver] cmdRun exited ${r.status}; aborting loop.`);
    return { pending: 0, stuck: 0, status: r.status };
  }
  const { statuses } = probeEdges();
  const pending = statuses.filter((s) => s.hasTurn && !s.hasLock).length;
  const stuck = findStuckEdges(statuses, args.stuckTickSec);
  // Auto-redispatch stuck edges: a fresh `agent-chat run <peer>` for each.
  // Round-15e directly addresses the user-flagged "ephemeral session got
  // rate-limited mid-tick" pattern — instead of waiting on the human to
  // poke the stuck session, the next tick re-dispatches that edge with
  // a fresh process.
  if (stuck.length > 0) {
    const { spawnSync } = await import("node:child_process");
    for (const s of stuck) {
      console.error(`[loop-driver] stuck-recovery: redispatching ${s.edgeId} (turn_age=${s.turnAgeSec}s > ${args.stuckTickSec}s)`);
      try {
        spawnSync(process.execPath, [path.join(SKILL_ROOT, "scripts/agent-chat.ts"), "run", s.peer], {
          cwd: SKILL_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "inherit", "inherit"],
        });
      } catch (err) {
        console.error(`[loop-driver] stuck-recovery dispatch failed for ${s.edgeId}: ${(err as Error).message}`);
      }
    }
  }
  return { pending, stuck: stuck.length, status: 0 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.interactive) {
    // Tight-poll mode: keep ticking every interactiveTickSec until no
    // edges are pending. Used for real-time deliberation where the user
    // is in the loop watching agents respond.
    console.error(`[loop-driver] --interactive mode: ${args.interactiveTickSec}s tick cadence`);
    let consecutiveIdle = 0;
    while (consecutiveIdle < 3) {
      const r = await singleTickPass(args);
      if (r.status !== 0) process.exit(r.status);
      if (r.pending === 0 && r.stuck === 0) {
        consecutiveIdle++;
      } else {
        consecutiveIdle = 0;
      }
      if (consecutiveIdle < 3) {
        await new Promise((res) => setTimeout(res, args.interactiveTickSec * 1000));
      }
    }
    console.error(`[loop-driver] --interactive: 3 consecutive idle ticks; exiting.`);
    return;
  }

  // Default mode: single tick + ScheduleWakeup if pending.
  const r = await singleTickPass(args);
  if (r.status !== 0) process.exit(r.status);
  if (r.pending > 0 || r.stuck > 0) {
    scheduleWakeup(args.maxTickSec, "agent-chat next tick");
    console.error(`[loop-driver] ${r.pending} pending + ${r.stuck} stuck; scheduled next tick in ${args.maxTickSec}s.`);
  } else {
    console.error(`[loop-driver] no work pending; loop terminated.`);
  }
}

void main();
