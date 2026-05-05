#!/usr/bin/env bun
// scripts/llm-smoke.ts — real-LLM directive parsing smoke test.
//
// Round-15i Items 3-5: the <dispatch>, <dot>, <scratch>, <archive> directives
// are all wired into cmdRun and validated hermetically via self-test
// (parser regexes against synthetic strings). Gap: nobody has confirmed
// the regexes actually fire on REAL claude -p output, where wrapping,
// markdown formatting, leading whitespace, or trailing commentary could
// silently mismatch.
//
// This script shells out to claude -p with a tightly-controlled prompt
// asking the LLM to emit each directive shape verbatim, then runs the
// same regex used in cmdRun against the output. PASS if every directive
// is detected; FAIL if the LLM-output-to-parser pipeline silently breaks.
//
// Gated on \`claude\` being on PATH. If absent, exits 0 with a SKIP message
// so CI without LLM credentials still passes.
//
// Invocation:
//   bun "$AGENT_CHAT_DIR/scripts/llm-smoke.ts"
//   bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" llm-smoke
//   AGENT_CHAT_NO_LLM=1 bun ... → exits 0 with skip message
//
// Costs ~1 LLM call per directive (4 calls total = ~$0.05 on Opus).

import { spawnSync } from "node:child_process";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, pass: ok, detail: detail || undefined });
}

// ── PATH probe ─────────────────────────────────────────────────────────────

if (process.env.AGENT_CHAT_NO_LLM === "1") {
  console.log("llm-smoke: SKIP — AGENT_CHAT_NO_LLM=1 in environment");
  process.exit(0);
}
const which = spawnSync("which", ["claude"], { encoding: "utf8" });
if (which.status !== 0 || !which.stdout.trim()) {
  console.log("llm-smoke: SKIP — \`claude\` not on PATH (cannot exercise real LLM directive output)");
  process.exit(0);
}
const claudeBin = which.stdout.trim();

// ── prompt template ───────────────────────────────────────────────────────

// Each test runs claude -p with a strict "emit exactly this verbatim, no
// commentary, no markdown fence" prompt. The LLM's output is fed into the
// same regex cmdRun uses to extract the directive.

function runClaude(prompt: string, timeoutMs = 60_000): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(claudeBin, ["-p", prompt], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, AGENT_CHAT_INSIDE_LLM_CALL: "1" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
}

// ── parser regexes (must mirror cmdRun's — drift is the bug we're catching) ─

// <archive> — multi-line block. Matches cmdRun line ~1589.
const ARCHIVE_RE = /<archive>([\s\S]*?)<\/archive>/i;
// <dispatch peer="X">prompt</dispatch>. Matches cmdRun line ~1608.
const DISPATCH_RE = /<dispatch\s+peer=["']([a-z0-9_-]+)["']\s*>([\s\S]*?)<\/dispatch>/i;
// <dot peer="X" axes="..." note="..." />. Self-closing. Matches cmdRun line ~1629.
const DOT_RE = /<dot\s+([^>]+?)\s*\/>/i;
// <scratch>...</scratch>. Multi-line.
const SCRATCH_RE = /<scratch>([\s\S]*?)<\/scratch>/i;

// ── tests ─────────────────────────────────────────────────────────────────

console.log(`llm-smoke: shelling out to ${claudeBin} (4 calls, ~30-90s each)\n`);

(async () => {
  // 1. <dot> directive — the most likely to drift since attribute order
  //    and quote style vary across LLM completions.
  {
    const stdout = runClaude(
      `Output exactly the following XML tag verbatim with no preamble, no commentary, no markdown code fences, no surrounding text. Just the raw tag on a single line:\n\n` +
      `<dot peer="lumeyon" clarity="9" depth="8" reliability="9" speed="7" note="round-15i smoke" />`,
    ).stdout;
    const m = stdout.match(DOT_RE);
    check("<dot/> regex matches real LLM output", m != null, `stdout=${stdout.slice(0, 200)}`);
    if (m) {
      const attrs = m[1];
      check("  → attrs contain peer=lumeyon", /peer=["']lumeyon["']/.test(attrs));
      check("  → attrs contain clarity=9", /clarity=["']?9["']?/.test(attrs));
      check("  → attrs contain note=round-15i smoke",
        /note=["']round-15i smoke["']/.test(attrs),
        `attrs=${attrs}`);
    }
  }

  // 2. <dispatch> directive — multi-line body, the case most likely to
  //    fail if the LLM adds whitespace or wraps the body.
  {
    const stdout = runClaude(
      `Output exactly the following XML block verbatim. No preamble, no commentary, no markdown fences. Just the block:\n\n` +
      `<dispatch peer="lyra">Please review the round-15i changes and confirm.</dispatch>`,
    ).stdout;
    const m = stdout.match(DISPATCH_RE);
    check("<dispatch peer=...> regex matches real LLM output", m != null, `stdout=${stdout.slice(0, 200)}`);
    if (m) {
      check("  → captured peer = lyra", m[1] === "lyra", `got: ${m[1]}`);
      check("  → captured prompt non-empty + matches",
        /round-15i changes/.test(m[2].trim()),
        `prompt=${m[2].trim().slice(0, 80)}`);
    }
  }

  // 3. <scratch> directive — multi-line body of free-form prose.
  {
    const stdout = runClaude(
      `Output exactly the following XML block verbatim. No preamble, no commentary, no markdown fences:\n\n` +
      `<scratch>\nUpdated by round-15i smoke test.\nLine 2 of scratchpad content.\n</scratch>`,
    ).stdout;
    const m = stdout.match(SCRATCH_RE);
    check("<scratch> regex matches real LLM output", m != null, `stdout=${stdout.slice(0, 200)}`);
    if (m) {
      check("  → body contains 'Updated by round-15i smoke test'",
        /Updated by round-15i smoke test/.test(m[1]));
      check("  → body preserves multi-line content (Line 2 captured)",
        /Line 2 of scratchpad content/.test(m[1]));
    }
  }

  // 4. <archive> directive — structured key:value body (sections + summary).
  {
    const stdout = runClaude(
      `Output exactly the following XML block verbatim. No preamble, no commentary, no markdown fences:\n\n` +
      `<archive>\nsections: 12\nsummary: Round-15i smoke verification of the archive directive parser path.\n</archive>`,
    ).stdout;
    const m = stdout.match(ARCHIVE_RE);
    check("<archive> regex matches real LLM output", m != null, `stdout=${stdout.slice(0, 200)}`);
    if (m) {
      const body = m[1].trim();
      const sectionsMatch = body.match(/sections:\s*(\d+)/);
      const summaryMatch = body.match(/summary:\s*(.+)/);
      check("  → body parses sections: 12",
        sectionsMatch != null && parseInt(sectionsMatch[1], 10) === 12);
      check("  → body parses summary line",
        summaryMatch != null && /Round-15i smoke/.test(summaryMatch[1]));
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    const detail = r.detail && !r.pass ? `\n        ${r.detail.split("\n").slice(0, 2).join("\n        ")}` : "";
    console.log(`  ${tag}  ${r.name}${detail}`);
  }
  console.log(`\nllm-smoke: ${passed}/${results.length} pass${failed.length ? `, ${failed.length} fail` : ""}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`llm-smoke: crashed — ${e?.message ?? e}`);
  process.exit(2);
});
