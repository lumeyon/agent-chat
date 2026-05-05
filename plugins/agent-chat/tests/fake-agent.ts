// fake-agent.ts — deterministic protocol simulator. Plays one named agent
// on one edge, taking turns mechanically. No LLM calls, no chat — just the
// turn dance, so tests can drive two of these as separate OS processes
// against a shared conversations directory and verify the protocol holds.
//
// Usage:
//   bun fake-agent.ts <name> <peer> <rounds> [--first <agent>]
//
// $CLAUDE_SESSION_ID and $AGENT_CHAT_CONVERSATIONS_DIR must be set by the
// caller (the test harness). Identity comes from the session file written
// by `agent-chat init`, which the test harness runs before spawning us.
//
// Algorithm:
//   loop until rounds exhausted:
//     read .turn
//     if it's my name: lock, append, flip to peer (or park on last round), unlock
//     if it's parked or peer's: short sleep, retry
//     if uninitialized and I'm --first: init, then continue
//   exit 0 on success, 2 on timeout
//
// On the LAST round the *responder* parks the conversation; the first
// writer always flips. That guarantees both agents write exactly `rounds`
// sections (2*rounds total). Both then exit cleanly when they observe
// either parked or their own last completed round.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTopology, resolveIdentity, edgesOf, readTurn, writeTurnAtomic,
  ensureEdgeFiles, processTag, utcStamp,
} from "../scripts/lib.ts";

function die(msg: string, code = 2): never { console.error(`[fake-agent] ${msg}`); process.exit(code); }

const argv = process.argv.slice(2);
if (argv.length < 3) die("usage: fake-agent.ts <name> <peer> <rounds> [--first <agent>]");
const [, , roundsStr] = argv;
const _name = argv[0];
const peer = argv[1];
const totalRounds = parseInt(roundsStr, 10);
const firstIdx = argv.indexOf("--first");
const firstWriter = firstIdx >= 0 ? argv[firstIdx + 1] : null;

if (!Number.isFinite(totalRounds) || totalRounds < 1) die("rounds must be >= 1");

const id = resolveIdentity();
if (id.name !== _name) die(`identity mismatch: resolved as ${id.name}, asked to play ${_name}. ` +
  `Did the test harness call \`agent-chat init ${_name}\` first with the right CLAUDE_SESSION_ID?`);

const topo = loadTopology(id.topology);
const edge = edgesOf(topo, id.name).find((e) => e.peer === peer);
if (!edge) die(`${peer} is not a neighbor of ${id.name}`);
const participants: [string, string] = [id.name, peer].sort() as [string, string];

ensureEdgeFiles(edge, participants);

// Initialize the edge if we're the designated first writer and it doesn't exist.
if (firstWriter && readTurn(edge.turn) === null) {
  if (!participants.includes(firstWriter)) die(`first writer ${firstWriter} not in ${participants}`);
  writeTurnAtomic(edge.turn, firstWriter);
}

const POLL_MS = 50;
const TIMEOUT_MS = 30_000;
const startedAt = Date.now();
let myRoundsTaken = 0;

console.log(`[fake-agent] ${id.name} starting; will take up to ${totalRounds} round(s) on edge ${edge.id}`);

// Only the responder parks on its last round. The first writer always
// flips, so the responder gets to write its full quota before parking.
const isFirstWriter = firstWriter === id.name;

function append(turnNumber: number, willPark: boolean) {
  const block = [
    "",
    "---",
    "",
    `## ${id.name} — fake-agent round ${turnNumber} (UTC ${utcStamp()})`,
    "",
    `body from ${id.name}, round ${turnNumber} of ${totalRounds} total`,
    "",
    `tag: ${processTag(id.name)}`,
    "",
    willPark ? "→ END" : `→ ${peer}`,
  ].join("\n");
  fs.appendFileSync(edge.convo, block + "\n");
}

function takeTurn(): { stopped: boolean; reachedQuota: boolean } {
  if (fs.existsSync(edge.lock)) return { stopped: false, reachedQuota: false };
  fs.writeFileSync(edge.lock, `${processTag(id.name)} ${utcStamp()}\n`);
  try {
    myRoundsTaken++;
    const reachedQuota = myRoundsTaken === totalRounds;
    const willPark = reachedQuota && !isFirstWriter;
    append(myRoundsTaken, willPark);
    const next = willPark ? "parked" : peer;
    writeTurnAtomic(edge.turn, next);
    return { stopped: willPark, reachedQuota };
  } finally {
    try { fs.unlinkSync(edge.lock); } catch {}
  }
}

(async () => {
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const cur = readTurn(edge.turn);
    if (cur === id.name) {
      const { stopped, reachedQuota } = takeTurn();
      if (stopped) {
        console.log(`[fake-agent] ${id.name} parked after ${myRoundsTaken} round(s); exiting.`);
        process.exit(0);
      }
      // First writer hit its quota: it just flipped to peer for the
      // peer's final round. Wait until peer parks, then exit.
      if (reachedQuota && isFirstWriter) {
        // Loop falls through; next iteration will see parked and exit.
      }
    } else if (cur === "parked") {
      console.log(`[fake-agent] ${id.name} sees parked after ${myRoundsTaken} round(s); exiting.`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.error(`[fake-agent] ${id.name} timed out after ${TIMEOUT_MS}ms (took ${myRoundsTaken} rounds)`);
  process.exit(2);
})();
