#!/usr/bin/env bun
// codex-rollout-mirror.ts — mirror Codex rollout JSONL transcripts into
// agent-chat CONVO.md edges.
//
// Codex stores session rollouts under ~/.codex/sessions/YYYY/MM/DD/
// rollout-*.jsonl. This script extracts human user prompts and visible
// assistant messages, then calls agent-chat record-turn. It is safe to run
// repeatedly because record-turn dedupes by content hash.

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const RECORD_TURN_BIN = path.join(SCRIPT_DIR, "agent-chat.ts");

interface CodexEntry {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    content?: unknown;
  };
}

interface TurnPair {
  user: string;
  assistant: string;
  user_idx: number;
  assistant_idx: number;
}

interface ExtractOptions {
  flushTrailing?: boolean;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") texts.push(b.text);
    else if (typeof b.content === "string") texts.push(b.content);
  }

  return texts.join("\n").trim() || null;
}

function extractUserPrompt(entry: CodexEntry): string | null {
  const p = entry.payload;
  if (entry.type !== "response_item" || p?.type !== "message" || p.role !== "user") return null;
  const text = textFromContent(p.content);
  if (!text) return null;

  // The rollout begins with synthetic environment context. It is useful
  // model context but not a human turn to mirror into boss-<agent>.
  if (text.trimStart().startsWith("<environment_context>")) return null;
  return text;
}

function extractAssistantText(entry: CodexEntry): string | null {
  const p = entry.payload;
  if (entry.type !== "response_item" || p?.type !== "message" || p.role !== "assistant") return null;
  return textFromContent(p.content);
}

export function* extractTurnPairs(jsonlPath: string, options: ExtractOptions = {}): Generator<TurnPair> {
  const raw = fs.readFileSync(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let pendingUser: string | null = null;
  let pendingUserIdx = -1;
  let firstAssistantIdx = -1;
  const pendingAssistant: string[] = [];

  function flush(): TurnPair | null {
    if (!pendingUser || pendingAssistant.length === 0) return null;
    const pair = {
      user: pendingUser,
      assistant: pendingAssistant.join("\n").trim(),
      user_idx: pendingUserIdx,
      assistant_idx: firstAssistantIdx,
    };
    pendingUser = null;
    pendingUserIdx = -1;
    firstAssistantIdx = -1;
    pendingAssistant.length = 0;
    return pair;
  }

  for (let i = 0; i < lines.length; i++) {
    let entry: CodexEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const user = extractUserPrompt(entry);
    if (user) {
      const pair = flush();
      if (pair) yield pair;
      pendingUser = user;
      pendingUserIdx = i;
      continue;
    }

    const assistant = extractAssistantText(entry);
    if (assistant && pendingUser) {
      if (firstAssistantIdx < 0) firstAssistantIdx = i;
      pendingAssistant.push(assistant);
      continue;
    }

    if (entry.type === "event_msg" && (entry as any).payload?.type === "task_complete") {
      const pair = flush();
      if (pair) yield pair;
    }
  }

  // Normal backfill does not flush the trailing in-progress turn at EOF.
  // Codex Stop hooks, however, are invoked at a completed-response boundary;
  // their caller passes flushTrailing so a delayed task_complete marker does
  // not cause the just-finished response to be skipped.
  if (options.flushTrailing) {
    const pair = flush();
    if (pair) yield pair;
  }
}

interface RecordResult {
  rc: number;
  stdout: string;
  stderr: string;
}

function recordTurn(user: string, assistant: string, convDir: string): RecordResult {
  const payload = JSON.stringify({ user, assistant });
  const env = {
    ...process.env,
    AGENT_CHAT_CONVERSATIONS_DIR: convDir,
  };
  const backoffsMs = [0, 150, 400, 900, 1800];
  let lastResult: ReturnType<typeof child_process.spawnSync> | null = null;

  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (attempt > 0) {
      const sleepFor = backoffsMs[attempt] + Math.floor(Math.random() * 50);
      if (typeof (globalThis as any).Bun !== "undefined" && (globalThis as any).Bun.sleepSync) {
        (globalThis as any).Bun.sleepSync(sleepFor);
      } else {
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, sleepFor);
      }
    }

    lastResult = child_process.spawnSync(
      "bun",
      [RECORD_TURN_BIN, "record-turn", "--stdin"],
      {
        input: payload,
        cwd: process.cwd(),
        env,
        timeout: 30000,
        encoding: "utf8",
      },
    );
    if ((lastResult.status ?? -1) === 0) break;
  }

  return {
    rc: lastResult?.status ?? -1,
    stdout: lastResult?.stdout?.toString() ?? "",
    stderr: lastResult?.stderr?.toString() ?? "",
  };
}

function backfill(jsonlPath: string, convDir: string, options: ExtractOptions = {}): void {
  if (!fs.existsSync(jsonlPath)) {
    console.error(`[codex-rollout-mirror] jsonl not found: ${jsonlPath}`);
    process.exit(2);
  }

  let total = 0;
  let recorded = 0;
  let skippedDup = 0;
  let failed = 0;

  for (const pair of extractTurnPairs(jsonlPath, options)) {
    total++;
    const result = recordTurn(pair.user, pair.assistant, convDir);
    if (result.rc === 0) {
      if (result.stdout.includes("already recorded") || result.stdout.includes("no-op")) {
        skippedDup++;
      } else {
        recorded++;
      }
    } else {
      failed++;
      console.error(
        `[codex-rollout-mirror] turn ${total} (lines ${pair.user_idx}-${pair.assistant_idx}) failed: ` +
        `rc=${result.rc} stderr=${result.stderr.slice(0, 300)}`,
      );
    }
  }

  console.log(
    `[codex-rollout-mirror] backfill done. total=${total} recorded=${recorded} duplicates=${skippedDup} failed=${failed}`,
  );
}

function latestRolloutUnder(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
      }
    }
  }
  return best?.path ?? null;
}

function usage(): never {
  console.error("usage: codex-rollout-mirror.ts [--flush-trailing] --backfill <rollout.jsonl> | --auto");
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const convDir =
    process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
    "/data/lumeyon/agent-chat/conversations";

  let target = "";
  let flushTrailing = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backfill") {
      target = args[i + 1] ?? "";
      i++;
    } else if (args[i] === "--auto") {
      target = latestRolloutUnder(path.join(process.env.HOME ?? "/root", ".codex", "sessions")) ?? "";
    } else if (args[i] === "--flush-trailing") {
      flushTrailing = true;
    } else if (args[i] === "-h" || args[i] === "--help") {
      console.log("codex-rollout-mirror.ts [--flush-trailing] --backfill <rollout.jsonl> | --auto");
      process.exit(0);
    }
  }

  if (!target) usage();
  backfill(target, convDir, { flushTrailing });
}

if (import.meta.main) main();
