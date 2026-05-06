#!/usr/bin/env bun
// stop-hook.ts — Claude Code Stop hook handler.
//
// Fires after every assistant response. Reads the Claude Code transcript
// path from the hook payload, runs transcript-mirror to record any new
// turn pairs into agent-chat CONVO.md, then triggers archive auto on the
// affected edge so long-running conversations stay archive-clean.
//
// Wired into ~/.claude/settings.json (or per-project .claude/settings.json):
//   {
//     "hooks": {
//       "Stop": [{
//         "matcher": "*",
//         "hooks": [{
//           "type": "command",
//           "command": "bun /path/to/stop-hook.ts"
//         }]
//       }]
//     }
//   }
//
// The hook receives a JSON payload on stdin with at least:
//   { hook_event_name: "Stop", session_id, transcript_path, cwd, ... }
//
// We:
//   1. Run transcript-mirror --backfill <transcript_path> — idempotent;
//      record-turn dedupes on (speaker, user, assistant) hash.
//   2. Run archive.ts auto on the resolved edge — only seals leaves if
//      the line threshold is crossed; otherwise no-op.
//
// Failures are logged to <CONV_DIR>/.logs/stop-hook.log but do NOT
// block the Claude Code response cycle (the hook always exits 0).

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MIRROR_BIN = path.join(SCRIPT_DIR, "transcript-mirror.ts");
const AGENT_CHAT_BIN = path.join(SCRIPT_DIR, "agent-chat.ts");

const CONV_DIR =
  process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
  "/data/lumeyon/agent-chat/conversations";

const LOG_DIR = path.join(CONV_DIR, ".logs");
const LOG_FILE = path.join(LOG_DIR, "stop-hook.log");

