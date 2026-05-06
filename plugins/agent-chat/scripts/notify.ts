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
import { resolveIdentity, loadTopology, edgesOf, readTurn } from "./lib.ts";

// Reconcile-poll cadence — covers fs.watch gaps (FUSE, NFS, deleted+recreated
// files which can confuse watchers). 5s is a balance: fast enough that a
// missed event isn't load-bearingly invisible; slow enough not to thrash.
const RECONCILE_POLL_MS = 5_000;

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
// rename) is debounced to actual transitions.
type EdgeState = { lastTurn: string | null };
const state: Record<string, EdgeState> = {};
for (const e of edges) state[e.peer] = { lastTurn: readTurn(e.turn) };

function emitTransition(peer: string, before: string | null, after: string | null) {
  if (before === after) return;
  const prefix = `[notify ${new Date().toISOString()}]`;
  if (after === id.name) {
    console.log(`${prefix} peer-flipped-to-me peer=${peer}`);
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

// Wire fs.watch per edge; the close handles are kept so we can shut down.
const watchers: fs.FSWatcher[] = [];
for (const e of edges) {
  try {
    const w = fs.watch(e.turn, { persistent: true }, () => {
      // fs.watch fires multiple times per rename (rename + change events on
      // some platforms); checkEdge debounces by comparing against last-known.
      checkEdge(e.peer, e.turn);
    });
    watchers.push(w);
    w.on("error", (err) => {
      console.error(`[notify] watcher error on ${e.peer}: ${err.message} (will fall back to reconcile-poll)`);
    });
  } catch (err) {
    // .turn file may not exist yet (uninitialized edge). Reconcile-poll
    // will pick up the transition once it appears.
    console.error(`[notify] cannot watch ${e.peer} yet: ${(err as Error).message} (relying on reconcile-poll)`);
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
