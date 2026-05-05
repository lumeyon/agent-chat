// llm.test.ts — Round 12 slice 1 load-bearing coverage for the
// LLM-shell-out primitive. Tests use a mock claude binary that prints
// scripted output / exits with scripted code / sleeps for timeout testing.
// Real `claude` is not invoked unless RUN_LLM_TESTS=1 is set.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let TMP: string;
let MOCK_CLAUDE: string;

function makeMock(scriptBody: string): string {
  // Minimal POSIX shell mock — handles `--version` separately so the
  // module-load probe always succeeds. The substantive scriptBody runs only
  // when the binary is invoked WITHOUT --version (i.e. for the actual LLM
  // call). chmod 0755 so the binary is executable.
  const p = path.join(TMP, `claude-mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const wrapper = `#!/bin/sh
case "$1" in
  --version) echo "claude-mock 0.1.0"; exit 0 ;;
esac
${scriptBody}
`;
  fs.writeFileSync(p, wrapper, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-llm-test-"));
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // Ensure each test starts with a fresh module-level probe state.
  delete process.env.AGENT_CHAT_CLAUDE_BIN;
  delete process.env.AGENT_CHAT_NO_LLM;
  delete process.env.AGENT_CHAT_INSIDE_LLM_CALL;
});

// Helper: re-probe with a specific AGENT_CHAT_CLAUDE_BIN so each test starts
// from a fresh probe state. resetClaudeProbeForTests() lives in the module
// for exactly this reason — bun caches the module-level probed result, and
// per-test we want a different mock binary.
import * as llmModule from "../scripts/llm.ts";
async function freshLlmModule(claudeBin?: string): Promise<typeof llmModule> {
  if (claudeBin) process.env.AGENT_CHAT_CLAUDE_BIN = claudeBin;
  else delete process.env.AGENT_CHAT_CLAUDE_BIN;
  llmModule.resetClaudeProbeForTests();
  return llmModule;
}

describe("scripts/llm.ts — runClaude", () => {
  test("happy path: claude prints stdout, exits 0 → reason=ok", async () => {
    MOCK_CLAUDE = makeMock(`
      cat >/dev/null
      echo "hello from mock"
      exit 0
    `);
    const llm = await freshLlmModule(MOCK_CLAUDE);
    const r = await llm.runClaude({ prompt: "what's up?" });
    expect(r.reason).toBe("ok");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello from mock");
  });

  test("non-zero exit → reason=exit, stdout=null, stderr captured", async () => {
    MOCK_CLAUDE = makeMock(`
      cat >/dev/null
      echo "boom" >&2
      exit 7
    `);
    const llm = await freshLlmModule(MOCK_CLAUDE);
    const r = await llm.runClaude({ prompt: "x" });
    expect(r.reason).toBe("exit");
    expect(r.stdout).toBeNull();
    expect(r.code).toBe(7);
    expect(r.stderr).toContain("boom");
  });

  test("timeout fires → reason=timeout (SIGTERM after timeout, KILL after grace)", async () => {
    MOCK_CLAUDE = makeMock(`
      cat >/dev/null
      sleep 5
      echo "should not appear"
    `);
    const llm = await freshLlmModule(MOCK_CLAUDE);
    const t0 = Date.now();
    const r = await llm.runClaude({ prompt: "x", timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    expect(r.reason).toBe("timeout");
    expect(r.stdout).toBeNull();
    expect(elapsed).toBeLessThan(2000);  // resolved promptly on timeout
  });

  test("AGENT_CHAT_CLAUDE_BIN not on PATH → reason=not-found", async () => {
    const llm = await freshLlmModule("/nonexistent/path/claude");
    const r = await llm.runClaude({ prompt: "x" });
    // Probe fails (file doesn't exist), so the helper short-circuits with not-found.
    expect(r.reason).toBe("not-found");
    expect(r.stdout).toBeNull();
  });

  test("reentrancy: AGENT_CHAT_INSIDE_LLM_CALL=1 → reason=reentrancy without spawn", async () => {
    MOCK_CLAUDE = makeMock(`echo "should not be called"\nexit 1`);
    const llm = await freshLlmModule(MOCK_CLAUDE);
    process.env.AGENT_CHAT_INSIDE_LLM_CALL = "1";
    try {
      const r = await llm.runClaude({ prompt: "x" });
      expect(r.reason).toBe("reentrancy");
      expect(r.stdout).toBeNull();
    } finally {
      delete process.env.AGENT_CHAT_INSIDE_LLM_CALL;
    }
  });

  test("child env scrubbed of agent-chat identity vars; AGENT_CHAT_INSIDE_LLM_CALL=1 set", async () => {
    // Mock prints the values of the relevant env vars on stdout.
    MOCK_CLAUDE = makeMock(`
      cat >/dev/null
      echo "AGENT_NAME=$AGENT_NAME"
      echo "AGENT_TOPOLOGY=$AGENT_TOPOLOGY"
      echo "AGENT_CHAT_USER=$AGENT_CHAT_USER"
      echo "AGENT_CHAT_INSIDE_LLM_CALL=$AGENT_CHAT_INSIDE_LLM_CALL"
      exit 0
    `);
    process.env.AGENT_NAME = "should-be-scrubbed";
    process.env.AGENT_TOPOLOGY = "should-be-scrubbed";
    process.env.AGENT_CHAT_USER = "should-be-scrubbed";
    try {
      const llm = await freshLlmModule(MOCK_CLAUDE);
      const r = await llm.runClaude({ prompt: "x" });
      expect(r.reason).toBe("ok");
      expect(r.stdout).toContain("AGENT_NAME=\n");           // scrubbed → empty
      expect(r.stdout).toContain("AGENT_TOPOLOGY=\n");       // scrubbed → empty
      expect(r.stdout).toContain("AGENT_CHAT_USER=\n");      // scrubbed → empty
      expect(r.stdout).toContain("AGENT_CHAT_INSIDE_LLM_CALL=1");  // explicitly set
    } finally {
      delete process.env.AGENT_NAME;
      delete process.env.AGENT_TOPOLOGY;
      delete process.env.AGENT_CHAT_USER;
    }
  });
});

describe("scripts/llm.ts — isLlmEnabled precedence chain", () => {
  test("--llm + --no-llm together → conflict (caller responsibility to die)", async () => {
    const llm = await freshLlmModule();
    const r = llm.isLlmEnabled({ llmFlag: true, noLlmFlag: true });
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("conflict");
  });

  test("--no-llm flag → disabled (env-disabled would also disable but flag wins)", async () => {
    const llm = await freshLlmModule();
    const r = llm.isLlmEnabled({ noLlmFlag: true });
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("no-llm-flag");
  });

  test("AGENT_CHAT_NO_LLM=1 env → disabled", async () => {
    const llm = await freshLlmModule();
    process.env.AGENT_CHAT_NO_LLM = "1";
    try {
      const r = llm.isLlmEnabled({});
      expect(r.enabled).toBe(false);
      expect(r.reason).toBe("env-disabled");
    } finally {
      delete process.env.AGENT_CHAT_NO_LLM;
    }
  });

  test("--llm overrides AGENT_CHAT_NO_LLM=1 (explicit user opt-in)", async () => {
    MOCK_CLAUDE = makeMock(`exit 0`);
    process.env.AGENT_CHAT_NO_LLM = "1";
    try {
      const llm = await freshLlmModule(MOCK_CLAUDE);
      const r = llm.isLlmEnabled({ llmFlag: true });
      expect(r.enabled).toBe(true);
      expect(r.reason).toBe("llm-flag");
    } finally {
      delete process.env.AGENT_CHAT_NO_LLM;
    }
  });

  test("probe fails (claude unavailable) → disabled with probe-failed reason", async () => {
    const llm = await freshLlmModule("/nonexistent/path/claude");
    const r = llm.isLlmEnabled({});
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("probe-failed");
  });

  test("default-on when probe succeeds + no flags + no env disable", async () => {
    MOCK_CLAUDE = makeMock(`echo "0.1.0"; exit 0`);
    const llm = await freshLlmModule(MOCK_CLAUDE);
    const r = llm.isLlmEnabled({});
    expect(r.enabled).toBe(true);
    expect(r.reason).toBe("default-on");
  });
});
