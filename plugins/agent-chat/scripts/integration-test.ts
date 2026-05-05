#!/usr/bin/env bun
// scripts/integration-test.ts — real cmdRun + real LLM end-to-end smoke.
//
// Round-15j-A: closes the biggest "claim vs reality" gap in the codebase.
// Pre-fix:
//   - self-test exercises the wire protocol with synthetic agents but no
//     LLM (cmdRun is bypassed via direct turn.ts manipulation).
//   - llm-smoke exercises the LLM (claude -p) but with controlled
//     verbatim-emit prompts that bypass cmdRun's prompt-composition path.
//   - network-test exercises the Dot Collector at scale but plants dots
//     directly via lib helpers — no LLM, no cmdRun.
// So nobody had observed the FULL pipeline working end-to-end:
//   peer section → cmdRun reads → composes prompt → claude -p → parse
//   directives → write section + flip turn + persist dot/scratch.
//
// This test plants a realistic two-agent setup (orion + lumeyon on
// petersen with their lumeyon-orion edge initialized), writes a peer
// section asking orion to grade lumeyon's clarity, runs `agent-chat run`
// as orion, and asserts the side effects:
//   - CONVO.md grew with an orion section
//   - .turn flipped off orion (to lumeyon, parked, or some valid state)
//   - .dots/lumeyon.jsonl appended a dot from orion (if LLM complied)
//   - The pipeline didn't crash, didn't deadlock, didn't leave the lock
//     file behind
//
// Cost: ~1-2 real LLM calls per run (~$0.05-0.10 on Opus, ~30-90s).
// Gated on `claude` being on PATH; skips with exit 0 otherwise.
//
// Invocation:
//   bun "$AGENT_CHAT_DIR/scripts/integration-test.ts"
//   bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" integration-test
//   AGENT_CHAT_NO_LLM=1 → exits 0 with skip message

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL_ROOT } from "./lib.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, pass: ok, detail: detail || undefined });
}

// ── Skip gates ────────────────────────────────────────────────────────────

