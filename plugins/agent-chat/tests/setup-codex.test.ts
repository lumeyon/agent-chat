// setup-codex.test.ts — verify the one-shot Codex install orchestration.
//
// `setup-codex` collapses init + speaker + install-codex-hooks (+ optional
// autowatch service) into a single command. The contract under test:
//
//   1. With --speaker + --no-service: identity claimed, speaker set,
//      Codex hooks files written; no systemd unit attempted.
//   2. With --speaker omitted: still succeeds (users.yaml default applies
//      at record-turn time); cwd-state has no speaker yet.
//   3. With --no-service NOT set but --peer also missing: skip autowatch,
//      print the manual-run hint.
//   4. Bad args (missing positional) exits non-zero with usage text.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { mkTmpConversations, rmTmp, runScript, freshEnv, fakeSessionId } from "./helpers.ts";

let CONVO_DIR: string;
let WORK_CWD: string;
let FAKE_HOME: string;
let BASE_ENV: Record<string, string>;

function envWith(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

function cwdStateFile(conv: string, cwd: string): string {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(conv, ".cwd-state", `${hash}.json`);
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  WORK_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "setup-codex-test-"));
  FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "setup-codex-home-"));
  BASE_ENV = freshEnv({
    AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR,
    HOME: FAKE_HOME,
  }) as Record<string, string>;
});

afterEach(() => {
  rmTmp(CONVO_DIR);
  fs.rmSync(WORK_CWD, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("setup-codex — orchestrates the four install steps", () => {
  test("--speaker + --no-service writes identity, speaker, and Codex config but no systemd unit", () => {
    const sid = fakeSessionId();
    const r = runScript(
      "agent-chat.ts",
      ["setup-codex", "lumeyon", "petersen", "--speaker", "boss", "--peer", "orion", "--no-service"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD },
    );
    expect(r.exitCode).toBe(0);

    // Step 1: init wrote the cwd-state + session record.
    const state = JSON.parse(fs.readFileSync(cwdStateFile(CONVO_DIR, WORK_CWD), "utf8"));
    expect(state.agent).toBe("lumeyon");
    expect(state.topology).toBe("petersen");

    // Step 2: speaker was set, edge_id derived.
    expect(state.speaker).toBe("boss");
    expect(state.edge_id).toBe("boss-lumeyon");

    // Step 3: Codex hooks files written.
    const configToml = fs.readFileSync(path.join(FAKE_HOME, ".codex", "config.toml"), "utf8");
    expect(configToml).toMatch(/\[features\][\s\S]*codex_hooks\s*=\s*true/);
    expect(configToml).toMatch(/\[plugins\.["']agent-chat@agent-chat-marketplace["']\][\s\S]*enabled\s*=\s*true/);
    const hooksJson = JSON.parse(fs.readFileSync(path.join(FAKE_HOME, ".codex", "hooks.json"), "utf8"));
    const hookCmds: string[] = (hooksJson.hooks?.Stop ?? [])
      .flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
    expect(hookCmds.some((c) => c.includes("codex-stop-hook.ts"))).toBe(true);

    // Step 4: --no-service path — no systemd attempt; output hints at manual run.
    expect(r.stdout).toMatch(/skipping systemd install/);
    expect(r.stdout).toMatch(/autowatch lumeyon petersen/);
  });

  test("--speaker omitted still succeeds; cwd-state has no speaker", () => {
    const sid = fakeSessionId();
    const r = runScript(
      "agent-chat.ts",
      ["setup-codex", "lumeyon", "petersen", "--no-service"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD },
    );
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(fs.readFileSync(cwdStateFile(CONVO_DIR, WORK_CWD), "utf8"));
    expect(state.agent).toBe("lumeyon");
    expect(state.speaker).toBeUndefined();
    expect(r.stdout).toMatch(/users\.yaml default resolution/);
  });

  test("--peer omitted skips autowatch with the right hint", () => {
    const sid = fakeSessionId();
    const r = runScript(
      "agent-chat.ts",
      ["setup-codex", "lumeyon", "petersen", "--speaker", "boss"],
      envWith({ CLAUDE_SESSION_ID: sid }),
      { cwd: WORK_CWD },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no --peer specified; skipping autowatch/);
  });

  test("missing positional args exits with usage text", () => {
    const r = runScript(
      "agent-chat.ts",
      ["setup-codex", "lumeyon"],
      envWith({}),
      { cwd: WORK_CWD, allowFail: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/usage: agent-chat\.ts setup-codex/);
  });

  test("unknown option exits 70", () => {
    const r = runScript(
      "agent-chat.ts",
      ["setup-codex", "lumeyon", "petersen", "--bogus"],
      envWith({}),
      { cwd: WORK_CWD, allowFail: true },
    );
    expect(r.exitCode).toBe(70);
    expect(r.stderr).toMatch(/unknown option --bogus/);
  });
});
