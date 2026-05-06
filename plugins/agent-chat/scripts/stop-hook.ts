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

  log(`hook fired: session=${payload.session_id ?? "?"} transcript=${transcript}`);

  // 1) Mirror new turns into CONVO.md (idempotent via record-turn ledger)
  const mirror = spawnQuiet("bun", [MIRROR_BIN, "--backfill", transcript], 60_000);
  if (mirror.rc !== 0) {
    log(`mirror failed: rc=${mirror.rc} stderr=${mirror.stderr.slice(0, 300)}`);
  } else {
    // Find the result line ("backfill done. total=...")
    const resultLine = mirror.stdout
      .split("\n")
      .find((l) => l.includes("backfill done."));
    if (resultLine) log(`mirror: ${resultLine.trim()}`);
  }

  // 2) Auto-archive — fire-and-forget so we don't block the Claude Code
  //    response cycle. The archive layer is idempotent and bounded by the
  //    line threshold; if nothing needs sealing, it's a fast no-op. If
  //    something does, it can take a few seconds per edge.
  //
  //    We detach the process so even a slow archive run doesn't delay
  //    the user seeing their next prompt. Failures are logged inside
  //    `agent-chat gc` itself and surface in <conv>/.logs/.
  try {
    const child = child_process.spawn(
      "bun",
      [AGENT_CHAT_BIN, "gc", "--auto-archive", "--archive-threshold=200"],
      {
        env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    log(`auto-archive launched detached (pid=${child.pid})`);
  } catch (e) {
    log(`auto-archive launch failed: ${e}`);
  }

  // Hook always exits 0 — failures are logged, never block the response.
  process.exit(0);
}

main().catch((err) => {
  log(`uncaught: ${err}`);
  process.exit(0);
});
