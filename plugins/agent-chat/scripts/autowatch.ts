#!/usr/bin/env bun
// scripts/autowatch.ts — persistent graph watcher for agentic runtimes.
//
// `agent-chat run` remains bounded to one tick and exit. This script is the
// plugin-owned scheduler around that tick: it watches turn sentinels for a
// specific agent/topology and invokes `agent-chat run <peer...>` whenever an
// edge hands the floor to that agent.

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import {
  CONVERSATIONS_DIR,
  SKILL_ROOT,
  edgesOf,
  findLivePresence,
  isValidAgentName,
  loadTopology,
  readTurn,
  type RuntimeName,
} from "./lib.ts";

type Args = {
  agent: string;
  topology: string;
  peers: string[];
  runtime: RuntimeName | null;
  intervalSec: number;
  retrySec: number;
  staleLockSec: number;
  allowPresenceConflict: boolean;
  once: boolean;
  dryRun: boolean;
};

function usage(): string {
  return [
    "usage: autowatch.ts <agent> <topology> [--peer <peer>] [--runtime claude|codex]",
    "                    [--interval-sec N] [--retry-sec N] [--allow-presence-conflict]",
    "                    [--once] [--dry-run]",
  ].join("\n");
}

function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) die(`${label} must be a positive integer`);
  return n;
}

function parseRuntime(raw: string | undefined): RuntimeName | null {
  if (!raw) return null;
  if (raw === "claude" || raw === "codex") return raw;
  die(`unknown runtime "${raw}" — expected claude or codex`, 64);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const peers: string[] = [];
  let runtime = parseRuntime(process.env.AGENT_CHAT_RUNTIME);
  let intervalSec = envInt("AGENT_CHAT_AUTOWATCH_INTERVAL_SEC", 2);
  let retrySec = envInt("AGENT_CHAT_AUTOWATCH_RETRY_SEC", 30);
  let staleLockSec = envInt("AGENT_CHAT_AUTOWATCH_STALE_LOCK_SEC", 600);
  let allowPresenceConflict = process.env.AGENT_CHAT_AUTOWATCH_ALLOW_PRESENCE_CONFLICT === "1";
  let once = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (a === "--peer") {
      const p = argv[++i];
      if (!p) die("--peer requires a value", 64);
      peers.push(p);
    } else if (a.startsWith("--peer=")) {
      peers.push(a.slice("--peer=".length));
    } else if (a === "--runtime") {
      runtime = parseRuntime(argv[++i]);
    } else if (a.startsWith("--runtime=")) {
      runtime = parseRuntime(a.slice("--runtime=".length));
    } else if (a === "--interval-sec") {
      intervalSec = parsePositiveInt(argv[++i], "--interval-sec");
    } else if (a.startsWith("--interval-sec=")) {
      intervalSec = parsePositiveInt(a.slice("--interval-sec=".length), "--interval-sec");
    } else if (a === "--retry-sec") {
      retrySec = parsePositiveInt(argv[++i], "--retry-sec");
    } else if (a.startsWith("--retry-sec=")) {
      retrySec = parsePositiveInt(a.slice("--retry-sec=".length), "--retry-sec");
    } else if (a === "--stale-lock-sec") {
      staleLockSec = parsePositiveInt(argv[++i], "--stale-lock-sec");
    } else if (a.startsWith("--stale-lock-sec=")) {
      staleLockSec = parsePositiveInt(a.slice("--stale-lock-sec=".length), "--stale-lock-sec");
    } else if (a === "--allow-presence-conflict") {
      allowPresenceConflict = true;
    } else if (a === "--once") {
      once = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a.startsWith("--")) {
      die(`unknown option ${a}\n${usage()}`, 64);
    } else {
      positional.push(a);
    }
  }

  const envAgent = process.env.AGENT_NAME;
  const envTopology = process.env.AGENT_TOPOLOGY;
  const agent = positional[0] ?? (envAgent && envTopology ? envAgent : "");
  const topology = positional[1] ?? (envAgent && envTopology ? envTopology : "");
  if (!agent || !topology) die(usage(), 64);
  if (!isValidAgentName(agent)) die(`invalid agent name "${agent}"`, 64);
  for (const p of peers) {
    if (!isValidAgentName(p)) die(`invalid peer name "${p}"`, 64);
  }

  return {
    agent,
    topology,
    peers: [...new Set(peers)],
    runtime,
    intervalSec,
    retrySec,
    staleLockSec,
    allowPresenceConflict,
    once,
    dryRun,
  };
}

type Edge = ReturnType<typeof edgesOf>[number];

function selectedEdges(args: Args): Edge[] {
  const topo = loadTopology(args.topology);
  if (!topo.agents.includes(args.agent)) {
    die(`agent "${args.agent}" is not declared in topology "${args.topology}"`, 64);
  }
  const all = edgesOf(topo, args.agent);
  if (args.peers.length === 0) return all;
  const byPeer = new Map(all.map((e) => [e.peer, e]));
  const missing = args.peers.filter((p) => !byPeer.has(p));
  if (missing.length > 0) {
    die(`peer(s) not adjacent to ${args.agent}@${args.topology}: ${missing.join(", ")}`, 64);
  }
  return args.peers.map((p) => byPeer.get(p)!);
}

