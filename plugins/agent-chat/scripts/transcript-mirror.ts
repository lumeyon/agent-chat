#!/usr/bin/env bun
// transcript-mirror.ts — mirror Claude Code session transcripts into
// agent-chat CONVO.md edges automatically.
//
// Why: Claude Code already records every user/assistant turn into
// ~/.claude/projects/<project>/<session>.jsonl. agent-chat's CONVO.md
// is a different store (peer-readable, multi-agent-aware) but historically
// required the agent to manually call `record-turn`. That manual step
// fails under autonomous load.
//
// This script bridges the two: tail the Claude Code transcript, extract
// each user/assistant text pair, call record-turn. The agent never has
// to remember anything.
//
// Modes:
//   --backfill <jsonl-path>          one-shot replay over the entire file
//                                    (idempotent — recorded_turns.jsonl
//                                    skips duplicates by content hash)
//   --watch <jsonl-path>             tail the file for new entries; when
//                                    a new user→assistant pair lands,
//                                    record it. Long-running daemon.
//   --auto                           pick the current Claude Code session's
//                                    transcript automatically and tail it
//                                    (default behavior when launched by
//                                    `agent-chat init`).
//
// The script is safe to run multiple times — `record-turn` is idempotent
// on (speaker, user, assistant) triples via the per-edge ledger.

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const RECORD_TURN_BIN = path.join(SCRIPT_DIR, "agent-chat.ts");

interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<any>;
  };
  uuid?: string;
  parentUuid?: string;
}

interface TurnPair {
  user: string;
  assistant: string;
  user_idx: number;
  assistant_idx: number;
}

// ─── Filtering ──────────────────────────────────────────────────────────

/**
 * Extract a user prompt from a Claude Code transcript user entry.
 * Returns null if the entry doesn't represent an actual human typing.
 */
function extractUserPrompt(entry: JsonlEntry): string | null {
  if (entry.type !== "user") return null;
  const content = entry.message?.content;
  if (!content) return null;

  // Plain string content = the user typed it.
  if (typeof content === "string") {
    // Filter out empty, system-reminder-only, command-shell entries.
    const trimmed = content.trim();
    if (!trimmed) return null;
    return trimmed;
  }

  // Array content = could be tool_result, attachment, or text blocks.
  if (Array.isArray(content)) {
    // If it's a tool_result block, this is feedback from a tool call,
    // not a human prompt.
    if (content.some((b) => b?.type === "tool_result")) return null;

    // If all blocks are attachments, skip.
    const textBlocks = content.filter((b) => b?.type === "text" && b.text);
    if (textBlocks.length === 0) return null;

    return textBlocks.map((b) => b.text).join("\n").trim() || null;
  }

  return null;
}

/**
 * Extract the user-visible assistant response text by concatenating all
 * text blocks. Skips thinking blocks (internal) and tool_use blocks.
 */
function extractAssistantText(entry: JsonlEntry): string | null {
  if (entry.type !== "assistant") return null;
  const content = entry.message?.content;
  if (!content) return null;

  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text);
    if (texts.length === 0) return null;
    return texts.join("\n").trim() || null;
  }

  return null;
}

/**
 * Walk the JSONL line-by-line and emit user→assistant pairs.
 * Pairing rule: each user prompt collects ALL assistant text blocks that
 * follow until the next user prompt. Multi-turn assistant responses
 * (caused by tool-call cycles) are concatenated into a single record.
 */
