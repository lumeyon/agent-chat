#!/usr/bin/env bun
// ephemeral-peer-review.ts — orion drives a one-shot peer code review.
//
// Composes a focused review prompt from (peer's role + module source +
// optional task), shells out to the peer's runtime, and records the
// request/response pair as two CONVO.md sections on the orion-<peer>
// edge. Triggers a lattice import so the new Q/A flows into the global
// store. The peer is ephemeral: there is no long-running peer session,
// no autowatch, no .turn flip waiting for a peer process to pick up.
// Orion drives the entire cycle, holds the lock the whole time, and
// parks the edge when done.
//
// This is the "you manage all peers" CLI. Boss does not start codex.
//
// Usage:
//   agent-chat ephemeral-peer-review --peer <name> --module <path>
//                                    [--task <text>]
//                                    [--runtime claude|codex]
//                                    [--no-import]
//                                    [--review-cap-bytes <N>]
//
// Identity: must be invoked from a session where resolveIdentity() returns
// orion (this is the only agent that can drive ephemeral peer reviews).

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import {
  resolveIdentity,
  loadTopology,
  edgesOf,
  readTurn,
  writeTurnAtomic,
  utcStamp,
  resolveRuntime,
  SKILL_ROOT,
  CONVERSATIONS_DIR,
} from "./lib.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ReviewInput {
  peer: string;
  modulePath: string;
  task?: string;
  runtime?: "claude" | "codex";
  reviewCapBytes?: number;
}

export interface ReviewResult {
  peer: string;
  edgeId: string;
  modulePath: string;
  promptBytes: number;
  responseBytes: number;
  response: string;
  imported: boolean;
  importStats?: {
    questions_inserted: number;
    answers_inserted: number;
  };
}

export type Dispatcher = (input: { prompt: string; timeoutMs?: number }) =>
  Promise<{ stdout: string | null; stderr: string; code: number | null; reason?: string }>;

// ─── Prompt composition ────────────────────────────────────────────────────

const DEFAULT_TASK = `Review this module for real issues only. Focus on:
- Logic bugs (returns wrong value for some input)
- Broken invariants (silent no-ops, impossible states, off-by-one)
- Security (injection, traversal, unbounded cost, auth)
- Data corruption (race conditions, partial writes, lost updates)
- Untested branches (a code path with zero coverage that includes branches)
- Cross-language drift (TS/Python disagreement on canonical_id)

Dismiss stylistic preferences explicitly. Be terse. End with "→ orion" on its own line.`;

export function composeReviewPrompt(args: {
  peer: string;
  peerRole: string | undefined;
  modulePath: string;
  moduleSource: string;
  task: string;
  capBytes: number;
}): string {
  const truncated = args.moduleSource.length > args.capBytes
    ? args.moduleSource.slice(0, args.capBytes) + `\n\n[... truncated, ${args.moduleSource.length - args.capBytes} bytes elided ...]`
    : args.moduleSource;
  const roleBlock = args.peerRole
    ? `Your role as ${args.peer}:\n\n${args.peerRole}\n\n---\n\n`
    : "";
  return `${roleBlock}You are ${args.peer}. Orion has dispatched an ephemeral peer review request.

FILE: ${args.modulePath}

\`\`\`typescript
${truncated}
\`\`\`

REVIEW TASK:
${args.task}
`;
}

// ─── Section formatting ────────────────────────────────────────────────────

function orionRequestSection(args: {
  peer: string;
  modulePath: string;
  task: string;
}): string {
  const ts = utcStamp();
  const desc = `ephemeral peer review request: ${path.basename(args.modulePath)}`;
  return `\n---\n\n## orion — ${desc} (UTC ${ts})\n\nReview ${args.modulePath} for real issues. Task: ${args.task.split("\n")[0]}\n\n→ ${args.peer}\n`;
}

function peerResponseSection(args: {
  peer: string;
  modulePath: string;
  responseBody: string;
}): string {
  const ts = utcStamp();
  const desc = `ephemeral peer review response: ${path.basename(args.modulePath)}`;
  // Strip any trailing "→ orion" the model may have added — we'll add our own.
  const trimmed = args.responseBody.replace(/\n→\s+\S+\s*$/, "").trimEnd();
  return `\n---\n\n## ${args.peer} — ${desc} (UTC ${ts})\n\n${trimmed}\n\n→ parked\n`;
}

// ─── Lock cycle ────────────────────────────────────────────────────────────

function turnCli(args: string[]): { status: number; stderr: string; stdout: string } {
  const r = child_process.spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, "scripts/turn.ts"), ...args],
    { encoding: "utf8" },
  );
  return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