if (process.env.AGENT_CHAT_NO_LLM === "1") {
  console.log("integration-test: SKIP — AGENT_CHAT_NO_LLM=1");
  process.exit(0);
}
const which = spawnSync("which", ["claude"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  console.log("integration-test: SKIP — `claude` not on PATH");
  process.exit(0);
}

// ── Setup ─────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-integ-"));
const convDir = path.join(tmpRoot, "conv");
fs.mkdirSync(convDir, { recursive: true });

const AGENT_CHAT = path.join(SKILL_ROOT, "scripts/agent-chat.ts");
const TURN = path.join(SKILL_ROOT, "scripts/turn.ts");

const ORION_SID = "integ-orion";
const LUMEYON_SID = "integ-lumeyon";
const orionEnv = {
  AGENT_CHAT_CONVERSATIONS_DIR: convDir,
  CLAUDE_SESSION_ID: ORION_SID,
};
const lumeyonEnv = {
  AGENT_CHAT_CONVERSATIONS_DIR: convDir,
  CLAUDE_SESSION_ID: LUMEYON_SID,
};

function run(args: string[], envOverride: Record<string, string> = {}, stdin?: string) {
  return spawnSync("bun", args, {
    encoding: "utf8",
    timeout: 180_000, // 3min cap — accommodates slow LLM ticks
    env: { ...(process.env as Record<string, string>), ...envOverride },
    input: stdin,
  });
}

console.log(`integration-test: tmp=${tmpRoot}\n  driving real \`claude -p\` through cmdRun (~1 LLM call, ~30-90s)`);

try {
  // 1. Init both sessions in the shared conv dir.
  const oi = run([AGENT_CHAT, "init", "orion", "petersen"], orionEnv);
  check("orion init exit 0", oi.status === 0, oi.stderr);
  const li = run([AGENT_CHAT, "init", "lumeyon", "petersen"], lumeyonEnv);
  check("lumeyon init exit 0", li.status === 0, li.stderr);

  // 2. As lumeyon: init the edge with turn=orion (orion holds the floor),
  //    plant a peer section asking orion to respond + grade clarity.
  const initEdge = run([TURN, "init", "orion", "orion"], lumeyonEnv);
  check("edge init turn=orion exit 0", initEdge.status === 0, initEdge.stderr);

  const convoPath = path.join(convDir, "petersen/lumeyon-orion/CONVO.md");
  const peerSection = `\n\n---\n\n## lumeyon — integration test ping (UTC ${new Date().toISOString()})\n\n` +
    `Hi orion. This is an end-to-end integration test of cmdRun + real LLM. ` +
    `Please respond with a one-line acknowledgement section ending with → parked. ` +
    `Also grade my clarity by appending the directive: <dot peer="lumeyon" clarity="8" depth="7" reliability="8" speed="7" note="integ-test grade" />` +
    `\n\n→ orion\n`;
  fs.appendFileSync(convoPath, peerSection);
  check("peer section appended to CONVO.md", fs.existsSync(convoPath));

  // 3. Set lumeyon as orion's speaker so cmdRun routes to the lumeyon-orion edge.
  const speak = run([AGENT_CHAT, "speaker", "lumeyon"], orionEnv);
  check("orion speaker → lumeyon exit 0", speak.status === 0, speak.stderr);

  // 4. THE LOAD-BEARING CALL: run cmdRun as orion against the lumeyon-orion edge.
  //    This shells out to claude -p with the composed prompt. Costs $$$.
  console.log(`  invoking real claude -p (this is the slow + expensive call)...`);
  const start = Date.now();
  const cr = run([AGENT_CHAT, "run", "lumeyon"], orionEnv);
  const elapsed = Date.now() - start;
  console.log(`  cmdRun returned in ${elapsed}ms, exit=${cr.status}`);
  check("cmdRun exited 0 (no crash, no deadlock)", cr.status === 0, `stderr=${(cr.stderr ?? "").slice(0, 400)}`);

  // 5. Verify side effects on the edge.
  const finalConvo = fs.readFileSync(convoPath, "utf8");
  const orionSectionMatches = finalConvo.match(/^## orion — /gm) ?? [];
  check("orion appended ≥1 new section to CONVO.md", orionSectionMatches.length >= 1,
    `convo tail: ${finalConvo.slice(-300)}`);

  const turnFile = path.join(convDir, "petersen/lumeyon-orion/CONVO.md.turn");
  const turn = fs.readFileSync(turnFile, "utf8").trim();
  check("turn flipped off orion (to lumeyon or parked)",
    turn === "lumeyon" || turn === "parked",
    `turn=${turn}`);

  const lockFile = path.join(convDir, "petersen/lumeyon-orion/CONVO.md.turn.lock");
  check("lock released (no orphaned .turn.lock)", !fs.existsSync(lockFile));

  // 6. Verify the <dot/> directive was parsed and persisted (only if LLM
  //    complied — soft check, not load-bearing since LLMs sometimes
  //    paraphrase or omit directives).
  const dotsPath = path.join(convDir, ".dots/lumeyon.jsonl");
  if (fs.existsSync(dotsPath)) {
    const dots = fs.readFileSync(dotsPath, "utf8").split("\n").filter(Boolean);
    if (dots.length > 0) {
      const dot = JSON.parse(dots[0]);
      check("dot directive parsed: <conv>/.dots/lumeyon.jsonl populated", dot.grader === "orion",
        `grader=${dot.grader}, axes=${JSON.stringify(dot.axes)}`);
    } else {
      check("dot ledger exists but empty (LLM may have omitted directive — soft)",
        true, "(soft pass — LLM compliance varies)");
    }
  } else {
    check("dot ledger absent (LLM omitted <dot/> directive — soft)",
      true, "(soft pass — LLM compliance varies; the parser path is hermetic-tested in self-test)");
  }

  // 7. Verify the per-tick auto-archive wiring didn't crash even though the
  //    edge is well under threshold (no archive should have happened).
  const archivesDir = path.join(convDir, "petersen/lumeyon-orion/archives");
  const archives = fs.existsSync(archivesDir) ? fs.readdirSync(archivesDir).filter((f) => !f.startsWith(".")) : [];
  check("no archive sealed for under-threshold edge (200-line gate)", archives.length === 0,
    `archives=${archives.join(",")}`);
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// ── Summary ────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const wantJson = process.argv.includes("--json");

if (wantJson) {
  console.log(JSON.stringify({ total: results.length, passed, failed: failed.length, results }, null, 2));
} else {
  console.log(`\nintegration-test results:\n`);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    const detail = r.detail ? `\n        ${r.detail.split("\n").slice(0, 3).join("\n        ")}` : "";
    console.log(`  ${tag}  ${r.name}${detail}`);
  }
  console.log(`\n${passed}/${results.length} pass${failed.length ? `, ${failed.length} fail` : ""}`);
}

process.exit(failed.length === 0 ? 0 : 1);
