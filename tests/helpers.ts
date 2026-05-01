// Shared test helpers. Every test gets a fresh tmpdir for conversations
// state, plus a scrubbed env so the real $HOME / $AGENT_NAME / $CLAUDE_SESSION_ID
// can't leak into resolution and hide bugs.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

export const SKILL_ROOT = path.resolve(import.meta.dirname, "..");
export const SCRIPTS = path.join(SKILL_ROOT, "scripts");

export function mkTmpConversations(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-test-"));
  return dir;
}

export function rmTmp(dir: string): void {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Build a clean env for a test run. Strips any host AGENT_* / CLAUDE_SESSION_*
// vars so resolution behaves the same regardless of who runs the suite.
export function freshEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith("AGENT_")) continue;
    if (k.startsWith("CLAUDE_SESSION_") || k.startsWith("CLAUDE_CODE_SESSION_")) continue;
    base[k] = v;
  }
  return { ...base, ...extra };
}

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  opts: { cwd?: string; allowFail?: boolean } = {},
): RunResult {
  const scriptPath = path.isAbsolute(script) ? script : path.join(SCRIPTS, script);
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: opts.cwd ?? SKILL_ROOT,
    env: { ...env },
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (!opts.allowFail && r.status !== 0) {
    throw new Error(
      `script ${path.basename(script)} ${args.join(" ")} exited ${r.status}\n` +
      `stderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
  }
  return { exitCode: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}

// Async variant — used when we need a long-running child (subagent simulator).
export function spawnScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  opts: SpawnOptions = {},
) {
  const scriptPath = path.isAbsolute(script) ? script : path.join(SCRIPTS, script);
  return spawn(process.execPath, [scriptPath, ...args], {
    cwd: opts.cwd ?? SKILL_ROOT,
    env: { ...env },
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

// Build a unique CLAUDE_SESSION_ID so each test session resolves to its own
// .sessions/<key>.json record. Tests use this to simulate distinct shells.
export function fakeSessionId(label = ""): string {
  return `test-${label}-${crypto.randomBytes(4).toString("hex")}`;
}

// Convenience: env for a session of agent <name> in <topology> using a
// distinct session id, pointing at the given conversations dir.
export function sessionEnv(
  conversationsDir: string,
  agent: string,
  topology = "petersen",
  sessionId?: string,
): Record<string, string> {
  return freshEnv({
    AGENT_CHAT_CONVERSATIONS_DIR: conversationsDir,
    CLAUDE_SESSION_ID: sessionId ?? fakeSessionId(agent),
    // Surface a friendly tag in spawn logs without affecting resolution.
    AGENT_CHAT_TEST_TAG: `${agent}@${topology}`,
  }) as Record<string, string>;
}

// Read the on-disk session record for a given key (used by identity tests).
export function readSession(conversationsDir: string, key: string): any | null {
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const f = path.join(conversationsDir, ".sessions", `${safe}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