// ─── Lattice import trigger ────────────────────────────────────────────────

function importEdgeIntoLattice(edgeDir: string): { questions_inserted: number; answers_inserted: number } | null {
  const importerPath = path.resolve(SKILL_ROOT, "../../scripts/lattice/import-from-kg.ts");
  if (!fs.existsSync(importerPath)) return null;
  const r = child_process.spawnSync(
    process.execPath,
    [importerPath, edgeDir],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`[ephemeral-peer-review] lattice import failed (non-blocking): ${r.stderr}`);
    return null;
  }
  // Parse the importer's stdout. Format (from import-from-kg.ts:373-374):
  //   questions: +<N> (already existed: <M>)
  //   answers:   +<N> (already existed: <M>)
  const qm = r.stdout.match(/questions:\s*\+(\d+)/);
  const am = r.stdout.match(/answers:\s*\+(\d+)/);
  return {
    questions_inserted: qm ? parseInt(qm[1], 10) : 0,
    answers_inserted: am ? parseInt(am[1], 10) : 0,
  };
}

// ─── Core orchestration ────────────────────────────────────────────────────

export async function runEphemeralPeerReview(
  input: ReviewInput,
  dispatcher: Dispatcher,
  options: { skipImport?: boolean } = {},
): Promise<ReviewResult> {
  const id = resolveIdentity();
  if (id.name !== "orion") {
    throw new Error(`refuse: ephemeral-peer-review must run as orion (identity is "${id.name}")`);
  }
  const topo = loadTopology(id.topology);
  const neighbors = edgesOf(topo, id.name);
  const edge = neighbors.find((e) => e.peer === input.peer);
  if (!edge) {
    const adjacent = neighbors.map((e) => e.peer).join(", ");
    throw new Error(`refuse: peer "${input.peer}" is not adjacent to orion in ${id.topology}. Neighbors: ${adjacent}`);
  }
  if (!fs.existsSync(input.modulePath)) {
    throw new Error(`refuse: module not found at ${input.modulePath}`);
  }
  const moduleSource = fs.readFileSync(input.modulePath, "utf8");
  const task = input.task ?? DEFAULT_TASK;
  const peerRole = topo.roles?.[input.peer];
  const capBytes = input.reviewCapBytes ?? 30 * 1024;

  const prompt = composeReviewPrompt({
    peer: input.peer,
    peerRole,
    modulePath: input.modulePath,
    moduleSource,
    task,
    capBytes,
  });

  // Resume the edge to orion if parked. The protocol's "never silently
  // resume parked" rule is an interactive-conversation discipline; for
  // an ephemeral peer review the resume is explicit, immediate, and
  // ends back at parked in the same lock cycle. Log the action so it's
  // auditable.
  const curTurn = readTurn(edge.turn);
  if (curTurn !== id.name) {
    console.error(`[ephemeral-peer-review] resuming ${edge.id} from "${curTurn ?? "uninitialized"}" → ${id.name} for ephemeral review`);
    writeTurnAtomic(edge.turn, id.name);
  }

  // Lock as orion. Hold the lock through both section appends + park.
  const lockR = turnCli(["lock", input.peer]);
  if (lockR.status !== 0) {
    throw new Error(`lock failed for ${edge.id}: ${lockR.stderr}`);
  }
  let response = "";
  try {
    // Append orion's request section first.
    fs.appendFileSync(edge.convo, orionRequestSection({
      peer: input.peer,
      modulePath: input.modulePath,
      task,
    }));

    // Dispatch to the peer's runtime. 240s budget — codex on a 30KB-class
    // module with a non-trivial review task routinely takes 60-180s; the
    // earlier 120s default tripped on dog-food smoke tests.
    const dispatchResult = await dispatcher({ prompt, timeoutMs: 240_000 });
    if (dispatchResult.reason !== "ok" || !dispatchResult.stdout) {
      throw new Error(`dispatch failed: reason=${dispatchResult.reason} code=${dispatchResult.code} stderr=${dispatchResult.stderr.slice(0, 200)}`);
    }
    response = dispatchResult.stdout.trim();

    // Append peer's response section (still under orion's lock).
    fs.appendFileSync(edge.convo, peerResponseSection({
      peer: input.peer,
      modulePath: input.modulePath,
      responseBody: response,
    }));

    // Park the edge. turn.ts park atomically writes "parked" AND unlinks
    // the lock (Round-13 protocol fix at scripts/turn.ts:73-93).
    const parkR = turnCli(["park", input.peer]);
    if (parkR.status !== 0) {
      throw new Error(`park failed for ${edge.id}: ${parkR.stderr}`);
    }
  } catch (err) {
    // Best-effort cleanup on failure: park the edge (which atomically
    // resets turn to "parked" AND removes the lock — see scripts/turn.ts
    // park op). Without this, a dispatch failure mid-review leaves the
    // edge stuck on "orion" instead of returning to its starting state.
    // turn.ts park requires the current turn to be id.name AND the lock
    // (if any) to belong to id.name; both hold here since we resumed and
    // locked earlier in this function.
    const parkR = turnCli(["park", input.peer]);
    if (parkR.status !== 0) {
      // park failed for some reason; fall back to unlock so at least the
      // lock file is gone. The .turn may still be "orion" — surface that
      // in the error message so the operator can park manually.
      turnCli(["unlock", input.peer]);
      console.error(`[ephemeral-peer-review] park-on-failure failed for ${edge.id}: ${parkR.stderr.trim()}. Edge may still be on "${id.name}" — park manually.`);
    }
    throw err;
  }

  let importStats: { questions_inserted: number; answers_inserted: number } | undefined;
  let imported = false;
  if (!options.skipImport) {
    const stats = importEdgeIntoLattice(edge.dir);
    if (stats) {
      importStats = stats;
      imported = true;
    }
  }

  return {
    peer: input.peer,
    edgeId: edge.id,
    modulePath: input.modulePath,
    promptBytes: prompt.length,
    responseBytes: response.length,
    response,
    imported,
    importStats,
  };
}

