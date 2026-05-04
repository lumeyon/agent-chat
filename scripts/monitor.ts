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
//   bun scripts/monitor.ts --no-parked-startup               suppress the parked branch of the
//                                                           startup-pending pass. Default keeps
//                                                           the topology-snapshot behavior on (one
//                                                           line per parked edge at init); the flag
//                                                           is for noise-sensitive deployments
//                                                           (e.g. the org topology where humans
//                                                           have degree 11 and an init can fire 11
//                                                           parked-startup lines on every cycle —
//                                                           sentinel S-HIGH-1 round-3 closeout).

import * as fs from "node:fs";
import * as path from "node:path";
import { loadTopology, resolveIdentity, edgesOf, readTurn, parseLockFile, processIsOriginal } from "./lib.ts";
import {
  readHeartbeatRecord, STUCK_TURN_TIMEOUT_MS, HEARTBEAT_STALE_MS,
  HEARTBEATS_DIR,
  type StuckReason,
} from "./liveness.ts";

function parseArgs(argv: string[]) {
  const a = {
    interval: 2,
    once: false,
    archiveHint: false,
    archiveThreshold: 200,
    staleLockSec: 30,           // seconds a lock can be held before we suspect the holder is dead
    noParkedStartup: false,     // suppress parked branch of startup-pending pass (degree-11 noise floor)
    // Round 13 slice 2 — stuck-turn detector.
    // Defaults inherit from scripts/liveness.ts so the env-var precedence
    // chain stays in one place; per-invocation flag overrides the env.
    stuckTurnTimeoutMs: STUCK_TURN_TIMEOUT_MS,    // default 300_000 (5 min)
    heartbeatStaleMs: HEARTBEAT_STALE_MS,         // default 90_000 (3 missed 30s ticks)
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") a.interval = Math.max(1, parseInt(argv[++i] ?? "2", 10));
    else if (argv[i] === "--once") a.once = true;
    else if (argv[i] === "--archive-hint") a.archiveHint = true;
    else if (argv[i] === "--archive-threshold") a.archiveThreshold = Math.max(50, parseInt(argv[++i] ?? "200", 10));
    else if (argv[i] === "--stale-lock-sec") a.staleLockSec = Math.max(1, parseInt(argv[++i] ?? "30", 10));
    else if (argv[i] === "--no-parked-startup") a.noParkedStartup = true;
    else if (argv[i] === "--stuck-turn-timeout-ms") a.stuckTurnTimeoutMs = Math.max(1000, parseInt(argv[++i] ?? "300000", 10));
    else if (argv[i] === "--heartbeat-stale-ms") a.heartbeatStaleMs = Math.max(1000, parseInt(argv[++i] ?? "90000", 10));
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
  // Round 12 slice 2: track whether we've emitted the fts-corrupt
  // notification for this edge's current sentinel-file presence. One-shot
  // per detect; clears when the sentinel disappears (post `doctor
  // --rebuild-fts`). Sentinel's silence-≠-success additive — degraded
  // search is no longer indistinguishable from a clean search with no hits.
  ftsCorruptEmitted: boolean;
  // Round 13 slice 2: stuck-turn detector. One-shot ratelimit per condition;
  // flag clears (re-arms) when the condition itself clears (heartbeat
  // freshens, turn flips, lock taken, CONVO.md grows). The Round-12 hang
  // case orion himself exhibited maps to `stuckOnOwnTurnEmitted`.
  peerSidecarDeadEmitted: boolean;
  localSidecarDeadEmitted: boolean;
  stuckOnOwnTurnEmitted: boolean;
};
const state = new Map<string, EdgeState>();
for (const e of edges) state.set(e.id, { turn: null, turnMtime: 0, convoMtime: 0, archiveHinted: false, lockSince: 0, lockStaleEmitted: false, ftsCorruptEmitted: false, peerSidecarDeadEmitted: false, localSidecarDeadEmitted: false, stuckOnOwnTurnEmitted: false });

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
    ftsCorruptEmitted: false,
    peerSidecarDeadEmitted: false,
    localSidecarDeadEmitted: false,
    stuckOnOwnTurnEmitted: false,
  });
}

