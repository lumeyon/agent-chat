#!/usr/bin/env bun
// scripts/notify.ts — push-notification watcher for agent-chat edges.
//
// The pre-Round-15d-β architecture had a long-running monitor + sidecar
// that watched .turn files via inotify and emitted stdout notifications
// whenever a peer flipped an edge to "me". That infrastructure was
// deleted with the persistent-mode cleanup; what's left is poll-based
// (ScheduleWakeup) which costs a full API call per check even when
// nothing has changed.
//
// notify.ts restores PUSH notifications without resurrecting the deleted
// sidecar — it's a pure watch loop:
//   - resolves identity (resolveIdentity)
//   - enumerates this agent's edges
//   - fs.watch on each .turn file
//   - emits one stdout line per state transition (peer-flipped-to-me OR
//     peer-parked-edge) in the canonical Monitor-tool format
//   - never writes anywhere; never invokes an LLM; never mutates the wire
//     state. Pure observer.
//
// Intended invocation:
//   bun "$AGENT_CHAT_DIR/scripts/notify.ts"
//   bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" watch    # CLI alias
//
// Inside Claude Code, run via the Monitor tool with persistent: true so
// each emitted line streams into the agent's notification feed:
//   Monitor({
//     command: "bun $AGENT_CHAT_DIR/scripts/notify.ts",
//     persistent: true,
//     description: "agent-chat: push notifications for <my-agent>",
//   })
//
// Exits cleanly on SIGTERM/SIGINT. fs.watch errors are logged + recovered
// with a 5s reconcile-poll fallback so transient FUSE/NFS hiccups don't
// kill the watcher.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveIdentity, loadTopology, edgesOf, readTurn, parseLockFile } from "./lib.ts";

// Reconcile-poll cadence — covers fs.watch gaps (FUSE, NFS, deleted+recreated
// files which can confuse watchers). 5s is a balance: fast enough that a
// missed event isn't load-bearingly invisible; slow enough not to thrash.
const RECONCILE_POLL_MS = 5_000;

// Round-15n: self-flip suppression window. When the watcher observes a
// .turn transition to id.name, we consult the most recent lock-holder
// snapshot for the same edge. If the holder was id.name within this
// window, the transition was self-authored (e.g. authoritative atomic
// rewrite during stale-lock recovery, or normal lock+flip+unlock by a
// concurrent agent-chat run process running as the same agent identity).
// 3 seconds is comfortably wider than the typical flip→unlock latency
// (microseconds in the optimal path; <100ms even on a busy host).
const SELF_FLIP_WINDOW_MS = 3_000;

const id = resolveIdentity();
const topo = loadTopology(id.topology);
const edges = edgesOf(topo, id.name);
if (edges.length === 0) {
  console.error(`[notify] no edges for ${id.name}@${id.topology} — nothing to watch`);
  process.exit(0);
}

console.error(`[notify] watching ${edges.length} edge(s) for ${id.name}@${id.topology}`);
for (const e of edges) console.error(`[notify]   ${e.peer} → ${e.turn}`);

// Track last-known state per edge so fs.watch noise (multiple events per
// rename) is debounced to actual transitions. Round-15n: also track the
// most recent lock-holder snapshot so we can distinguish peer-driven
// flips from self-driven ones (the self-flip suppression bug — when WE
// authoritatively rewrite our own .turn, the watcher pre-fix would emit
// peer-flipped-to-me as if a peer had done it).
type LockSnapshot = { agent: string; pid: number; ts: number };
type EdgeState = { lastTurn: string | null; recentLock: LockSnapshot | null };
const state: Record<string, EdgeState> = {};
for (const e of edges) state[e.peer] = { lastTurn: readTurn(e.turn), recentLock: null };

// Capture initial lock state (in case we start mid-flip with a lock held).
for (const e of edges) {
  const lk = parseLockFile(e.lock);
  if (lk) state[e.peer].recentLock = { agent: lk.agent, pid: lk.pid, ts: Date.now() };
}

function refreshLockSnapshot(peer: string, lockFile: string) {
  const lk = parseLockFile(lockFile);
  if (lk) {
    // Lock just appeared (or changed body) — record who holds it.
    state[peer].recentLock = { agent: lk.agent, pid: lk.pid, ts: Date.now() };
  }
  // On unlock (lockFile vanished), DELIBERATELY keep the snapshot. The
  // SELF_FLIP_WINDOW_MS TTL handles staleness — we want the snapshot to
  // outlive the unlock so a flip-then-unlock-then-watcher-tick sequence
  // can still classify the flip as self-authored.
}

function isSelfFlipWithinWindow(peer: string): boolean {
  const recent = state[peer].recentLock;
  if (!recent) return false;
  if (recent.agent !== id.name) return false;
  return (Date.now() - recent.ts) < SELF_FLIP_WINDOW_MS;
}

