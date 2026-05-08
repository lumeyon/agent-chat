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
import { truncateToUtf8Bytes, utf8ByteLength } from "./utf8.ts";

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
  // E7 fix (NL24 / lumeyon NL4 finding): truncate by UTF-8 BYTES, not
  // UTF-16 .length. Pre-fix `args.moduleSource.length > args.capBytes`
  // compared UTF-16 code units against a byte budget; for non-ASCII
  // module content (CJK comments, emoji in test fixtures, accented
  // Latin docs), payloads with bytes >> length silently slipped past the
  // capBytes check. `slice(0, args.capBytes)` could also split a
  // surrogate pair mid-character. Same shape as LC4 (NL23) — fixed via
  // the shared utf8.ts utility (truncateToUtf8Bytes walks back to a
  // non-continuation-byte boundary so multi-byte UTF-8 sequences are
  // preserved). The elided-byte count is now correctly reported in
  // BYTES, not UTF-16 code units.
  const sourceBytes = utf8ByteLength(args.moduleSource);
  const truncated = sourceBytes > args.capBytes
    ? truncateToUtf8Bytes(args.moduleSource, args.capBytes) + `\n\n[... truncated, ${sourceBytes - args.capBytes} bytes elided ...]`
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

/** E4 fix (NL28 / lumeyon NL4 finding): when dispatch fails AFTER orion's
 *  request section was appended but BEFORE the peer's response section,
 *  append this abort section so the CONVO.md tail's arrow matches the
 *  catch block's `.turn=parked` end state. Pre-fix the CONVO tail said
 *  `→ <peer>` (from orion's request) while `.turn=parked` — a Monitor
 *  reading CONVO would see "the floor was just handed to <peer>" but
 *  the wire-state file disagreed. */
