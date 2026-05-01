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
  processTag, lockTag, parseLockFile, pidIsAlive, processIsOriginal,
  stableSessionPid, pidStarttime,
  exclusiveWriteOrFail,
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
    refuseIfLockBelongsToAnotherSession(edge, id.name, "flip");
    writeTurnAtomic(edge.turn, next);
    console.log(`flipped ${edge.id}: ${cur} → ${next}`);
    break;
  }
  case "park": {
    const cur = readTurn(edge.turn);
    if (cur !== id.name) die(`refuse to park — turn is "${cur}", not "${id.name}"`);
    refuseIfLockBelongsToAnotherSession(edge, id.name, "park");
    writeTurnAtomic(edge.turn, "parked");
    console.log(`parked ${edge.id}`);
    break;
  }
  case "lock": {
    // Protocol invariant: only the current floor-holder may take the lock.
    // Without this, a non-holding peer could squat the lock and freeze the
    // floor — flip would then refuse "lock held by other agent" and the
    // edge would deadlock until --force-stale (lumeyon P2). Uninitialized
    // turn (`null`) is exempt so `init` can lock + write the first section.
    const cur = readTurn(edge.turn);
    if (cur !== null && cur !== id.name) {
      die(`refuse to lock — turn is "${cur}", not "${id.name}". Only the floor-holder can lock.`);
    }
    // Use exclusive-create open so two concurrent `lock` calls cannot both
    // succeed. The lock body now embeds starttime so an unlock/flip/park can
    // distinguish "my own lock" from "another session of the same agent
    // name" even if pids happen to match (pid-recycling).
    const body = `${lockTag(id.name)} ${utcStamp()}\n`;
    const myStablePid = stableSessionPid();
    const myStarttime = pidStarttime(myStablePid);
    try {
      exclusiveWriteOrFail(edge.lock, body);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      const lk = parseLockFile(edge.lock);
      // Idempotent re-lock: the same agent SESSION already holds it.
      // Match on agent + host + same stable pid + matching starttime
      // fingerprint (when available). starttime mismatch with same pid
      // is the pid-recycling signal — fall through to the stale path.
      if (
        lk && lk.agent === id.name && lk.host === os.hostname() &&
        lk.pid === myStablePid &&
        (lk.starttime == null || myStarttime == null || lk.starttime === myStarttime)
      ) {
        console.log(`already locked by me (${edge.id})`);
        break;
      }
      // Stale lock from a dead-or-recycled session of the same agent.
      if (lk && !processIsOriginal(lk.pid, lk.starttime)) {
        die(
          `refuse to lock — edge ${edge.id} has stale lock from ${lk.agent}@${lk.host}:${lk.pid} (session is gone or pid was recycled). ` +
          `Run \`turn.ts unlock ${peer} --force-stale\` to clear it, then retry.`,
        );
      }
      const who = lk ? `${lk.agent}@${lk.host}:${lk.pid}` : "(unparsable lock)";
      die(`refuse to lock — edge ${edge.id} already locked by ${who}.`);
    }
    console.log(`locked ${edge.id} (${lockTag(id.name)})`);
    break;
  }
  case "unlock": {
    if (!fs.existsSync(edge.lock)) { console.log(`${edge.id} not locked`); break; }
    const forceStale = arg3 === "--force-stale" || (process.argv.slice(2).includes("--force-stale"));
    const lk = parseLockFile(edge.lock);
    if (!lk) {
      // Malformed lock — surface for inspection rather than silently breaking.
      // --force-stale lets the user clear it after confirming it's bad.
      if (forceStale) {
        fs.unlinkSync(edge.lock);
        console.log(`force-stale unlocked ${edge.id} (lock file was unparsable)`);
        break;
      }
      die(`refuse to unlock — lock file does not match agent@host:pid format: ${fs.readFileSync(edge.lock, "utf8").trim()}`);
    }
    // --force-stale: only honored if the recorded pid is genuinely dead OR
    // recycled to a different process. processIsOriginal returns false in
    // both cases — that's what makes "stale" meaningful.
    if (forceStale) {
      if (processIsOriginal(lk.pid, lk.starttime) && lk.pid !== process.pid) {
        die(`--force-stale refused — lock holder ${lk.agent}@${lk.host}:${lk.pid} is still alive.`);
      }
      fs.unlinkSync(edge.lock);
      console.log(`force-stale unlocked ${edge.id} (was held by ${lk.agent}@${lk.host}:${lk.pid}, pid gone or recycled)`);
      break;
    }
    if (lk.agent !== id.name) {
      die(`refuse to unlock — lock owned by ${lk.agent}, not ${id.name}`);
    }
    // Cross-host: refuse. Locks are per-host file presence; another machine
    // would have its own filesystem state.
    if (lk.host !== os.hostname()) {
      die(`refuse to unlock — lock held by ${lk.agent}@${lk.host}:${lk.pid} on a different host (I am on ${os.hostname()}).`);
    }
    // Same agent name + same host + the lock-holder belongs to a DIFFERENT
    // live session → that's the two-sessions-with-same-name misconfig.
    // Refuse so we don't release another live session's lock. The
    // lock-holder is "us" iff its recorded pid equals our stableSessionPid
    // AND its starttime fingerprint matches (when both are available). If
    // the recorded pid is dead-or-recycled, allow the unlock.
    const myStablePid = stableSessionPid();
    const myStarttime = pidStarttime(myStablePid);
    const isSameSession =
      lk.pid === myStablePid &&
      (lk.starttime == null || myStarttime == null || lk.starttime === myStarttime);
    if (!isSameSession && processIsOriginal(lk.pid, lk.starttime)) {
      die(
        `refuse to unlock — lock held by another live session ${lk.agent}@${lk.host}:${lk.pid}, I am session ${myStablePid}. ` +
        `Two sessions sharing the same agent name? Check identity in each shell with \`bun scripts/resolve.ts --whoami\`.`,
      );
    }
    fs.unlinkSync(edge.lock);
    console.log(`unlocked ${edge.id}`);
    break;
  }
  default:
    die(`unknown op: ${op}`);
}

// Helper: refuse flip/park if the lock is held by another agent OR by
// another live session of the same agent name. Mirrors `unlock`'s
// turn.ts:169 defense to make the lock-aliveness signal symmetric across
// all four ops (lock, unlock, flip, park) — lumeyon P1.
function refuseIfLockBelongsToAnotherSession(
  edge: { id: string; lock: string },
  myName: string,
  op: "flip" | "park",
): void {
  if (!fs.existsSync(edge.lock)) return;
  const lk = parseLockFile(edge.lock);
  if (!lk) return; // unparseable — let the writer proceed; stale-lock notification handles it
  if (lk.agent !== myName) {
    die(`refuse to ${op} — edge ${edge.id} is locked by ${lk.agent}@${lk.host}:${lk.pid}, not me (${myName}).`);
  }
  // Same agent name. Check it's actually MY session (pid + starttime).
  const myStablePid = stableSessionPid();
  const myStarttime = pidStarttime(myStablePid);
  const isSameSession =
    lk.pid === myStablePid &&
    (lk.starttime == null || myStarttime == null || lk.starttime === myStarttime);
  if (!isSameSession && processIsOriginal(lk.pid, lk.starttime)) {
    die(
      `refuse to ${op} — edge ${edge.id} is locked by another live session of "${myName}" ` +
      `(${lk.agent}@${lk.host}:${lk.pid}); I am session ${myStablePid}. Two sessions sharing this agent name?`,
    );
  }
  // Either same session OR the lock is stale (dead/recycled pid). Proceed.
}
