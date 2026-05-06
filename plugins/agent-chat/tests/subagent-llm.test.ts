// Real-LLM sub-agent test, gated. Skipped by default. Set RUN_LLM_TESTS=1
// to run. Spawns two `claude -p` headless sessions sequentially (orion
// first, then lumeyon) and verifies that real Claude can drive the
// agent-chat protocol end-to-end.
//
// Why gated: real-LLM tests cost API budget per run, are non-deterministic
// (model output varies), and are slow (~30-60s per round). They are NOT
// part of CI by default.
//
// Run with:
//   RUN_LLM_TESTS=1 bun test tests/subagent-llm.test.ts
//
// Requires:
//   - `claude` CLI on PATH
//   - claude.ai login or $ANTHROPIC_API_KEY
//
// Test design:
//   The harness sets up the tmpdir and edge state. Each claude run is
//   given a *very* prescriptive prompt — specific bash commands to execute
//   in order — to remove skill-matching ambiguity. We then verify:
//     - claude actually ran the commands (CONVO.md exists with the right sections)
//     - identity resolution worked under the bash-child env inheritance
//     - the lock and turn sentinel transitions completed cleanly
//   We do NOT assert on the literal text claude generated for the section
//   body, since that's non-deterministic.

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { mkTmpConversations, rmTmp, freshEnv, fakeSessionId, runScript, sessionEnv, SKILL_ROOT } from "./helpers.ts";

const RUN = process.env.RUN_LLM_TESTS === "1";
const describeIf = RUN ? describe : describe.skip;

function findClaudeCli(): string | null {
  const PATH = process.env.PATH ?? "";
  for (const p of PATH.split(path.delimiter)) {
    const f = path.join(p, "claude");
    if (fs.existsSync(f)) return f;
  }
  return null;
}

type ClaudeRun = { code: number; stdout: string; stderr: string };

