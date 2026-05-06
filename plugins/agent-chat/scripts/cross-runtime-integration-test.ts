#!/usr/bin/env bun
// scripts/cross-runtime-integration-test.ts
//
// Gated live smoke for the dual-runtime promise:
//   - orion runs through the Codex adapter
//   - lumeyon runs through the Claude adapter
//   - both operate on the same filesystem-mediated agent-chat edge
//
// This is intentionally not part of default CI. It shells out to real LLM
// CLIs and can take minutes. Run with:
//
//   RUN_CROSS_RUNTIME_TEST=1 bun plugins/agent-chat/scripts/cross-runtime-integration-test.ts
//
// It skips with exit 0 unless explicitly enabled, unless either CLI is
// missing, or when AGENT_CHAT_NO_LLM=1 is present.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL_ROOT } from "./lib.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, pass: ok, detail: detail || undefined });
}

function skip(reason: string): never {
  console.log(`cross-runtime-integration-test: SKIP - ${reason}`);
  process.exit(0);
}

function which(name: string): string | null {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

if (process.env.RUN_CROSS_RUNTIME_TEST !== "1") {
  skip("set RUN_CROSS_RUNTIME_TEST=1 to run real Claude + Codex CLIs");
}
if (process.env.AGENT_CHAT_NO_LLM === "1") {
  skip("AGENT_CHAT_NO_LLM=1");
}

const claude = which("claude");
const codex = which("codex");
if (!claude) skip("`claude` not on PATH");
if (!codex) skip("`codex` not on PATH");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cross-runtime-"));
const convDir = path.join(tmpRoot, "conv");
fs.mkdirSync(convDir, { recursive: true });

const AGENT_CHAT = path.join(SKILL_ROOT, "scripts/agent-chat.ts");
const TURN = path.join(SKILL_ROOT, "scripts/turn.ts");
const edgeDir = path.join(convDir, "petersen", "lumeyon-orion");
const convoPath = path.join(edgeDir, "CONVO.md");
const turnPath = path.join(edgeDir, "CONVO.md.turn");
const lockPath = path.join(edgeDir, "CONVO.md.turn.lock");

function envFor(agent: "orion" | "lumeyon", runtime: "codex" | "claude"): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.AGENT_CHAT_CONVERSATIONS_DIR = convDir;
  env.CLAUDE_SESSION_ID = `cross-runtime-${agent}`;
  env.AGENT_CHAT_RUNTIME = runtime;
  delete env.AGENT_CHAT_NO_LLM;
  return env;
}

function run(args: string[], env: Record<string, string>, timeoutMs = 240_000) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
    cwd: SKILL_ROOT,
  });
}

const orionEnv = envFor("orion", "codex");
const lumeyonEnv = envFor("lumeyon", "claude");

console.log(
  `cross-runtime-integration-test: tmp=${tmpRoot}\n` +
  `  claude=${claude}\n` +
  `  codex=${codex}\n` +
  `  driving orion via Codex and lumeyon via Claude through agent-chat run`,
);

try {
  const oi = run([AGENT_CHAT, "init", "orion", "petersen"], orionEnv);
  check("orion init exit 0", oi.status === 0, oi.stderr);
  const li = run([AGENT_CHAT, "init", "lumeyon", "petersen"], lumeyonEnv);
  check("lumeyon init exit 0", li.status === 0, li.stderr);

  const initEdge = run([TURN, "init", "lumeyon", "orion"], orionEnv);
  check("edge initialized with turn=orion", initEdge.status === 0, initEdge.stderr);

  const seed = `\n\n---\n\n## lumeyon — cross-runtime seed (UTC ${new Date().toISOString()})\n\n` +
    `This is a live cross-runtime test. Orion should answer through Codex. ` +
    `Please include the literal token CROSS_RUNTIME_ORION_OK and end with an arrow to lumeyon.` +
    `\n\n→ orion\n`;
  fs.appendFileSync(convoPath, seed);
  check("seed section appended", fs.existsSync(convoPath));

  const orionRun = run([AGENT_CHAT, "run", "lumeyon"], orionEnv);
  check("orion cmdRun exit 0", orionRun.status === 0, orionRun.stderr.slice(0, 800));
  check("orion resolved runtime=codex", /runtime:\s+codex/i.test(orionRun.stderr), orionRun.stderr.slice(0, 800));

  const afterOrion = fs.readFileSync(convoPath, "utf8");
  check("orion section appended", /^##\s+orion\s+—/m.test(afterOrion), afterOrion.slice(-500));
  check("orion response contains requested token", afterOrion.includes("CROSS_RUNTIME_ORION_OK"), afterOrion.slice(-500));
  check("turn handed to lumeyon", fs.readFileSync(turnPath, "utf8").trim() === "lumeyon");
  check("lock released after orion", !fs.existsSync(lockPath));

  const lumeyonPrompt = `\n\n---\n\n## orion — cross-runtime handoff (UTC ${new Date().toISOString()})\n\n` +
    `Lumeyon should now answer through Claude. Please include the literal token CROSS_RUNTIME_LUMEYON_OK.` +
    `\n\n→ lumeyon\n`;
  // Leave the real orion response intact; add an explicit handoff request so
  // the second runtime gets a crisp instruction even if Codex was terse.
  fs.appendFileSync(convoPath, lumeyonPrompt);
  fs.writeFileSync(turnPath, "lumeyon\n");

  const lumeyonRun = run([AGENT_CHAT, "run", "orion"], lumeyonEnv);
  check("lumeyon cmdRun exit 0", lumeyonRun.status === 0, lumeyonRun.stderr.slice(0, 800));
  check("lumeyon resolved runtime=claude", /runtime:\s+claude/i.test(lumeyonRun.stderr), lumeyonRun.stderr.slice(0, 800));

  const finalConvo = fs.readFileSync(convoPath, "utf8");
  const lumeyonSections = finalConvo.match(/^##\s+lumeyon\s+—/gm) ?? [];
  check("lumeyon response section appended", lumeyonSections.length >= 2, finalConvo.slice(-700));
  check("lumeyon response contains requested token", finalConvo.includes("CROSS_RUNTIME_LUMEYON_OK"), finalConvo.slice(-700));
  check("turn handed back to orion", fs.readFileSync(turnPath, "utf8").trim() === "orion");
  check("lock released after lumeyon", !fs.existsSync(lockPath));
} finally {
  if (process.env.AGENT_CHAT_KEEP_TEST_TMP === "1") {
    console.log(`cross-runtime-integration-test: kept tmp=${tmpRoot}`);
  } else {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\ncross-runtime-integration-test results:\n`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  const detail = r.detail ? `\n        ${r.detail.split("\n").slice(0, 4).join("\n        ")}` : "";
  console.log(`  ${tag}  ${r.name}${detail}`);
}
console.log(`\n${passed}/${results.length} pass${failed.length ? `, ${failed.length} fail` : ""}`);

process.exit(failed.length === 0 ? 0 : 1);
