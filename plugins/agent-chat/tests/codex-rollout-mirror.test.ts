// codex-rollout-mirror.test.ts — Codex rollout JSONL -> record-turn parity.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, spawnScript, freshEnv, fakeSessionId } from "./helpers.ts";

let CONVO_DIR: string;
let WORK_CWD: string;
let BASE_ENV: Record<string, string>;

function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function msg(role: "user" | "assistant", text: string, phase?: string): unknown {
  return {
    timestamp: "2026-05-06T20:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

function writeRollout(file: string): void {
  fs.writeFileSync(
    file,
    line({ timestamp: "2026-05-06T20:00:00.000Z", type: "session_meta", payload: { cwd: WORK_CWD } }) +
    line(msg("user", "<environment_context>\n  <cwd>/tmp/example</cwd>\n</environment_context>")) +
    line(msg("user", "first prompt")) +
    line(msg("assistant", "working note", "commentary")) +
    line({ timestamp: "2026-05-06T20:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command" } }) +
    line(msg("assistant", "first final", "final_answer")) +
    line({ timestamp: "2026-05-06T20:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }) +
    line(msg("user", "second prompt")) +
    line(msg("assistant", "second final", "final_answer")) +
    line({ timestamp: "2026-05-06T20:00:03.000Z", type: "event_msg", payload: { type: "task_complete" } }),
  );
}

function writeTrailingRollout(file: string): void {
  fs.writeFileSync(
    file,
    line({ timestamp: "2026-05-06T20:00:00.000Z", type: "session_meta", payload: { cwd: WORK_CWD } }) +
    line(msg("user", "<environment_context>\n  <cwd>/tmp/example</cwd>\n</environment_context>")) +
    line(msg("user", "completed prompt")) +
    line(msg("assistant", "completed final", "final_answer")) +
    line({ timestamp: "2026-05-06T20:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } }) +
    line(msg("user", "trailing prompt")) +
    line(msg("assistant", "trailing final", "final_answer")),
  );
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  WORK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-test-"));
  BASE_ENV = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR }) as Record<string, string>;
});

afterEach(() => {
  rmTmp(CONVO_DIR);
  fs.rmSync(WORK_CWD, { recursive: true, force: true });
});

function initLumeyon(): string {
  const sid = fakeSessionId("codex-rollout");
  runScript("agent-chat.ts", ["init", "lumeyon", "petersen"], envWith({ CLAUDE_SESSION_ID: sid }), { cwd: WORK_CWD });
  runScript("agent-chat.ts", ["speaker", "boss"], envWith({ CLAUDE_SESSION_ID: sid }), { cwd: WORK_CWD });
  return sid;
}

describe("codex-rollout-mirror", () => {
  test("backfill records Codex user/assistant pairs and is idempotent", () => {
    const sid = initLumeyon();
    const safeSid = sid.replace(/[^A-Za-z0-9_:.-]/g, "_");
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.json`));
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.current_speaker.json`));

    const rollout = path.join(WORK_CWD, "rollout.jsonl");
    writeRollout(rollout);

    const noSessionEnv = envWith();
    const first = runScript("codex-rollout-mirror.ts", ["--backfill", rollout], noSessionEnv, { cwd: WORK_CWD });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("backfill done. total=2 recorded=2 duplicates=0 failed=0");

    const second = runScript("codex-rollout-mirror.ts", ["--backfill", rollout], noSessionEnv, { cwd: WORK_CWD });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("backfill done. total=2 recorded=0 duplicates=2 failed=0");

    const edgeDir = path.join(CONVO_DIR, "petersen", "boss-lumeyon");
    const convo = fs.readFileSync(path.join(edgeDir, "CONVO.md"), "utf8");
    expect(convo).toContain("## boss — user turn");
    expect(convo).toContain("first prompt");
    expect(convo).toContain("working note\nfirst final");
    expect(convo).toContain("second prompt");
    expect(convo).toContain("second final");

    const ledgerLines = fs.readFileSync(path.join(edgeDir, "recorded_turns.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(ledgerLines.length).toBe(2);
    for (const ledgerLine of ledgerLines) {
      const entry = JSON.parse(ledgerLine);
      expect(entry.speaker).toBe("boss");
      expect(entry.agent).toBe("lumeyon");
    }
  });

  test("concurrent duplicate backfills succeed once ledger already has the pairs", async () => {
    initLumeyon();
    const rollout = path.join(WORK_CWD, "rollout.jsonl");
    writeRollout(rollout);

    const first = runScript("codex-rollout-mirror.ts", ["--backfill", rollout], envWith(), { cwd: WORK_CWD });
    expect(first.exitCode).toBe(0);

    const children = Array.from({ length: 5 }, () =>
      spawnScript("codex-rollout-mirror.ts", ["--backfill", rollout], envWith(), { cwd: WORK_CWD }),
    );
    const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    })));

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("failed=0");
    }

    const ledger = path.join(CONVO_DIR, "petersen", "boss-lumeyon", "recorded_turns.jsonl");
    const ledgerLines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    expect(ledgerLines.length).toBe(2);
  });

  test("flush-trailing records a Stop-hook turn before task_complete is written", () => {
    const sid = initLumeyon();
    const safeSid = sid.replace(/[^A-Za-z0-9_:.-]/g, "_");
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.json`));
    fs.unlinkSync(path.join(CONVO_DIR, ".sessions", `${safeSid}.current_speaker.json`));

    const rollout = path.join(WORK_CWD, "rollout-trailing.jsonl");
    writeTrailingRollout(rollout);

    const first = runScript("codex-rollout-mirror.ts", ["--backfill", rollout], envWith(), { cwd: WORK_CWD });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("backfill done. total=1 recorded=1 duplicates=0 failed=0");

    const edgeDir = path.join(CONVO_DIR, "petersen", "boss-lumeyon");
    let convo = fs.readFileSync(path.join(edgeDir, "CONVO.md"), "utf8");
    expect(convo).toContain("completed final");
    expect(convo).not.toContain("trailing final");

    const second = runScript("codex-rollout-mirror.ts", ["--backfill", rollout, "--flush-trailing"], envWith(), { cwd: WORK_CWD });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("backfill done. total=2 recorded=1 duplicates=1 failed=0");

    convo = fs.readFileSync(path.join(edgeDir, "CONVO.md"), "utf8");
    expect(convo).toContain("trailing prompt");
    expect(convo).toContain("trailing final");
  });
});
