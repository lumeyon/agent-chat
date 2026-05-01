// monitor.ts — watch every edge this agent participates in and emit one stdout
// line each time .turn transitions to "<self>" or "parked", or when CONVO.md
// grows or .turn is rewritten to the same value (codex-chat-style triple-trigger).
//
// Designed to be handed to the Monitor tool with persistent: true. Each stdout
// line becomes a chat notification.
//
// Usage:
//   bun scripts/monitor.ts                                  defaults from env or ./.agent-name
//   bun scripts/monitor.ts --interval 2                     poll every 2s; default 2
//   bun scripts/monitor.ts --once                           single pass, no loop — for testing
//   bun scripts/monitor.ts --archive-hint                   also emit one-shot suggestions to
//                                                           archive parked edges whose CONVO.md
//                                                           exceeds --archive-threshold lines.
//                                                           Off by default to keep notifications
//                                                           focused on .turn flips.
//   bun scripts/monitor.ts --archive-threshold 200          line count above which the hint fires

import * as fs from "node:fs";
import * as path from "node:path";
import { loadTopology, resolveIdentity, edgesOf, readTurn, parseLockFile, processIsOriginal } from "./lib.ts";

function parseArgs(argv: string[]) {
  const a = {
    interval: 2,
    once: false,
    archiveHint: false,
    archiveThreshold: 200,
    staleLockSec: 30,           // seconds a lock can be held before we suspect the holder is dead
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") a.interval = Math.max(1, parseInt(argv[++i] ?? "2", 10));
    else if (argv[i] === "--once") a.once = true;
    else if (argv[i] === "--archive-hint") a.archiveHint = true;
    else if (argv[i] === "--archive-threshold") a.archiveThreshold = Math.max(50, parseInt(argv[++i] ?? "200", 10));
    else if (argv[i] === "--stale-lock-sec") a.staleLockSec = Math.max(1, parseInt(argv[++i] ?? "30", 10));
  }
  return a;
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

const args = parseArgs(process.argv.slice(2));
const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);

console.error(`[monitor] ${id.name}@${id.topology} watching ${edges.length} edge(s): ${edges.map(e => e.id).join(", ")}`);

type EdgeState = {
  turn: string | null;
  turnMtime: number;
  convoMtime: number;
  archiveHinted: boolean;
  // lockSince: ms-epoch when we first observed the lock present. Lets us
  // emit lock-stale notifications when a peer crashes mid-sequence and
  // their lock would otherwise sit silently forever (sentinel S-HIGH-2).
  lockSince: number;
  lockStaleEmitted: boolean;
};
const state = new Map<string, EdgeState>();
for (const e of edges) state.set(e.id, { turn: null, turnMtime: 0, convoMtime: 0, archiveHinted: false, lockSince: 0, lockStaleEmitted: false });

function convoLineCount(p: string): number {
  try { return fs.readFileSync(p, "utf8").split(/\n/).length; } catch { return 0; }
}

// Prime initial state silently — we only emit on transitions, not first observation.
for (const e of edges) {
  state.set(e.id, {
    turn: readTurn(e.turn),
    turnMtime: mtime(e.turn),
    convoMtime: mtime(e.convo),
    archiveHinted: false,
    lockSince: fs.existsSync(e.lock) ? Date.now() : 0,
    lockStaleEmitted: false,
  });
}

// Startup-pending pass: if the prime captured an edge already pointing at
// us (turn=me) or already parked, the steady-state tick will never see a
// transition and we'd never notify ourselves about the pending floor. Emit
// once per edge that's actionable AT STARTUP (sentinel S-HIGH-1). Distinct
// reason tag (`startup-pending`) so consumers can grep-distinguish.
for (const e of edges) {
  const cur = state.get(e.id)!;
  const lockHeld = fs.existsSync(e.lock);
  if (!lockHeld && (cur.turn === id.name || cur.turn === "parked")) {
    const now = new Date().toISOString();
    console.log(`${now} edge=${e.id} peer=${e.peer} .turn=${cur.turn} startup-pending — re-read ${e.convo}`);
  }
}

