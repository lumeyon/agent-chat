// turn.ts — peek/init/take/flip/park/lock/unlock for one edge.
// Usage:
//   bun scripts/turn.ts peek <peer>
//   bun scripts/turn.ts init <peer> <first-writer>
//   bun scripts/turn.ts flip <peer> <next-writer-or-parked>
//   bun scripts/turn.ts park <peer>
//   bun scripts/turn.ts lock <peer>
//   bun scripts/turn.ts unlock <peer>
//
// Identity comes from env or ./.agent-name (see lib.ts).
// "<peer>" is the neighbor agent name; the edge id is derived alphabetically.

import * as fs from "node:fs";
import * as os from "node:os";
import {
  loadTopology, resolveIdentity, edgesOf, ensureEdgeFiles,
  readTurn, writeTurnAtomic, utcStamp,
  processTag, parseLockFile, pidIsAlive,
} from "./lib.ts";

function die(msg: string): never { console.error(msg); process.exit(2); }

const [op, peer, arg3] = process.argv.slice(2);
if (!op || !peer) die("usage: turn.ts <peek|init|flip|park|lock|unlock> <peer> [<value>]");

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);
const edge = edges.find((e) => e.peer === peer);
if (!edge) die(`${peer} is not a neighbor of ${id.name} in topology ${id.topology}`);
const participants: [string, string] = [id.name, peer].sort() as [string, string];

switch (op) {
  case "peek": {
    const v = readTurn(edge.turn);
    const lockExists = fs.existsSync(edge.lock);
    console.log(`edge:        ${edge.id}`);
    console.log(`turn:        ${v ?? "(uninitialized)"}`);
    console.log(`lock:        ${lockExists ? fs.readFileSync(edge.lock, "utf8").trim() : "(none)"}`);
    console.log(`convo:       ${edge.convo}`);
    break;
  }
  case "init": {
    const first = arg3;
    if (!first) die("usage: turn.ts init <peer> <first-writer>");
    if (!participants.includes(first)) die(`first writer must be one of ${participants.join(", ")}`);
    ensureEdgeFiles(edge, participants);
    if (readTurn(edge.turn) !== null) die(`edge ${edge.id} already initialized — use flip`);
    writeTurnAtomic(edge.turn, first);
    console.log(`initialized ${edge.id}, turn=${first}`);
    break;
  }
  case "flip": {
    const next = arg3;
    if (!next) die("usage: turn.ts flip <peer> <next-writer|parked>");
    const cur = readTurn(edge.turn);
    if (cur !== id.name) die(`refuse to flip — turn is "${cur}", not "${id.name}"`);
    if (next !== "parked" && !participants.includes(next)) {
      die(`next must be parked or one of ${participants.join(", ")}`);
    }
    // The lock is advisory: it marks "I'm doing the append+flip atomically".
    // Refuse only if the lock is held by a DIFFERENT agent (i.e. someone is
    // writing right now). The current writer holding their OWN lock is the
    // expected case in the documented lock → append → flip → unlock sequence.
    if (fs.existsSync(edge.lock)) {
      const lk = parseLockFile(edge.lock);
      if (lk && lk.agent !== id.name) {
        die(`refuse to flip — edge ${edge.id} is locked by ${lk.agent}@${lk.host}:${lk.pid}, not me (${id.name}).`);
      }
      // Same-agent lock: proceed. (turn-holder check above already restricts
      // who can call flip; same-agent + same-turn-holder means the writer
      // is mid-sequence, which is fine.)
    }
    writeTurnAtomic(edge.turn, next);
    console.log(`flipped ${edge.id}: ${cur} → ${next}`);
    break;
  }
  case "park": {
    const cur = readTurn(edge.turn);
    if (cur !== id.name) die(`refuse to park — turn is "${cur}", not "${id.name}"`);
    // Same advisory-lock logic as flip: allow if my own lock, refuse if held
    // by a different agent.
    if (fs.existsSync(edge.lock)) {
      const lk = parseLockFile(edge.lock);
      if (lk && lk.agent !== id.name) {
        die(`refuse to park — edge ${edge.id} is locked by ${lk.agent}@${lk.host}:${lk.pid}, not me (${id.name}).`);
      }
    }
    writeTurnAtomic(edge.turn, "parked");
    console.log(`parked ${edge.id}`);
    break;
  }
  case "lock": {
    if (fs.existsSync(edge.lock)) die(`already locked: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
    // Lock body: "<agent>@<host>:<pid> <utc-ts>". The host:pid lets us tell
    // two `orion` sessions apart on the same host and detect dead-pid locks.
    fs.writeFileSync(edge.lock, `${processTag(id.name)} ${utcStamp()}\n`);
    console.log(`locked ${edge.id} (${processTag(id.name)})`);
    break;
  }
  case "unlock": {
    if (!fs.existsSync(edge.lock)) { console.log(`${edge.id} not locked`); break; }
    const lk = parseLockFile(edge.lock);
    if (!lk) {
      // Malformed lock — surface for inspection rather than silently breaking.
      // The user can clear it manually if they confirm it's stale.
      die(`refuse to unlock — lock file does not match agent@host:pid format: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
    }
    if (lk.agent !== id.name) {
      die(`refuse to unlock — lock owned by ${lk.agent}, not ${id.name}`);
    }
    // Cross-host: refuse. Locks are per-host file presence; another machine
    // would have its own filesystem state.
    if (lk.host !== os.hostname()) {
      die(`refuse to unlock — lock held by ${lk.agent}@${lk.host}:${lk.pid} on a different host (I am on ${os.hostname()}).`);
    }
    // Same agent name + same host + the lock-holder pid is still alive AND
    // is not us → that's the two-sessions-with-same-name misconfiguration.
    // Refuse so we don't release another live session's lock. If the pid is
    // dead (e.g. we just lock-then-unlock in two separate bun invocations,
    // or a previous session crashed), allow the unlock.
    if (lk.pid !== process.pid && pidIsAlive(lk.pid)) {
      die(
        `refuse to unlock — lock held by another live process ${lk.agent}@${lk.host}:${lk.pid}, I am pid ${process.pid}. ` +
        `Two sessions sharing the same agent name? Check $AGENT_NAME in each shell with \`bun scripts/resolve.ts --whoami\`.`,
      );
    }
    fs.unlinkSync(edge.lock);
    console.log(`unlocked ${edge.id}`);
    break;
  }
  default:
    die(`unknown op: ${op}`);
}