function pendingPeers(edges: Edge[], args: Args): string[] {
  const out: string[] = [];
  for (const edge of edges) {
    if (readTurn(edge.turn) !== args.agent) continue;
    if (fs.existsSync(edge.lock)) continue;
    out.push(edge.peer);
  }
  return out;
}

function presenceConflictMessage(args: Args): string | null {
  if (args.allowPresenceConflict) return null;
  const live = findLivePresence(args.agent);
  if (!live) return null;
  return (
    `agent "${args.agent}" is already live as ${live.agent}@${live.host}:${live.pid} ` +
    `(session ${live.session_key}); refusing autowatch impersonation. ` +
    `Stop that session first, or pass --allow-presence-conflict explicitly.`
  );
}

function lockPath(args: Args): string {
  return path.join(CONVERSATIONS_DIR, ".autowatch", `${args.topology}-${args.agent}.run.lock`);
}

function acquireRunLock(args: Args): (() => void) | null {
  const p = lockPath(args);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const tryOpen = (): (() => void) | null => {
    try {
      const fd = fs.openSync(p, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        agent: args.agent,
        topology: args.topology,
        pid: process.pid,
        started_at: new Date().toISOString(),
      }) + "\n");
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(p); } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      return null;
    }
  };

  let release = tryOpen();
  if (release) return release;
  try {
    const ageSec = Math.round((Date.now() - fs.statSync(p).mtimeMs) / 1000);
    if (ageSec > args.staleLockSec) {
      console.error(`[agent-chat autowatch] removing stale run lock ${p} (${ageSec}s old)`);
      fs.unlinkSync(p);
      release = tryOpen();
    }
  } catch {}
  return release;
}

function childEnv(args: Args): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_NAME: args.agent,
    AGENT_TOPOLOGY: args.topology,
    AGENT_CHAT_CONVERSATIONS_DIR: CONVERSATIONS_DIR,
    // Force env identity inside the one-shot child even if the parent
    // terminal has a live Claude/Codex session key for a different agent.
    CLAUDE_SESSION_ID: `autowatch:${args.topology}:${args.agent}:${process.pid}`,
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (args.runtime) env.AGENT_CHAT_RUNTIME = args.runtime;
  return env;
}

function runTick(args: Args, peers: string[]): number {
  const script = path.join(SKILL_ROOT, "scripts/agent-chat.ts");
  const childArgs = [script, "run", ...peers];
  if (args.dryRun) {
    console.log(`[agent-chat autowatch] dry-run: ${process.execPath} ${childArgs.join(" ")}`);
    return 0;
  }
  console.error(`[agent-chat autowatch] tick: agent-chat run ${peers.join(" ")}`);
  const r = child_process.spawnSync(process.execPath, childArgs, {
    cwd: SKILL_ROOT,
    env: childEnv(args),
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.error) {
    console.error(`[agent-chat autowatch] tick spawn failed: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const edges = selectedEdges(args);
  const startupConflict = presenceConflictMessage(args);
  if (startupConflict) {
    console.error(`[agent-chat autowatch] ${startupConflict}`);
    return;
  }
  const peerLabel = args.peers.length > 0 ? args.peers.join(",") : "all-neighbors";
  console.error(
    `[agent-chat autowatch] watching ${args.agent}@${args.topology} ` +
    `peers=${peerLabel} runtime=${args.runtime ?? "(topology/env/auto)"} ` +
    `interval=${args.intervalSec}s retry=${args.retrySec}s conversations=${CONVERSATIONS_DIR}`,
  );

  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  process.on("SIGTERM", () => { stop = true; });

  const nextAttempt = new Map<string, number>();
  let lastState = "";
  while (!stop) {
    const conflict = presenceConflictMessage(args);
    if (conflict) {
      console.error(`[agent-chat autowatch] ${conflict}`);
      break;
    }
    const now = Date.now();
    const pending = pendingPeers(edges, args);
    const runnable = pending.filter((p) => now >= (nextAttempt.get(p) ?? 0));
    const backedOff = pending.filter((p) => now < (nextAttempt.get(p) ?? 0));
    const state = pending.length === 0
      ? "idle"
      : `pending=${pending.join(",")}` + (backedOff.length > 0 ? ` backoff=${backedOff.join(",")}` : "");
    if (state !== lastState) {
      console.error(`[agent-chat autowatch] ${state}`);
      lastState = state;
    }

    if (runnable.length > 0) {
      const release = acquireRunLock(args);
      if (!release) {
        console.error("[agent-chat autowatch] another watcher is running a tick; skipping this pass");
      } else {
        try {
          const status = runTick(args, runnable);
          const stillPending = new Set(pendingPeers(edges, args));
          for (const peer of runnable) {
            if (status !== 0 || stillPending.has(peer)) {
              nextAttempt.set(peer, Date.now() + args.retrySec * 1000);
            } else {
              nextAttempt.delete(peer);
            }
          }
        } finally {
          release();
        }
      }
    }

    if (args.once) break;
    await sleep(args.intervalSec * 1000);
  }
}

if (import.meta.main) {
  void main();
}
