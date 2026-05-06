import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freshEnv, mkTmpConversations, rmTmp, runScript, sessionEnv } from "./helpers.ts";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) rmTmp(d);
  tmpDirs = [];
});

function tmpConversations(): string {
  const d = mkTmpConversations();
  tmpDirs.push(d);
  return d;
}

function writeEdgeTurn(conv: string, edgeId: string, turn: string): void {
  const dir = path.join(conv, "petersen", edgeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "CONVO.md"), "# test\n");
  fs.writeFileSync(path.join(dir, "CONVO.md.turn"), turn);
}

describe("autowatch", () => {
  test("dry-run invokes the plugin run command when an edge is pending", () => {
    const conv = tmpConversations();
    writeEdgeTurn(conv, "lumeyon-orion", "lumeyon");
    const env = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: conv });
    const r = runScript("autowatch.ts", [
      "lumeyon",
      "petersen",
      "--peer",
      "orion",
      "--runtime",
      "codex",
      "--once",
      "--dry-run",
    ], env);
    expect(r.stderr).toContain("watching lumeyon@petersen");
    expect(r.stderr).toContain("pending=orion");
    expect(r.stdout).toContain("dry-run:");
    expect(r.stdout).toContain("agent-chat.ts run orion");
    expect(fs.readFileSync(path.join(conv, "petersen/lumeyon-orion/CONVO.md.turn"), "utf8").trim()).toBe("lumeyon");
  });

  test("dry-run stays idle when the turn belongs to the peer", () => {
    const conv = tmpConversations();
    writeEdgeTurn(conv, "lumeyon-orion", "orion");
    const env = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: conv });
    const r = runScript("autowatch.ts", [
      "lumeyon",
      "petersen",
      "--peer",
      "orion",
      "--runtime",
      "codex",
      "--once",
      "--dry-run",
    ], env);
    expect(r.stderr).toContain("idle");
    expect(r.stdout).not.toContain("dry-run:");
  });

  test("agent-chat autowatch delegates to the plugin watcher", () => {
    const conv = tmpConversations();
    writeEdgeTurn(conv, "lumeyon-orion", "lumeyon");
    const env = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: conv });
    const r = runScript("agent-chat.ts", [
      "autowatch",
      "lumeyon",
      "petersen",
      "--peer",
      "orion",
      "--runtime",
      "codex",
      "--once",
      "--dry-run",
    ], env);
    expect(r.stderr).toContain("watching lumeyon@petersen");
    expect(r.stdout).toContain("agent-chat.ts run orion");
  });

  test("refuses to impersonate an agent that already has live presence", () => {
    const conv = tmpConversations();
    writeEdgeTurn(conv, "lumeyon-orion", "lumeyon");
    const liveEnv = sessionEnv(conv, "lumeyon", "petersen", "live-lumeyon");
    runScript("agent-chat.ts", ["init", "lumeyon", "petersen"], liveEnv);
    const watcherEnv = freshEnv({
      AGENT_CHAT_CONVERSATIONS_DIR: conv,
      CLAUDE_SESSION_ID: "watcher-lumeyon",
    });
    const r = runScript("autowatch.ts", [
      "lumeyon",
      "petersen",
      "--peer",
      "orion",
      "--runtime",
      "codex",
      "--once",
      "--dry-run",
    ], watcherEnv);
    expect(r.stderr).toContain("already live");
    expect(r.stderr).toContain("refusing autowatch impersonation");
    expect(r.stdout).not.toContain("dry-run:");
  });

  test("systemd installer dry-run emits a Codex-backed unit", () => {
    const conv = tmpConversations();
    const env = freshEnv({ AGENT_CHAT_CONVERSATIONS_DIR: conv });
    const r = runScript("install-autowatch-systemd.ts", [
      "lumeyon",
      "petersen",
      "--peer",
      "orion",
      "--runtime",
      "codex",
      "--dry-run",
    ], env);
    expect(r.stdout).toContain("unit_path=");
    expect(r.stdout).toContain("ExecStart=");
    expect(r.stdout).toContain("agent-chat.ts autowatch lumeyon petersen");
    expect(r.stdout).toContain("--runtime codex");
    expect(r.stdout).toContain("--peer orion");
    expect(r.stdout).toContain("Restart=on-failure");
    expect(r.stdout).toContain(`Environment=\"AGENT_CHAT_CONVERSATIONS_DIR=${conv}\"`);
  });
});