function runClaude(
  claude: string,
  env: Record<string, string>,
  prompt: string,
  addDir: string,
  timeoutMs: number,
): Promise<ClaudeRun> {
  const args = [
    "-p", prompt,
    "--permission-mode", "bypassPermissions",
    "--add-dir", addDir,
    // Keep output compact and parseable.
    "--output-format", "text",
    // No persistent session — each test run is independent.
    "--no-session-persistence",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { env, cwd: SKILL_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => stdout += d.toString());
    child.stderr?.on("data", (d) => stderr += d.toString());
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describeIf("real-LLM round-trip (gated by RUN_LLM_TESTS=1)", () => {
  test("two claude -p sessions exchange one round through agent-chat", async () => {
    const claude = findClaudeCli();
    if (!claude) throw new Error("`claude` CLI not on PATH");
    const CONVO_DIR = mkTmpConversations();
    try {
      // Step 1: harness initializes the edge so each claude only has to take
      // its turn, not bootstrap the conversation.
      const orionEnv = sessionEnv(CONVO_DIR, "orion", "pair");
      const lumeyonEnv = sessionEnv(CONVO_DIR, "lumeyon", "pair");
      runScript("agent-chat.ts", ["init", "orion", "pair"], orionEnv);
      runScript("agent-chat.ts", ["init", "lumeyon", "pair"], lumeyonEnv);
      runScript("turn.ts", ["init", "lumeyon", "orion"], orionEnv);

      const edgeDir = path.join(CONVO_DIR, "pair", "lumeyon-orion");
      const convoPath = path.join(edgeDir, "CONVO.md");

      // Step 2: orion runs. Prompt is prescriptive — specific bash commands
      // in a numbered list. We reference the agent-chat scripts via absolute
      // paths so claude doesn't need to discover the skill.
      const skillScripts = path.join(SKILL_ROOT, "scripts");
      const orionPrompt = [
        "You are orion in the agent-chat pair topology. The edge has already been initialized; .turn currently says \"orion\" so it is your move.",
        "",
        "Do exactly the following bash commands in order. Do NOT improvise.",
        "",
        `1. cd ${SKILL_ROOT}`,
        `2. bun ${skillScripts}/turn.ts peek lumeyon`,
        `3. bun ${skillScripts}/turn.ts lock lumeyon`,
        `4. Append the following block to ${convoPath} (use a heredoc or any append method):`,
        "",
        "---",
        "",
        "## orion — hello (UTC 2026-05-01T12:00:00Z)",
        "",
        "hello from orion via real-claude",
        "",
        "→ lumeyon",
        "",
        `5. bun ${skillScripts}/turn.ts flip lumeyon lumeyon`,
        `6. bun ${skillScripts}/turn.ts unlock lumeyon`,
        `7. bun ${skillScripts}/turn.ts peek lumeyon  (confirm .turn is now lumeyon and lock is gone)`,
        "",
        "After step 7 finishes successfully, reply with the single word DONE and exit. If any step fails, reply with FAILED and the failing step number.",
      ].join("\n");

      const orionRun = await runClaude(claude, orionEnv, orionPrompt, CONVO_DIR, 180_000);
      if (orionRun.code !== 0) {
        throw new Error(`orion claude exited ${orionRun.code}\nstdout:\n${orionRun.stdout}\nstderr:\n${orionRun.stderr}`);
      }

      // After orion's run, CONVO.md should contain one section authored by orion
      // and .turn should be "lumeyon".
      expect(fs.existsSync(convoPath)).toBe(true);
      const convoAfterOrion = fs.readFileSync(convoPath, "utf8");
      expect(convoAfterOrion).toMatch(/^##\s+orion\s+—/m);
      const turnAfterOrion = fs.readFileSync(path.join(edgeDir, "CONVO.md.turn"), "utf8").trim();
      expect(turnAfterOrion).toBe("lumeyon");
      expect(fs.existsSync(path.join(edgeDir, "CONVO.md.turn.lock"))).toBe(false);

      // Step 3: lumeyon runs. Same shape, but ends by parking.
      const lumeyonPrompt = [
        "You are lumeyon in the agent-chat pair topology. .turn currently says \"lumeyon\" so it is your move.",
        "",
        "Do exactly the following bash commands in order. Do NOT improvise.",
        "",
        `1. cd ${SKILL_ROOT}`,
        `2. bun ${skillScripts}/turn.ts peek orion`,
        `3. bun ${skillScripts}/turn.ts lock orion`,
        `4. Append the following block to ${convoPath} (use a heredoc or any append method):`,
        "",
        "---",
        "",
        "## lumeyon — hello back (UTC 2026-05-01T12:01:00Z)",
        "",
        "hello back from lumeyon via real-claude",
        "",
        "→ END",
        "",
        `5. bun ${skillScripts}/turn.ts park orion`,
        `6. bun ${skillScripts}/turn.ts unlock orion`,
        `7. bun ${skillScripts}/turn.ts peek orion  (confirm .turn is now parked and lock is gone)`,
        "",
        "After step 7 finishes successfully, reply with the single word DONE and exit. If any step fails, reply with FAILED and the failing step number.",
      ].join("\n");

      const lumeyonRun = await runClaude(claude, lumeyonEnv, lumeyonPrompt, CONVO_DIR, 180_000);
      if (lumeyonRun.code !== 0) {
        throw new Error(`lumeyon claude exited ${lumeyonRun.code}\nstdout:\n${lumeyonRun.stdout}\nstderr:\n${lumeyonRun.stderr}`);
      }

      // Final state assertions.
      const convoFinal = fs.readFileSync(convoPath, "utf8");
      const sections = convoFinal.split(/^##\s+/m).slice(1);
      expect(sections.length).toBe(2);
      expect(sections[0].startsWith("orion")).toBe(true);
      expect(sections[1].startsWith("lumeyon")).toBe(true);

      const turnFinal = fs.readFileSync(path.join(edgeDir, "CONVO.md.turn"), "utf8").trim();
      expect(turnFinal).toBe("parked");
      expect(fs.existsSync(path.join(edgeDir, "CONVO.md.turn.lock"))).toBe(false);
    } finally {
      rmTmp(CONVO_DIR);
    }
  }, 420_000);
});

if (!RUN) {
  test("LLM sub-agent test (skipped — set RUN_LLM_TESTS=1 to run)", () => {
    expect(true).toBe(true);
  });
}