// Startup-pending pass: if the prime captured an edge already pointing at
// us (turn=me) or already parked, the steady-state tick will never see a
// transition and we'd never notify ourselves about the pending floor. Emit
// once per edge that's actionable AT STARTUP (sentinel S-HIGH-1). Distinct
// reason tag (`startup-pending`) so consumers can grep-distinguish.
//
// The parked branch is opt-out via --no-parked-startup. Sentinel's original
// HIGH-1 spec emitted only for turn=me; the broader behavior was kept by
// default because the topology-snapshot at restart is genuinely useful at
// petersen degree=3. At org-topology degree=11 (humans) the noise scales
// linearly and starts to dominate, so noise-sensitive deployments pass the
// flag. (Round-3 closeout, item 1 of 7.)
for (const e of edges) {
  const cur = state.get(e.id)!;
  const lockHeld = fs.existsSync(e.lock);
  const turnIsMe = cur.turn === id.name;
  const turnParked = cur.turn === "parked";
  const shouldEmit = !lockHeld && (turnIsMe || (turnParked && !args.noParkedStartup));
  if (shouldEmit) {
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
      ftsCorruptEmitted: prev.ftsCorruptEmitted,
      peerSidecarDeadEmitted: prev.peerSidecarDeadEmitted,
      localSidecarDeadEmitted: prev.localSidecarDeadEmitted,
      stuckOnOwnTurnEmitted: prev.stuckOnOwnTurnEmitted,
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

    // Round 12 slice 2: `.fts-corrupt` sentinel detection. fts.ts writes
    // the sentinel file to `<edge.dir>/.fts-corrupt` when SQLITE_CORRUPT
    // surfaces during a write or integrity_check. Emit a one-shot
    // notification so degraded search is visible (sentinel's
    // silence-≠-success additive). Auto-clears when the sentinel
    // disappears post `archive.ts doctor --rebuild-fts`.
    const ftsCorruptPath = path.join(e.dir, ".fts-corrupt");
    const ftsCorruptNow = fs.existsSync(ftsCorruptPath);
    if (ftsCorruptNow && !cur.ftsCorruptEmitted) {
      console.log(`${now} edge=${e.id} peer=${e.peer} fts-corrupt — search degraded for this edge until \`bun scripts/archive.ts doctor --rebuild-fts ${e.peer}\``);
      cur.ftsCorruptEmitted = true;
    } else if (!ftsCorruptNow && cur.ftsCorruptEmitted) {
      cur.ftsCorruptEmitted = false; // re-arm after recovery
    }

    // Round 13 slice 2: stuck-turn detector. Three conditions, each
    // ratelimited to one emit per arm. Re-arms when the condition clears
    // (heartbeat freshens, turn flips, lock taken, CONVO.md grows).
    //
    // Heartbeat reads come from `<conversations>/.heartbeats/<agent>.heartbeat`
    // (lumeyon's slice-1 contract). readHeartbeatRecord returns status
    // `'fresh' | 'stale' | 'dead' | 'unparseable' | 'missing'`; we treat
    // anything other than 'fresh' as "no signal of life" — BUT ONLY when
    // the heartbeat system is actually deployed. If HEARTBEATS_DIR doesn't
    // exist OR is empty, we're running pre-lumeyon-slice-1 code and the
    // expected absence of heartbeat files is NOT a stuck signal. This
    // gate keeps the detector hermetic in tests and graceful-degrades on
    // older deployments.
    //
    // Note: heartbeat checks intentionally fire INDEPENDENTLY of lockHeld.
    // A peer holding a lock with a dead sidecar is still stuck — the
    // existing lock-stale detector catches the orphan-lock case but not
    // the "lock-free turn=peer + dead sidecar" case this branch handles.
    let heartbeatSystemActive = false;
    try {
      heartbeatSystemActive = fs.existsSync(HEARTBEATS_DIR)
        && fs.readdirSync(HEARTBEATS_DIR).some((f) => f.endsWith(".heartbeat"));
    } catch { heartbeatSystemActive = false; }

    if (heartbeatSystemActive && cur.turn === e.peer) {
      const peerHb = readHeartbeatRecord(e.peer, nowMs);
      const peerHbAlive = peerHb.status === "fresh";
      if (!peerHbAlive && !cur.peerSidecarDeadEmitted) {
        const ageStr = peerHb.ageMs != null ? `${Math.round(peerHb.ageMs / 1000)}s` : "n/a";
        console.log(`${now} edge=${e.id} peer=${e.peer} stuck=peer-sidecar-dead heartbeat_age=${ageStr} status=${peerHb.status} — peer's sidecar appears dead; their turn won't progress without manual intervention`);
        cur.peerSidecarDeadEmitted = true;
      } else if (peerHbAlive) {
        // FUTURE: re-arm not exercised in --once mode (each invocation is a
        // fresh process so the in-memory boolean doesn't carry across runs).
        // tests/monitor-liveness.test.ts test #4 demonstrates fresh-process
        // behavior; full re-arm coverage needs an in-process tick driver.
        // Tracked for Round-14. (Round-13 Phase-4 keystone→carina CONCERN #2.)
        cur.peerSidecarDeadEmitted = false;  // re-arm
      }
    } else {
      cur.peerSidecarDeadEmitted = false;     // re-arm if turn moved off peer or heartbeat system not deployed
    }

    // local-sidecar-dead: heartbeat-gated (only when heartbeat system is deployed).
    if (heartbeatSystemActive && cur.turn === id.name) {
      const ownHb = readHeartbeatRecord(id.name, nowMs);
      const ownHbAlive = ownHb.status === "fresh";
      if (!ownHbAlive && !cur.localSidecarDeadEmitted) {
        const ageStr = ownHb.ageMs != null ? `${Math.round(ownHb.ageMs / 1000)}s` : "n/a";
        console.log(`${now} edge=${e.id} peer=${e.peer} stuck=local-sidecar-dead heartbeat_age=${ageStr} status=${ownHb.status} — my own sidecar's heartbeat is stale; \`agent-chat exit\` + \`init\` recommended`);
        cur.localSidecarDeadEmitted = true;
      } else if (ownHbAlive) {
        cur.localSidecarDeadEmitted = false;  // re-arm
      }
    } else {
      cur.localSidecarDeadEmitted = false;  // re-arm if turn moved off me OR heartbeat system not deployed
    }

    // agent-stuck-on-own-turn: NOT heartbeat-gated. This is the Round-12 hang
    // case (orion himself) — turn=me, no lock, no recent CONVO growth, turn-
    // mtime older than the stuck threshold. Fires independently of whether
    // lumeyon's heartbeat-writer has shipped, since the signal is purely
    // about turn-progress, not sidecar liveness.
    if (cur.turn === id.name) {
      const turnAgeMs = cur.turnMtime > 0 ? nowMs - cur.turnMtime : 0;
      const recentConvoGrowth = cur.convoMtime > 0 && (nowMs - cur.convoMtime) < args.stuckTurnTimeoutMs;
      // Round-13 Phase-4 keystone→carina CONCERN #1: bare `lockHeld` (file
      // presence) suppresses agent-stuck-on-own-turn whenever a stale lock
      // from a dead session is around — the OPPOSITE of progress, and
      // exactly the failure mode lumeyon exhibited at 02:02Z. Mirror the
      // lock-stale detector at line 206-208: parse the lock body and
      // verify the holder is a live original process. Conservative on
      // unparseable lock bodies (treat as live; don't false-emit on every
      // malformed lock file in the wild).
      let lockHeldByLiveSession = false;
      if (lockHeld) {
        const lk = parseLockFile(e.lock);
        lockHeldByLiveSession = lk ? processIsOriginal(lk.pid, lk.starttime) : true;
      }
      const isStuckOnOwn = turnAgeMs > args.stuckTurnTimeoutMs && !lockHeldByLiveSession && !recentConvoGrowth;
      if (isStuckOnOwn && !cur.stuckOnOwnTurnEmitted) {
        console.log(`${now} edge=${e.id} peer=${e.peer} stuck=agent-stuck-on-own-turn turn_age_s=${Math.round(turnAgeMs / 1000)} timeout_s=${Math.round(args.stuckTurnTimeoutMs / 1000)} — turn has been on me for >${Math.round(args.stuckTurnTimeoutMs / 1000)}s with no progress (no lock, no CONVO.md growth)`);
        cur.stuckOnOwnTurnEmitted = true;
      } else if (!isStuckOnOwn) {
        cur.stuckOnOwnTurnEmitted = false;  // re-arm on any progress signal
      }
    } else {
      cur.stuckOnOwnTurnEmitted = false;  // re-arm if turn moved off me
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
      const merged = {
        ...prev,
        lockSince: cur.lockSince,
        lockStaleEmitted: cur.lockStaleEmitted,
        ftsCorruptEmitted: cur.ftsCorruptEmitted,
        peerSidecarDeadEmitted: cur.peerSidecarDeadEmitted,
        localSidecarDeadEmitted: cur.localSidecarDeadEmitted,
        stuckOnOwnTurnEmitted: cur.stuckOnOwnTurnEmitted,
      };
      state.set(e.id, merged);
    }
  }
}

if (args.once) {
  tick();
  process.exit(0);
}

setInterval(tick, args.interval * 1000);