function log(msg: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Logging must never crash the hook
  }
}

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Round-15l: read cwd-state for the edge id / agent / speaker. Matches
// lib.ts:cwdStateFile — sha256(cwd)[:16] as the filename, schema
// {agent, topology, speaker?, edge_id?, cwd}. Inline to avoid importing
// the lib bundle into the hook (cold-start cost).
type CwdState = {
  agent: string;
  topology: string;
  speaker?: string;
  edge_id?: string;
  cwd: string;
};
function readCwdStateFor(cwd: string): CwdState | null {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const f = path.join(CONV_DIR, ".cwd-state", `${hash}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (typeof obj?.agent !== "string" || typeof obj?.topology !== "string") return null;
    if (typeof obj?.cwd !== "string" || obj.cwd !== cwd) return null;
    return obj as CwdState;
  } catch {
    return null;
  }
}

function spawnQuiet(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): { rc: number; stdout: string; stderr: string } {
  const result = child_process.spawnSync(cmd, args, {
    timeout: opts.timeoutMs ?? 30000,
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
  });
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    log(`stdin not JSON; raw=${raw.slice(0, 200)}`);
  }

  const transcript = payload.transcript_path;
  if (!transcript) {
    log("no transcript_path in payload; nothing to do");
    process.exit(0);
  }
  if (!fs.existsSync(transcript)) {
    log(`transcript_path does not exist: ${transcript}`);
    process.exit(0);
  }

  // Project-scoping: this hook is registered globally in
  // ~/.claude/settings.json so it fires for EVERY Claude Code session on
  // the host. Without scoping, a session in /data/eyon/git/riverdale (or
  // any other repo) would mirror its transcript onto whichever
  // agent-chat edge happened to match the speaker — corrupting unrelated
  // edges with content from elsewhere.
  //
  // Rule: only proceed if there's an agent-chat session record whose
  // cwd equals (or is a parent of) the hook payload's cwd. If no
  // session matches, the user has no agent-chat identity in this Claude
  // Code session and there's nothing legitimate to record.
  const hookCwd = payload.cwd ?? "";
  if (hookCwd) {
    const sessionsDir = path.join(CONV_DIR, ".sessions");
    let matched = false;
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (f.endsWith(".current_speaker.json") || !f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
          const sessCwd = s?.cwd ?? "";
          if (!sessCwd) continue;
          // Match if hookCwd is the same as sessCwd or a subdirectory of it.
          if (hookCwd === sessCwd || hookCwd.startsWith(sessCwd + "/")) {
            matched = true;
            break;
          }
        } catch { /* ignore malformed records */ }
      }
    }
    if (!matched) {
      log(`hook skipped: cwd="${hookCwd}" does not match any agent-chat session`);
      process.exit(0);
    }
  }

  log(`hook fired: session=${payload.session_id ?? "?"} transcript=${transcript}`);

  // Round-15l: identity resolution uses the cwd-state file written by
  // `agent-chat init` / `agent-chat speaker`. Subprocesses inherit
  // `hookCwd` (the cwd Claude Code is running in), and resolveIdentity()
  // / fetchSpeaker() read <conv>/.cwd-state/<sha256(cwd)>.json — the
  // edge id `boss-orion` is derivable from cwd alone. No
  // CLAUDE_SESSION_ID / AGENT_NAME / AGENT_TOPOLOGY forwarding required.

  // 1) Mirror new turns into CONVO.md (idempotent via record-turn ledger).
  // Bumped timeout 60s -> 180s: a backlog of 270+ pairs with retry
  // backoffs can legitimately need >60s to complete.
  const mirror = spawnQuiet("bun", [MIRROR_BIN, "--backfill", transcript], {
    timeoutMs: 180_000,
    cwd: hookCwd,
  });
  if (mirror.rc !== 0) {
    log(`mirror failed: rc=${mirror.rc} stderr=${mirror.stderr.slice(0, 800)}`);
  } else {
    // Find the result line ("backfill done. total=...")
    const resultLine = mirror.stdout
      .split("\n")
      .find((l) => l.includes("backfill done."));
    if (resultLine) log(`mirror: ${resultLine.trim()}`);
    // Even with rc=0, individual pairs may have failed. Surface the
    // first few failure lines so we don't have silent corruption like
    // the 272-fail burst that motivated this fix.
    const failureLines = mirror.stderr
      .split("\n")
      .filter((l) => l.includes("failed:"))
      .slice(0, 3);
    if (failureLines.length > 0) {
      log(`mirror per-pair failures (first ${failureLines.length}): ${failureLines.join(" | ").slice(0, 800)}`);
    }
    // Also detect summary-level failure count > 0
    if (resultLine && /failed=([1-9])/.test(resultLine)) {
      log(`mirror summary indicates failures: ${resultLine.trim()}`);
    }
  }

  // Round-15l: cwd-state IS the context. Read once, derive everything.
  //
  // Before this round, steps 2+3 walked every session record under
  // .sessions/ to figure out the speaker(s) and agent(s), then computed
  // the edge id from the cross-product. That implicitly assumed sessions
  // and speakers were the right unit of context — which is what we are
  // explicitly moving away from. The cwd-state file already names the
  // active edge for this hook's cwd:
  //   { agent: "orion", speaker: "boss", edge_id: "boss-orion", ... }
  // So the hook just reads it and uses edge_id verbatim.
  const cwdState = readCwdStateFor(hookCwd);
  const edgeId = cwdState?.edge_id ?? null;
  const speaker = cwdState?.speaker ?? null;
  if (!edgeId || !speaker) {
    log(`cwd-state missing edge_id/speaker for ${hookCwd}; archive + kg skipped (run 'agent-chat init' + 'agent-chat speaker')`);
  }

  // 2) Auto-archive the active edge. archive.ts auto --force seals
  //    everything older than the fresh tail; if the edge is below the
  //    line threshold this is a fast no-op. Detached so slow archive
  //    work never blocks the response cycle.
  const archiveBin = path.join(SCRIPT_DIR, "archive.ts");
  if (speaker) {
    try {
      const child = child_process.spawn(
        "bun",
        [archiveBin, "auto", speaker, "--force"],
        {
          cwd: hookCwd,
          env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      log(`archive auto ${speaker} --force launched detached (pid=${child.pid})`);

      // Parked-edge sweep — covers edges that drifted into parked state
      // since the last hook fire (e.g., user moved to a different peer).
      const gcChild = child_process.spawn(
        "bun",
        [AGENT_CHAT_BIN, "gc", "--auto-archive", "--archive-threshold=200"],
        {
          cwd: hookCwd,
          env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
          detached: true,
          stdio: "ignore",
        },
      );
      gcChild.unref();
      log(`gc --auto-archive launched detached (pid=${gcChild.pid})`);
    } catch (e) {
      log(`auto-archive launch failed: ${e}`);
    }
  }

  // 3) Rebuild the per-edge knowledge graph. Incremental in practice
  //    via the persistent embedding cache — only new section sha256s
  //    require a fresh ONNX forward pass. Detached so embedding never
  //    blocks the response cycle.
  const kgBin = path.join(SCRIPT_DIR, "kg.ts");
  if (edgeId) {
    try {
      const child = child_process.spawn(
        "bun",
        [kgBin, "build", edgeId],
        {
          cwd: hookCwd,
          env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      log(`kg build ${edgeId} launched detached (pid=${child.pid})`);
    } catch (e) {
      log(`kg build launch failed: ${e}`);
    }
  }

  // Hook always exits 0 — failures are logged, never block the response.
  process.exit(0);
}

main().catch((err) => {
  log(`uncaught: ${err}`);
  process.exit(0);
});