function tick() {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  for (const e of edges) {
    const prev = state.get(e.id)!;
    const cur: EdgeState = {
      turn: readTurn(e.turn),
      turnMtime: mtime(e.turn),
      convoMtime: mtime(e.convo),
      archiveHinted: prev.archiveHinted,
      lockSince: prev.lockSince,
      lockStaleEmitted: prev.lockStaleEmitted,
    };
    const lockHeld = fs.existsSync(e.lock);
    // Track lock lifetime for stale detection (sentinel S-HIGH-2).
    if (lockHeld) {
      if (cur.lockSince === 0) cur.lockSince = nowMs;
    } else {
      cur.lockSince = 0;
      cur.lockStaleEmitted = false;
    }
    const valChange = cur.turn !== prev.turn;
    const turnTouched = prev.turnMtime > 0 && cur.turnMtime !== prev.turnMtime;
    const convoGrew = prev.convoMtime > 0 && cur.convoMtime !== prev.convoMtime;

    const interesting = cur.turn === id.name || cur.turn === "parked";
    const fired = !lockHeld && interesting && (valChange || turnTouched || convoGrew);

    if (fired) {
      const why: string[] = [];
      if (valChange) why.push(`value→${cur.turn}`);
      if (turnTouched && !valChange) why.push(".turn-rewritten");
      if (convoGrew) why.push(".md-grew");
      console.log(`${now} edge=${e.id} peer=${e.peer} .turn=${cur.turn} ${why.join(" ")} — re-read ${e.convo}`);
    }

    // Protocol-violation: peer appended to CONVO.md but did NOT flip the
    // turn (still points at them). Receiver gets no actionable notification
    // from the standard path because `interesting` is false. Emit a
    // separate, distinct-tag notification so the receiver at least knows
    // unread content exists (carina Q4a).
    if (
      !lockHeld && convoGrew && !valChange && !turnTouched &&
      cur.turn !== id.name && cur.turn !== "parked" && cur.turn !== null
    ) {
      console.log(`${now} edge=${e.id} peer=${e.peer} .turn=${cur.turn} protocol-violation:peer-appended-without-flip — re-read ${e.convo}`);
    }

    // Stale-lock detection: a peer crashed mid-sequence; their lock is
    // never going to release on its own. Once it's been held longer than
    // the threshold AND the holder's pid is no longer original (dead or
    // recycled), emit a one-shot hint with the --force-stale recovery
    // command (sentinel S-HIGH-2).
    if (lockHeld && !cur.lockStaleEmitted && cur.lockSince > 0) {
      const heldMs = nowMs - cur.lockSince;
      if (heldMs >= args.staleLockSec * 1000) {
        const lk = parseLockFile(e.lock);
        if (lk && !processIsOriginal(lk.pid, lk.starttime)) {
          console.log(`${now} edge=${e.id} peer=${e.peer} lock-stale held=${Math.round(heldMs/1000)}s by=${lk.agent}@${lk.host}:${lk.pid} (pid gone or recycled) — run \`bun scripts/turn.ts unlock ${e.peer} --force-stale\` to clear`);
          cur.lockStaleEmitted = true;
        }
      }
    }

    // Optional archive hint. Fires once per edge (resets when CONVO.md shrinks
    // back under the threshold, e.g. after archive). The hint is a separate
    // notification line and never blocks the .turn flip notifications above.
    if (args.archiveHint && cur.turn === "parked" && !lockHeld) {
      const lc = convoLineCount(e.convo);
      const above = lc >= args.archiveThreshold;
      if (above && !cur.archiveHinted) {
        console.log(`${now} edge=${e.id} peer=${e.peer} archive-hint lines=${lc} (>= ${args.archiveThreshold}) — consider \`bun scripts/archive.ts plan ${e.peer}\``);
        cur.archiveHinted = true;
      } else if (!above && cur.archiveHinted) {
        cur.archiveHinted = false; // re-arm after a shrink (post-archive)
      }
    }

    // Only advance the per-edge state when the lock is NOT held. If we
    // updated `prev` while a peer's lock is still in flight, we'd silently
    // consume the diff: this tick declines to fire because lockHeld=true,
    // and the next tick (after unlock) would see prev==cur with no delta.
    // Holding `prev` across the lock window means the first tick after
    // the lock clears computes (prev=pre-lock) vs (cur=post-unlock) and
    // fires correctly. See tests/monitor.test.ts for the regression.
    // EXCEPTION: lock-aliveness fields (lockSince, lockStaleEmitted) update
    // every tick because they describe the lock state, not the .turn diff.
    if (!lockHeld) state.set(e.id, cur);
    else {
      const merged = { ...prev, lockSince: cur.lockSince, lockStaleEmitted: cur.lockStaleEmitted };
      state.set(e.id, merged);
    }
  }
}

if (args.once) {
  tick();
  process.exit(0);
}

setInterval(tick, args.interval * 1000);
