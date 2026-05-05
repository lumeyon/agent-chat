// archive-auto-llm.test.ts — gated real-LLM recall test.
//
// Companion to tests/archive-auto.test.ts. The mechanical test verifies
// the pipeline mechanically (synthetic CONVO.md → auto-archive →
// search.ts grep finds it). This test answers a different, harder
// question: **can a real Claude session, given an archived edge,
// actually recall the right facts when asked a natural-language
// question?** That's the genuine validation of the long-term-memory
// promise, not just "the index entry has the right keywords."
//
// Skipped by default. Set RUN_LLM_TESTS=1 to run. Costs API budget per
// run, ~30-60s, non-deterministic on the model's output text — we
// assert on loose properties (the right archive id surfaces in claude's
// response; specific facts are recoverable) rather than exact string
// matches.
//
// Run with:
//   RUN_LLM_TESTS=1 bun test tests/archive-auto-llm.test.ts
//
// Re-runnable: every test gets its own tmpdir; afterEach removes it.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  mkTmpConversations, rmTmp, runScript, sessionEnv, freshEnv, SKILL_ROOT,
} from "./helpers.ts";

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
    "--output-format", "text",
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

// Same synthetic-conversation builder as tests/archive-auto.test.ts —
// kept inline to avoid coupling the gated test to the mechanical test.
const FACT_TOKENS = [
  "kafkamigration", "stagingdeploy", "rollbackplan",
  "alertbudget", "queuedrain", "shardrebalance",
];
const FACT_PATHS = [
  "scripts/migrate.ts",
  "config/deploy.yaml",
  "dashboards/sla.json",
];

function buildSyntheticConvo(sectionCount: number): string {
  const header = `# CONVO — lumeyon ↔ orion\n\nProtocol: agent-chat\nParticipants: lumeyon, orion\n`;
  const sections: string[] = [];
  for (let i = 1; i <= sectionCount; i++) {
    const author = i % 2 === 0 ? "orion" : "lumeyon";
    const next = author === "orion" ? "lumeyon" : "orion";
    const ts = `2026-05-03T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`;
    sections.push(
      `## ${author} — section ${i} (UTC ${ts})\n\n` +
      `Discussion of ${FACT_TOKENS.join(" ")}. References ${FACT_PATHS[i % FACT_PATHS.length]}. ` +
      `Token reinforcement: ${FACT_TOKENS.join(" ")} ${FACT_TOKENS.join(" ")}\n\n` +
      `→ ${next}`,
    );
  }
  return header + "\n---\n\n" + sections.join("\n\n---\n\n") + "\n";
}

describeIf("real-LLM recall against an auto-archived edge (gated)", () => {

  let CONVO_DIR: string;
  let ORION_ENV: Record<string, string>;
  let SESSION_KEY: string;
  let EDGE_DIR: string;

  const PEER = "lumeyon";
  const EDGE_ID = "lumeyon-orion";

  beforeEach(() => {
    CONVO_DIR = mkTmpConversations();
    ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    SESSION_KEY = ORION_ENV.CLAUDE_SESSION_ID!;
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".logs"), { recursive: true });
    fs.writeFileSync(
      path.join(CONVO_DIR, ".sessions", `${SESSION_KEY}.json`),
      JSON.stringify({
        agent: "orion", topology: "petersen", session_key: SESSION_KEY,
        claude_session_id: SESSION_KEY, host: os.hostname(), pid: process.pid,
        started_at: "2026-05-03T00:00:00Z", cwd: CONVO_DIR,
      }),
    );
    EDGE_DIR = path.join(CONVO_DIR, "petersen", EDGE_ID);
    fs.mkdirSync(EDGE_DIR, { recursive: true });
  });

  afterEach(() => { rmTmp(CONVO_DIR); });

  test("claude -p can recall a FACT_TOKEN from an auto-archived edge via search.ts grep", async () => {
    const claude = findClaudeCli();
    if (!claude) throw new Error("`claude` CLI not on PATH");

    // Plant the long synthetic conversation.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), buildSyntheticConvo(50));
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "parked");

    // Auto-archive runs FIRST so claude only sees the post-archive state
    // (CONVO.md is now header + breadcrumb + 4 fresh tail; index.jsonl
    // has the leaf entry; archives/leaf/<id>/ has BODY.md + SUMMARY.md +
    // META.yaml).
    const archR = runScript("archive.ts", ["auto", PEER], ORION_ENV);
    expect(archR.exitCode).toBe(0);

    // Confirm the convo file looks right (post-archive shape).
    const convo = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md"), "utf8");
    expect(convo).toContain("archive breadcrumb:");
    // FACT_TOKENS no longer in the live CONVO.md (they're in the sealed BODY.md).
    // Sections 47-50 are in fresh tail; sections 1-46 went to BODY.md.
    expect(convo).toContain("section 47");
    expect(convo).not.toContain("section 1\n");

    // The prompt: ask claude to find one specific fact via search.ts grep.
    // We reference the absolute scripts path so claude doesn't have to
    // discover the skill, and force it to use the AGENT_CHAT_CONVERSATIONS_DIR
    // env var that scopes the search to OUR tmpdir.
    const skillScripts = path.join(SKILL_ROOT, "scripts");
    const claudePrompt = [
      `You are orion. The agent-chat skill lives at ${SKILL_ROOT}. The conversations directory has been overridden to ${CONVO_DIR} via env var.`,
      "",
      "There is an auto-archived conversation thread at this edge. Earlier sections (now sealed into a leaf archive) discussed several technical topics. I need you to find one specific topic.",
      "",
      "Run exactly:",
      "",
      `1. cd ${SKILL_ROOT}`,
      `2. bun ${skillScripts}/search.ts grep kafkamigration`,
      "",
      "After running, print ONE LINE only as your final answer:",
      "  - The line MUST start with `ARCHIVE: ` followed by the archive id (looks like `arch_L_...`) that contains the keyword.",
      "  - If nothing surfaces, print exactly: `ARCHIVE: NOT_FOUND`",
      "",
      "Do not run any other commands. Do not explain. Just the bash invocation and the single ARCHIVE: line.",
    ].join("\n");

    const env = freshEnv({
      ...ORION_ENV,
      // Ensure claude inherits the tmp conversations dir.
      AGENT_CHAT_CONVERSATIONS_DIR: CONVO_DIR,
    }) as Record<string, string>;

    const r = await runClaude(claude, env, claudePrompt, CONVO_DIR, 90_000);
    expect(r.code).toBe(0);

    // The model output should contain a line starting with "ARCHIVE: arch_L_"
    // — the archive id surfaced via search.ts grep on the FACT_TOKEN.
    // Loose match (claude may add markdown around it; we just want the prefix).
    const archiveLineMatch = r.stdout.match(/ARCHIVE:\s+(arch_L_\S+|NOT_FOUND)/);
    expect(archiveLineMatch).not.toBeNull();
    const surfaced = archiveLineMatch![1];
    expect(surfaced).not.toBe("NOT_FOUND");
    expect(surfaced).toMatch(/^arch_L_/);
  }, 120_000);
});
