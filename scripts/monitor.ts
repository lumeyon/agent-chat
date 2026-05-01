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
import { loadTopology, resolveIdentity, edgesOf, readTurn } from "./lib.ts";

function parseArgs(argv: string[]) {
  const a = {
    interval: 2,
    once: false,
    archiveHint: false,
    archiveThreshold: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") a.interval = Math.max(1, parseInt(argv[++i] ?? "2", 10));
    else if (argv[i] === "--once") a.once = true;
    else if (argv[i] === "--archive-hint") a.archiveHint = true;
    else if (argv[i] === "--archive-threshold") a.archiveThreshold = Math.max(50, parseInt(argv[++i] ?? "200", 10));
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

type EdgeState = { turn: string | null; turnMtime: number; convoMtime: number; archiveHinted: boolean };
const state = new Map<string, EdgeState>();
for (const e of edges) state.set(e.id, { turn: null, turnMtime: 0, convoMtime: 0, archiveHinted: false });

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
  });
}

function tick() {
  const now = new Date().toISOString();
  for (const e of edges) {
    const prev = state.get(e.id)!;
    const cur: EdgeState = {
      turn: readTurn(e.turn),
      turnMtime: mtime(e.turn),
      convoMtime: mtime(e.convo),
      archiveHinted: prev.archiveHinted,
    };
    const lockHeld = fs.existsSync(e.lock);
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

    state.set(e.id, cur);
  }
}

if (args.once) {
  tick();
  process.exit(0);
}

setInterval(tick, args.interval * 1000);