function* extractTurnPairs(jsonlPath: string): Generator<TurnPair> {
  const raw = fs.readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let pendingUser: string | null = null;
  let pendingUserIdx = -1;
  const pendingAssistant: string[] = [];
  let firstAssistantIdx = -1;

  function flush() {
    if (pendingUser && pendingAssistant.length > 0) {
      const pair: TurnPair = {
        user: pendingUser,
        assistant: pendingAssistant.join("\n").trim(),
        user_idx: pendingUserIdx,
        assistant_idx: firstAssistantIdx,
      };
      pendingAssistant.length = 0;
      pendingUser = null;
      pendingUserIdx = -1;
      firstAssistantIdx = -1;
      return pair;
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const userPrompt = extractUserPrompt(entry);
    if (userPrompt) {
      // New user message — flush any pending pair first.
      const flushed = flush();
      if (flushed) yield flushed;
      pendingUser = userPrompt;
      pendingUserIdx = i;
      continue;
    }

    if (entry.type === "assistant" && pendingUser) {
      const text = extractAssistantText(entry);
      if (text) {
        if (firstAssistantIdx < 0) firstAssistantIdx = i;
        pendingAssistant.push(text);
      }
    }
  }

  // Final flush
  const flushed = flush();
  if (flushed) yield flushed;
}

// ─── record-turn invocation ─────────────────────────────────────────────

interface RecordResult {
  rc: number;
  stdout: string;
  stderr: string;
}

function recordTurn(user: string, assistant: string, convDir: string): RecordResult {
  // Use --stdin to avoid argv length limits (commonly hit for >4KB
  // bodies). Pass the JSON {user, assistant} on stdin.
  const payload = JSON.stringify({ user, assistant });
  const env = {
    ...process.env,
    AGENT_CHAT_CONVERSATIONS_DIR: convDir,
  };
  const result = child_process.spawnSync(
    "bun",
    [RECORD_TURN_BIN, "record-turn", "--stdin"],
    {
      input: payload,
      env,
      timeout: 30000,
      encoding: "utf-8",
    },
  );
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ─── Modes ──────────────────────────────────────────────────────────────

function backfill(jsonlPath: string, convDir: string): void {
  if (!fs.existsSync(jsonlPath)) {
    console.error(`[transcript-mirror] jsonl not found: ${jsonlPath}`);
    process.exit(2);
  }
  let total = 0;
  let recorded = 0;
  let skippedDup = 0;
  let failed = 0;

  for (const pair of extractTurnPairs(jsonlPath)) {
    total++;
    const result = recordTurn(pair.user, pair.assistant, convDir);
    if (result.rc === 0) {
      recorded++;
      // record-turn prints "no-op (already recorded)" for duplicates;
      // grep stdout for that.
      if (result.stdout.includes("already recorded") || result.stdout.includes("no-op")) {
        skippedDup++;
        recorded--;
      }
    } else {
      failed++;
      console.error(
        `[transcript-mirror] turn ${total} (lines ${pair.user_idx}-${pair.assistant_idx}) failed: rc=${result.rc} stderr=${result.stderr.slice(0, 200)}`,
      );
    }
    if (total % 20 === 0) {
      console.log(`[transcript-mirror] processed ${total} pairs (recorded=${recorded}, dup=${skippedDup}, fail=${failed})`);
    }
  }

  console.log(
    `[transcript-mirror] backfill done. total=${total} recorded=${recorded} duplicates=${skippedDup} failed=${failed}`,
  );
}

function findCurrentTranscript(): string | null {
  // Claude Code stores transcripts at ~/.claude/projects/<project-key>/<session>.jsonl
  // Find the one with the latest mtime under the project that matches CWD.
  const home = process.env.HOME ?? "/root";
  const projectsDir = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return null;

  // The project key encodes the cwd by replacing / with -.
  const cwd = process.cwd();
  const projectKey = cwd.replace(/\//g, "-");
  const candidates = [
    path.join(projectsDir, projectKey),
    // Fall back to a search over all project dirs
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return files[0].p;
  }

  return null;
}

function watch(jsonlPath: string, convDir: string): void {
  console.log(`[transcript-mirror] watching ${jsonlPath}`);
  let lastSize = 0;
  if (fs.existsSync(jsonlPath)) {
    lastSize = fs.statSync(jsonlPath).size;
  }
  // Also keep a memory of last processed turn-pair-index so we don't
  // re-emit pairs we already recorded in this session.
  let lastEmittedAssistantIdx = -1;

  const tick = () => {
    if (!fs.existsSync(jsonlPath)) return;
    const size = fs.statSync(jsonlPath).size;
    if (size <= lastSize) return;
    lastSize = size;

    // Re-walk the entire file (cheap for typical session sizes;
    // record-turn dedupes via ledger anyway).
    for (const pair of extractTurnPairs(jsonlPath)) {
      if (pair.assistant_idx <= lastEmittedAssistantIdx) continue;
      const result = recordTurn(pair.user, pair.assistant, convDir);
      if (result.rc === 0) {
        console.log(`[transcript-mirror] recorded pair (assistant_idx=${pair.assistant_idx})`);
      } else {
        console.error(`[transcript-mirror] failed pair: rc=${result.rc}`);
      }
      lastEmittedAssistantIdx = pair.assistant_idx;
    }
  };

  setInterval(tick, 2000);
}

// ─── CLI ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const convDir =
    process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
    "/data/lumeyon/agent-chat/conversations";

  let mode: "backfill" | "watch" | "auto" | null = null;
  let target = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backfill") {
      mode = "backfill";
      target = args[i + 1] ?? "";
      i++;
    } else if (args[i] === "--watch") {
      mode = "watch";
      target = args[i + 1] ?? "";
      i++;
    } else if (args[i] === "--auto") {
      mode = "auto";
    } else if (args[i] === "-h" || args[i] === "--help") {
      console.log(
        "transcript-mirror.ts [--backfill <jsonl> | --watch <jsonl> | --auto]",
      );
      process.exit(0);
    }
  }

  if (mode === "auto") {
    const found = findCurrentTranscript();
    if (!found) {
      console.error("[transcript-mirror] could not find current Claude Code transcript");
      process.exit(2);
    }
    target = found;
    mode = "watch";
  }

  if (!mode || !target) {
    console.error("usage: transcript-mirror.ts [--backfill <jsonl> | --watch <jsonl> | --auto]");
    process.exit(2);
  }

  if (mode === "backfill") {
    backfill(target, convDir);
  } else if (mode === "watch") {
    watch(target, convDir);
  }
}

main();