// ─── CLI entrypoint ────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  let peer: string | null = null;
  let modulePath: string | null = null;
  let task: string | null = null;
  let runtime: "claude" | "codex" | null = null;
  let skipImport = false;
  let reviewCapBytes: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--peer") peer = args[++i] ?? null;
    else if (a === "--module") modulePath = args[++i] ?? null;
    else if (a === "--task") task = args[++i] ?? null;
    else if (a === "--runtime") {
      const r = args[++i];
      if (r !== "claude" && r !== "codex") {
        console.error(`unknown runtime: ${r}`);
        process.exit(2);
      }
      runtime = r;
    }
    else if (a === "--no-import") skipImport = true;
    else if (a === "--review-cap-bytes") reviewCapBytes = parseInt(args[++i] ?? "0", 10);
    else if (a === "-h" || a === "--help") {
      console.log(`usage: ephemeral-peer-review --peer <name> --module <path> [--task <text>] [--runtime claude|codex] [--no-import] [--review-cap-bytes <N>]`);
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  if (!peer || !modulePath) {
    console.error(`error: --peer and --module are required`);
    process.exit(2);
  }
  // Resolve runtime: explicit flag > per-peer config from topology yaml.
  const id = resolveIdentity();
  const topo = loadTopology(id.topology);
  const resolvedRuntime = runtime ?? resolveRuntime(topo, peer);
  const adapter = await import(`./runtimes/${resolvedRuntime}.ts`);
  // Test-only seam: AGENT_CHAT_MOCK_PEER_RESPONSE bypasses the real LLM and
  // returns a canned response. Used by integration tests that need to drive
  // the CLI through a full lock+append+park cycle without shelling out to
  // claude/codex. Production runs never set this env var.
  const mockResponse = process.env.AGENT_CHAT_MOCK_PEER_RESPONSE;
  const dispatcher: Dispatcher = mockResponse !== undefined
    ? async () => ({ stdout: mockResponse, stderr: "", code: 0, reason: "ok" })
    : adapter.dispatch;

  console.error(`[ephemeral-peer-review] peer=${peer} module=${modulePath} runtime=${resolvedRuntime}`);

  try {
    const result = await runEphemeralPeerReview(
      {
        peer,
        modulePath,
        task: task ?? undefined,
        reviewCapBytes: reviewCapBytes ?? undefined,
      },
      dispatcher,
      { skipImport },
    );
    console.log(`# ephemeral peer review — ${result.peer} on ${path.basename(result.modulePath)}`);
    console.log(`edge=${result.edgeId} prompt_bytes=${result.promptBytes} response_bytes=${result.responseBytes}`);
    if (result.imported) {
      console.log(`lattice: questions_inserted=${result.importStats?.questions_inserted} answers_inserted=${result.importStats?.answers_inserted}`);
    }
    console.log("---");
    console.log(result.response);
  } catch (err) {
    console.error(`[ephemeral-peer-review] ${(err as Error).message}`);
    process.exit(1);
  }
}
