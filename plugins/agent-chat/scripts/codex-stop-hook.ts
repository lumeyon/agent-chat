#!/usr/bin/env bun
// codex-stop-hook.ts — Codex Stop hook handler for agent-chat.
//
// Runs after each Codex turn. It mirrors the current rollout transcript into
// the active boss-<agent> edge using cwd-state, then launches archive + KG
// maintenance in the background.

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MIRROR_BIN = path.join(SCRIPT_DIR, "codex-rollout-mirror.ts");
const AGENT_CHAT_BIN = path.join(SCRIPT_DIR, "agent-chat.ts");
const ARCHIVE_BIN = path.join(SCRIPT_DIR, "archive.ts");
const KG_BIN = path.join(SCRIPT_DIR, "kg.ts");

const CONV_DIR =
  process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
  "/data/lumeyon/agent-chat/conversations";
const LOG_DIR = path.join(CONV_DIR, ".logs");
const LOG_FILE = path.join(LOG_DIR, "codex-stop-hook.log");

type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  turn_id?: string;
  last_assistant_message?: string | null;
};

type CwdState = {
  agent: string;
  topology: string;
  speaker?: string;
  edge_id?: string;
  cwd: string;
};

function log(msg: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Hooks must never fail because logging failed.
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function readCwdStateFor(cwd: string): CwdState | null {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const f = path.join(CONV_DIR, ".cwd-state", `${hash}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf8"));
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
  opts: { cwd: string; timeoutMs?: number },
): { rc: number; stdout: string; stderr: string } {
  const result = child_process.spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
    timeout: opts.timeoutMs ?? 30000,
    encoding: "utf8",
  });
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sleepSync(ms: number): void {
  if (typeof (globalThis as any).Bun !== "undefined" && (globalThis as any).Bun.sleepSync) {
    (globalThis as any).Bun.sleepSync(ms);
    return;
  }
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function transcriptHasTaskComplete(transcript: string, turnId?: string): boolean {
  try {
    const raw = fs.readFileSync(transcript, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "event_msg" || entry?.payload?.type !== "task_complete") continue;
      if (!turnId || entry.payload.turn_id === turnId) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function waitForTaskComplete(transcript: string, turnId?: string): boolean {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (transcriptHasTaskComplete(transcript, turnId)) return true;
    sleepSync(150);
  }
  return transcriptHasTaskComplete(transcript, turnId);
}

function launchDetached(label: string, args: string[], cwd: string): void {
  try {
    const child = child_process.spawn("bun", args, {
      cwd,
      env: { ...process.env, AGENT_CHAT_CONVERSATIONS_DIR: CONV_DIR },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log(`${label} launched detached (pid=${child.pid})`);
  } catch (err) {
    log(`${label} launch failed: ${err}`);
  }
}

function shouldAutoArchive(state: CwdState): boolean {
  if (!state.edge_id) return false;
  const convo = path.join(CONV_DIR, state.topology, state.edge_id, "CONVO.md");
  try {
    if (!fs.existsSync(convo)) return false;
    return fs.readFileSync(convo, "utf8").split("\n").length >= 200;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    log(`stdin not JSON; raw=${raw.slice(0, 200)}`);
  }

  const hookCwd = payload.cwd || process.cwd();
  const state = readCwdStateFor(hookCwd);
  if (!state) {
    log(`hook skipped: no cwd-state for cwd=${hookCwd}`);
    return;
  }

  const transcript = payload.transcript_path ?? "";
  if (!transcript || !fs.existsSync(transcript)) {
    log(`hook skipped: transcript missing for cwd=${hookCwd} transcript=${transcript || "(none)"}`);
    return;
  }

  log(
    `hook fired: event=${payload.hook_event_name ?? "?"} session=${payload.session_id ?? "?"} ` +
    `turn=${payload.turn_id ?? "?"} transcript=${transcript}`,
  );

  // Codex may invoke the Stop hook before the rollout file receives the
  // task_complete event. This hook runs at a completed-response boundary, so
  // the mirror is allowed to flush the trailing assistant message if the
  // completion marker is delayed.
  if (!waitForTaskComplete(transcript, payload.turn_id)) {
    log(`task_complete not observed before mirror; flushing trailing turn=${payload.turn_id ?? "?"}`);
  }

  const mirror = spawnQuiet("bun", [MIRROR_BIN, "--backfill", transcript, "--flush-trailing"], {
    cwd: hookCwd,
    timeoutMs: 180000,
  });
  let recordedNewTurn = false;
  if (mirror.rc !== 0) {
    log(`mirror failed: rc=${mirror.rc} stderr=${mirror.stderr.slice(0, 800)}`);
  } else {
    const resultLine = mirror.stdout
      .split("\n")
      .find((line) => line.includes("backfill done."));
    if (resultLine) {
      log(`mirror: ${resultLine.trim()}`);
      const recordedMatch = resultLine.match(/recorded=(\d+)/);
      recordedNewTurn = Number(recordedMatch?.[1] ?? "0") > 0;
    }
    const failureLines = mirror.stderr
      .split("\n")
      .filter((line) => line.includes("failed:"))
      .slice(0, 3);
    if (failureLines.length > 0) {
      log(`mirror per-pair failures: ${failureLines.join(" | ").slice(0, 800)}`);
    }
  }

  if (!recordedNewTurn) {
    log("no new turn recorded; archive + kg skipped");
    return;
  }

  if (!state.speaker || !state.edge_id) {
    log(`cwd-state missing speaker/edge_id for cwd=${hookCwd}; archive + kg skipped`);
    return;
  }

  if (shouldAutoArchive(state)) {
    launchDetached(
      `archive auto ${state.speaker} --force`,
      [ARCHIVE_BIN, "auto", state.speaker, "--force"],
      hookCwd,
    );
  } else {
    log(`archive auto skipped: ${state.edge_id} below 200-line threshold`);
  }
  launchDetached(
    "gc --auto-archive",
    [AGENT_CHAT_BIN, "gc", "--auto-archive", "--archive-threshold=200"],
    hookCwd,
  );
  launchDetached(
    `kg build ${state.edge_id}`,
    [KG_BIN, "build", state.edge_id],
    hookCwd,
  );
}

main()
  .catch((err) => log(`uncaught: ${err}`))
  .finally(() => {
    // Codex Stop hooks expect JSON if they write stdout. Keep output minimal
    // and non-continuing; failures are logged instead of blocking the turn.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  });
