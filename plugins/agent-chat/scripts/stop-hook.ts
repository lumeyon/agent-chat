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

function spawnQuiet(cmd: string, args: string[], timeoutMs: number = 30000): {
  rc: number;
  stdout: string;
  stderr: string;
} {
  const result = child_process.spawnSync(cmd, args, {
    timeout: timeoutMs,
    encoding: "utf-8",
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

  // 1) Mirror new turns into CONVO.md (idempotent via record-turn ledger)
  const mirror = spawnQuiet("bun", [MIRROR_BIN, "--backfill", transcript], 60_000);
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

  // 2) Auto-archive the active edge for this turn.
  //
  //    `gc --auto-archive` only handles parked edges; we also need to
  //    archive ACTIVE edges (where .turn is the speaker's name)
  //    because that's where every user turn lands. archive.ts auto
  //    --force overrides the parked check and seals everything older
  //    than the fresh tail. If the edge is below threshold, it's a
  //    fast no-op.
  //
  //    The edge is determined by the current_speaker (typically the
  //    user, e.g. "boss"). archive.ts auto takes the peer name, which
  //    is the OTHER agent on the edge — for an orion session with
  //    speaker=boss, peer=boss.
  //
  //    Detached so a slow archive doesn't block the Claude Code
  //    response cycle.
  const archiveBin = path.join(SCRIPT_DIR, "archive.ts");
  try {
    // Find the speaker. The session has it in <conv>/.sessions/<key>.current_speaker.json
    const speakers: string[] = [];
    const sessionsDir = path.join(CONV_DIR, ".sessions");
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith(".current_speaker.json")) continue;
        try {
          const sp = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
          if (sp?.name && !speakers.includes(sp.name)) speakers.push(sp.name);
        } catch { /* ignore */ }
      }
    }

    for (const speaker of speakers) {
      const child = child_process.spawn(
        "bun",
        [archiveBin, "auto", speaker, "--force"],
        {
          env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      log(`archive auto ${speaker} --force launched detached (pid=${child.pid})`);
    }

    // Also keep the parked-edge sweep for any edges that drifted into
    // parked state since the last hook fire.
    const gcChild = child_process.spawn(
      "bun",
      [AGENT_CHAT_BIN, "gc", "--auto-archive", "--archive-threshold=200"],
      {
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

  // 3) Rebuild the per-edge knowledge graph for whichever edge(s) just
  //    received a new turn. Detached so a slow KG build (embedding +
  //    Poincaré projection) doesn't block the response cycle.
  //
  //    The KG build is incremental in practice because of the persistent
  //    embedding cache — only NEW section sha256s require a fresh ONNX
  //    forward pass. Cache hits are sub-millisecond.
  //
  //    We rebuild the KG for the FULL edge (active CONVO.md + all leaf
  //    archives) because the kg.ts pipeline is single-pass; differential
  //    updates can come later if perf demands.
  const kgBin = path.join(SCRIPT_DIR, "kg.ts");
  try {
    // For each known speaker, the kg.ts targeting boss-orion (etc.) is
    // determined by edge name. Speakers come from the same source we
    // used in step 2 — re-derive briefly to avoid name pollution.
    const sessionsDir = path.join(CONV_DIR, ".sessions");
    const speakers: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith(".current_speaker.json")) continue;
        try {
          const sp = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
          if (sp?.name && !speakers.includes(sp.name)) speakers.push(sp.name);
        } catch { /* ignore */ }
      }
    }
    // Determine my agent name from session record
    const myAgents: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (f.endsWith(".current_speaker.json") || !f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
          if (s?.agent && !myAgents.includes(s.agent)) myAgents.push(s.agent);
        } catch { /* ignore */ }
      }
    }
    // For every (speaker, agent) pair we observed, compute edge id and rebuild.
    const edgeIds: string[] = [];
    for (const sp of speakers) {
      for (const ag of myAgents) {
        if (sp === ag) continue;
        const edgeId = sp < ag ? `${sp}-${ag}` : `${ag}-${sp}`;
        if (!edgeIds.includes(edgeId)) edgeIds.push(edgeId);
      }
    }
    for (const edgeId of edgeIds) {
      const child = child_process.spawn(
        "bun",
        [kgBin, "build", edgeId],
        {
          env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      log(`kg build ${edgeId} launched detached (pid=${child.pid})`);
    }
  } catch (e) {
    log(`kg build launch failed: ${e}`);
  }

  // Hook always exits 0 — failures are logged, never block the response.
  process.exit(0);
}

main().catch((err) => {
  log(`uncaught: ${err}`);
  process.exit(0);
});