function abortSection(args: {
  modulePath: string;
  reason: string;
}): string {
  const ts = utcStamp();
  const desc = `ephemeral peer review aborted: ${path.basename(args.modulePath)}`;
  // Truncate the reason to keep the section tight. The full error is
  // already in the CLI's stderr; this is just the audit-trail breadcrumb.
  const truncatedReason = args.reason.length > 240
    ? args.reason.slice(0, 237) + "..."
    : args.reason;
  return `\n---\n\n## orion — ${desc} (UTC ${ts})\n\nDispatch failed: ${truncatedReason}\n\n→ parked\n`;
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
  // E5 fix (NL30 / lumeyon NL4 finding): support env override and log
  // clearly when the importer is missing. Pre-fix the relative path
  // `../../scripts/lattice/import-from-kg.ts` worked in the dev repo
  // layout but silently no-op'd in packaged plugin layouts (npm package,
  // published artifact, plugin-only deployment) where the relative path
  // resolves to a non-existent file. fs.existsSync returned false and
  // the function returned null with no diagnostic — operators couldn't
  // see why the lattice import was missing.
  //
  // Post-fix: (a) AGENT_CHAT_LATTICE_IMPORTER_PATH env var lets operators
  // pin the importer location explicitly; (b) when the resolved path
  // doesn't exist, log it on stderr so the silent skip becomes visible.
  const importerPath = process.env.AGENT_CHAT_LATTICE_IMPORTER_PATH
    ?? path.resolve(SKILL_ROOT, "../../scripts/lattice/import-from-kg.ts");
  if (!fs.existsSync(importerPath)) {
    console.error(
      `[ephemeral-peer-review] lattice importer not found at ${importerPath} — skipping import. ` +
      `Set AGENT_CHAT_LATTICE_IMPORTER_PATH to override.`,
    );
    return null;
  }
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

  // E1+E2 fix (NL21 / lumeyon NL4 findings): refuse upfront if another
  // agent holds the floor; only resume-write when curTurn is "parked"
  // or null. Pre-fix the resume-write unconditionally flipped .turn to
  // orion regardless of whether the prior holder was a peer mid-flow,
  // and the subsequent lock would silently succeed (lock-invariant
  // refuses non-self turn was satisfied by the flip itself), stealing
  // the peer's floor. The same code path also enabled a concurrent-
  // orion race (E2) where two pre-lock flips → one wins lock, loser's
  // E3 revert corrupts winner's state.
  //
  // turn.ts lock refuses unless .turn === self OR null (lines 110-113);
  // "parked" is NOT exempt, so we still need to write self before
  // locking when resuming from parked. But we now ONLY do that for the
  // legitimate cases (parked/null) — the non-self-non-parked case is
  // refused without any state change.
  const curTurn = readTurn(edge.turn);
  const didResume = curTurn !== id.name;

  if (didResume && curTurn !== null && curTurn !== "parked") {
    throw new Error(
      `refuse: edge ${edge.id} has .turn="${curTurn}" — another agent currently holds the floor. ` +
      `Park that conversation before requesting an ephemeral peer review on this edge.`,
    );
  }

  if (didResume) {
    console.error(`[ephemeral-peer-review] resuming ${edge.id} from "${curTurn ?? "uninitialized"}" → ${id.name} for ephemeral review`);
    writeTurnAtomic(edge.turn, id.name);
  }

  // E3 fix (NL14 / lumeyon NL4 finding): the lock attempt is now INSIDE
  // the try block. Pre-fix the lock call was outside, so a lock-failure
  // path skipped all cleanup and left .turn stuck on whatever the
  // resume-write set it to (typically "orion"). Post-fix: lock failure
  // is caught; if we resumed but couldn't lock, revert .turn to its
  // pre-resume value so the edge isn't stranded.
  let response = "";
  let lockedSuccessfully = false;
  let orionRequestAppended = false;
  let peerResponseAppended = false;
  try {
    const lockR = turnCli(["lock", input.peer]);
    if (lockR.status !== 0) {
      throw new Error(`lock failed for ${edge.id}: ${lockR.stderr}`);
    }
    lockedSuccessfully = true;
    // Append orion's request section first.
    fs.appendFileSync(edge.convo, orionRequestSection({
      peer: input.peer,
      modulePath: input.modulePath,
      task,
    }));
    orionRequestAppended = true;

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
    peerResponseAppended = true;

    // Park the edge. turn.ts park atomically writes "parked" AND unlinks
    // the lock (Round-13 protocol fix at scripts/turn.ts:73-93).
    const parkR = turnCli(["park", input.peer]);
    if (parkR.status !== 0) {
      throw new Error(`park failed for ${edge.id}: ${parkR.stderr}`);
    }
  } catch (err) {
    // Cleanup on failure has two cases (NL14 E3 fix):
    //   1. Lock was acquired before the failure (typical path):
    //      park the edge (atomically resets turn to "parked" AND
    //      removes the lock — see scripts/turn.ts park op).
    //   2. Lock was NEVER acquired (E3 path):
    //      we already resumed .turn from "parked"→"orion" before the
    //      lock attempt. park.ts won't help — it requires us to OWN
    //      the lock, which we don't. Revert the resume manually so
    //      the edge isn't stranded on "orion".
    if (lockedSuccessfully) {
      // E4 fix (NL28): if orion's request was already appended but the
      // peer's response was NOT (typical case: dispatch failed mid-flight),
      // append an abort section so CONVO.md's tail arrow says "→ parked"
      // — matching the .turn=parked end state the park() call below will
      // write. Without this, CONVO tail says "→ <peer>" (from orion's
      // request) while .turn=parked, violating the protocol invariant
      // that the wire-state file and CONVO tail's arrow agree.
      if (orionRequestAppended && !peerResponseAppended) {
        try {
          fs.appendFileSync(edge.convo, abortSection({
            modulePath: input.modulePath,
            reason: (err as Error)?.message ?? String(err),
          }));
        } catch (writeErr) {
          // Best-effort; if we can't append the abort marker, surface it
          // but still proceed to park so .turn doesn't get stuck.
          console.error(`[ephemeral-peer-review] failed to append abort section for ${edge.id}: ${(writeErr as Error)?.message ?? writeErr}`);
        }
      }
      const parkR = turnCli(["park", input.peer]);
      if (parkR.status !== 0) {
        // park failed for some reason; fall back to unlock so at least the
        // lock file is gone. The .turn may still be "orion" — surface that
        // in the error message so the operator can park manually.
        turnCli(["unlock", input.peer]);
        console.error(`[ephemeral-peer-review] park-on-failure failed for ${edge.id}: ${parkR.stderr.trim()}. Edge may still be on "${id.name}" — park manually.`);
      }
    } else if (didResume) {
      // E3: we resumed .turn but couldn't lock. Revert .turn so the
      // edge is restored to its pre-CLI-invocation state.
      writeTurnAtomic(edge.turn, curTurn ?? "parked");
      console.error(`[ephemeral-peer-review] lock failed for ${edge.id}; reverted .turn to "${curTurn ?? "parked"}" (foreign lock left in place — owned by another session).`);
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
    else if (a === "--review-cap-bytes") {
      // Lumeyon NL4 E6 fix: previously parseInt accepted NaN (silently
      // disabled truncation) and negative values (misleading "bytes
      // elided" count). Reject explicitly.
      const raw = args[++i] ?? "";
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`error: --review-cap-bytes must be a positive integer (got "${raw}")`);
        process.exit(2);
      }
      reviewCapBytes = parsed;
    }
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