function emitTransition(peer: string, before: string | null, after: string | null) {
  if (before === after) return;
  const prefix = `[notify ${new Date().toISOString()}]`;
  if (after === id.name) {
    // Round-15n: suppress peer-flipped-to-me when the recent lock holder
    // was id.name within SELF_FLIP_WINDOW_MS — this was a self-authored
    // flip (atomic-rewrite recovery, or a concurrent agent-chat run
    // process under the same identity). Log my-flip as informational so
    // the audit trail still shows the transition happened.
    if (isSelfFlipWithinWindow(peer)) {
      const ageMs = Date.now() - (state[peer].recentLock!.ts);
      console.log(`${prefix} my-flip peer=${peer} (suppressing peer-flipped-to-me; lock was mine ${ageMs}ms ago)`);
    } else {
      console.log(`${prefix} peer-flipped-to-me peer=${peer}`);
    }
  } else if (after === "parked") {
    console.log(`${prefix} peer-parked peer=${peer}`);
  } else if (after && before === id.name) {
    // Floor handed off (we wrote then flipped). Informational only.
    console.log(`${prefix} my-flip peer=${peer} next=${after}`);
  } else if (after) {
    // Peer's normal flip to themselves or another peer — noise for us,
    // skip to keep the stream signal-rich.
  } else {
    // .turn deleted or unreadable — usually transient.
    console.error(`${prefix} edge-state-cleared peer=${peer}`);
  }
}

function checkEdge(peer: string, turnFile: string) {
  let cur: string | null = null;
  try { cur = readTurn(turnFile); } catch (e: any) {
    if (e?.code !== "ENOENT") console.error(`[notify] read error on ${peer}: ${e?.message ?? e}`);
  }
  const before = state[peer].lastTurn;
  if (cur !== before) {
    state[peer].lastTurn = cur;
    emitTransition(peer, before, cur);
  }
}

// Wire fs.watch per edge directory (NOT per file). Round-15n: watching
// the file directly via inotify-on-inode breaks on rename-replace (the
// atomic .turn.tmp + mv pattern that turn.ts and authoritative rewrites
// both use): the watched inode is gone after the mv, the new file isn't
// watched, no event fires. Watching the parent directory captures all
// create/rename/modify events for any file inside, filtered by basename.
// One watcher per edge directory covers BOTH .turn and .turn.lock.
const watchers: fs.FSWatcher[] = [];
for (const e of edges) {
  const edgeDir = path.dirname(e.turn);
  const turnBase = path.basename(e.turn);
  const lockBase = path.basename(e.lock);
  if (!fs.existsSync(edgeDir)) {
    // Edge directory itself doesn't exist (uninitialized edge with no
    // edge dir created yet). Reconcile-poll covers this.
    console.error(`[notify] cannot watch ${e.peer} yet: edge dir ${edgeDir} does not exist (relying on reconcile-poll)`);
    continue;
  }
  try {
    const w = fs.watch(edgeDir, { persistent: true }, (event, filename) => {
      if (process.env.AGENT_CHAT_NOTIFY_DEBUG === "1") {
        console.error(`[notify-debug] event=${event} file=${filename} edgeDir=${edgeDir}`);
      }
      if (!filename) return;
      const fn = String(filename);
      // Round-15n: Bun's fs.watch on a directory does NOT reliably emit
      // a separate event for the destination of an `mv tmp dest` when the
      // dest already exists — only the source-file rename fires. So we
      // can't gate on `filename === turnBase` for transition detection;
      // we'd miss every atomic-rewrite. Workaround: any event in this
      // directory might mean a turn write just happened. The temp-file
      // rename ALWAYS fires (its filename will look like
      // CONVO.md.turn.tmp.<pid>). We detect that pattern + the explicit
      // turn/lock filenames, and call checkEdge on any of them. checkEdge
      // is idempotent (reads + diffs against last-known) so spurious
      // calls are no-ops.
      const isTurnTempRename = /CONVO\.md\.turn\.tmp\.\d+/.test(fn);
      if (fn === lockBase) {
        refreshLockSnapshot(e.peer, e.lock);
      }
      if (fn === turnBase || isTurnTempRename) {
        // Lock holder may have just released; refresh snapshot before
        // reading turn (catches the lock-still-held window).
        refreshLockSnapshot(e.peer, e.lock);
        checkEdge(e.peer, e.turn);
        // Round-15n: Bun's fs.watch on Linux can fire the temp-file
        // rename event BEFORE the subsequent mv-to-dest has settled —
        // checkEdge reads the still-old .turn value, sees no change,
        // returns early. The dest-rename event may or may not fire
        // depending on timing. So we schedule a delayed re-check to
        // catch the case where the mv lands after our event tick
        // but no further fs.watch event arrives. 100ms is the
        // empirically-derived window — wide enough to cover the worst
        // observed mv-completion delay, narrow enough not to add
        // human-perceptible notification latency.
        if (isTurnTempRename) {
          setTimeout(() => {
            refreshLockSnapshot(e.peer, e.lock);
            checkEdge(e.peer, e.turn);
          }, 100);
        }
      }
    });
    watchers.push(w);
    w.on("error", (err) => {
      console.error(`[notify] watcher error on ${e.peer}: ${err.message} (will fall back to reconcile-poll)`);
    });
  } catch (err) {
    console.error(`[notify] cannot watch dir for ${e.peer}: ${(err as Error).message} (relying on reconcile-poll)`);
  }
}

// Reconcile-poll: belt-and-suspenders defense against missed fs.watch events.
// Cheap (one stat per edge per 5s) and silent unless something diverges.
const pollHandle = setInterval(() => {
  for (const e of edges) checkEdge(e.peer, e.turn);
}, RECONCILE_POLL_MS);

function shutdown(sig: string) {
  console.error(`[notify] received ${sig}; shutting down`);
  clearInterval(pollHandle);
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Emit any transitions that already exist at startup (e.g. peer flipped
// to me before this watcher started). Walks state once and emits.
for (const e of edges) {
  const cur = state[e.peer].lastTurn;
  if (cur === id.name) {
    console.log(`[notify ${new Date().toISOString()}] startup-pending peer=${e.peer} (turn already on me)`);
  }
}
