#!/usr/bin/env bun
// scripts/self-test.ts — end-to-end smoke test for the agent-chat plugin.
//
// Purpose: an agent or human can run ONE command against an installed plugin
// and get a clean PASS/FAIL summary that the install is fully functional —
// not just that unit tests would pass, but that the protocol round-trip,
// config layer, doctor surfaces, and edge canonicalization all work end-to-end
// using subprocess invocation against a fresh tmp conversations dir.
//
// Coverage: 13 checks across 7 scenarios. Runtime ~5–10s. No global state
// pollution — everything happens under a tmp dir that is cleaned up on exit.
//
// Invocation:
//   bun "$AGENT_CHAT_DIR/scripts/self-test.ts"          # human-readable
//   bun "$AGENT_CHAT_DIR/scripts/self-test.ts" --json   # machine-readable
//
// Exit code 0 if all checks pass, 1 otherwise. Designed so an agent driving
// it via tmux can simply run the command and confirm exit 0.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { SKILL_ROOT } from "./lib.ts";

// ── result accumulator ─────────────────────────────────────────────────────

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
let currentScenario = "";

function check(name: string, ok: boolean, detail = "") {
  const fullName = currentScenario ? `${currentScenario} :: ${name}` : name;
  results.push({ name: fullName, pass: ok, detail: detail || undefined });
}

function scenario(label: string, fn: () => void) {
  currentScenario = label;
  try {
    fn();
  } catch (e: any) {
    check("scenario crashed", false, `${e?.message ?? e}\n${e?.stack ?? ""}`);
  } finally {
    currentScenario = "";
  }
}

// ── subprocess helper ──────────────────────────────────────────────────────

const AGENT_CHAT = path.join(SKILL_ROOT, "scripts/agent-chat.ts");
const TURN = path.join(SKILL_ROOT, "scripts/turn.ts");

function run(args: string[], envOverride: Record<string, string> = {}): SpawnSyncReturns<string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...envOverride };
  return spawnSync("bun", args, { env, encoding: "utf8" });
}

// ── tmp dir lifecycle ──────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-selftest-"));
const convDir = path.join(tmpRoot, "conv");
fs.mkdirSync(convDir, { recursive: true });
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(fakeHome, { recursive: true });

// Two synthetic sessions writing into the same conversations dir.
const ORION_SID = "selftest-orion";
const LUMEYON_SID = "selftest-lumeyon";
const orionEnv = { AGENT_CHAT_CONVERSATIONS_DIR: convDir, CLAUDE_SESSION_ID: ORION_SID };
const lumeyonEnv = { AGENT_CHAT_CONVERSATIONS_DIR: convDir, CLAUDE_SESSION_ID: LUMEYON_SID };

// ── scenarios ──────────────────────────────────────────────────────────────

scenario("plugin layout", () => {
  check(
    "Claude plugin manifest present",
    fs.existsSync(path.join(SKILL_ROOT, ".claude-plugin/plugin.json")),
  );
  check(
    "Codex plugin manifest present",
    fs.existsSync(path.join(SKILL_ROOT, ".codex-plugin/plugin.json")),
  );
  check(
    "SKILL.md present at skills/agent-chat/",
    fs.existsSync(path.join(SKILL_ROOT, "skills/agent-chat/SKILL.md")),
  );
  check(
    "agents.petersen.yaml present",
    fs.existsSync(path.join(SKILL_ROOT, "agents.petersen.yaml")),
  );
  check(
    "scripts/agent-chat.ts present",
    fs.existsSync(AGENT_CHAT),
  );

  const claude = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, ".claude-plugin/plugin.json"), "utf8"));
  const codex = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, ".codex-plugin/plugin.json"), "utf8"));
  check(
    "Claude + Codex manifests share name + version (dual-runtime invariant)",
    claude.name === codex.name && claude.version === codex.version,
    `claude=${claude.name}@${claude.version} codex=${codex.name}@${codex.version}`,
  );
});

scenario("doctor --paths", () => {
  const r = run([AGENT_CHAT, "doctor", "--paths", "--json"], orionEnv);
  check("exit 0", r.status === 0, r.stderr);
  if (r.status !== 0) return;
  const j = JSON.parse(r.stdout);
  check("conversations_dir reflects env override", j.conversations_dir === convDir);
  check("source = env:AGENT_CHAT_CONVERSATIONS_DIR", j.conversations_dir_source === "env:AGENT_CHAT_CONVERSATIONS_DIR");
});

scenario("config.json layer", () => {
  // Plant a config.json under fake $HOME and verify it overrides the default.
  const cfgDir = path.join(fakeHome, ".claude/data/agent-chat");
  fs.mkdirSync(cfgDir, { recursive: true });
  const sharedDir = path.join(tmpRoot, "shared-by-config");
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ conversations_dir: sharedDir }));
  // Strip the env override so config wins.
  const r = spawnSync("bun", [AGENT_CHAT, "doctor", "--paths", "--json"], {
    encoding: "utf8",
    env: { ...(process.env as Record<string, string>), HOME: fakeHome, AGENT_CHAT_CONVERSATIONS_DIR: "" },
  });
  // Empty env var should fall through to config. But Node treats "" as set.
  // Re-spawn with the var explicitly deleted.
  const cleanEnv = { ...(process.env as Record<string, string>), HOME: fakeHome };
  delete cleanEnv.AGENT_CHAT_CONVERSATIONS_DIR;
  const r2 = spawnSync("bun", [AGENT_CHAT, "doctor", "--paths", "--json"], { encoding: "utf8", env: cleanEnv });
  check("doctor --paths exit 0 (config layer)", r2.status === 0, r2.stderr);
  if (r2.status !== 0) return;
  const j = JSON.parse(r2.stdout);
  check("config.conversations_dir wins over default", j.conversations_dir === sharedDir);
  check("source = config:<path>", String(j.conversations_dir_source).startsWith("config:"));
});

scenario("two-agent identity binding", () => {
  // Both agents init in the same shared conversations dir.
  const oi = run([AGENT_CHAT, "init", "orion", "petersen"], orionEnv);
  check("orion init exit 0", oi.status === 0, oi.stderr);
  const li = run([AGENT_CHAT, "init", "lumeyon", "petersen"], lumeyonEnv);
  check("lumeyon init exit 0", li.status === 0, li.stderr);

  // Session records exist with distinct keys. The .sessions/ dir contains
  // BOTH <sid>.json (the SessionRecord) AND <sid>.current_speaker.json (the
  // speaker pointer for record-turn). Match the SessionRecord exactly to
  // avoid hitting the speaker file (which has {name: "boss"} schema).
  const sessionsDir = path.join(convDir, ".sessions");
  const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  const orionFile = `${ORION_SID}.json`;
  const lumeyonFile = `${LUMEYON_SID}.json`;
  check("orion session record written", sessions.includes(orionFile));
  check("lumeyon session record written", sessions.includes(lumeyonFile));
  if (sessions.includes(orionFile) && sessions.includes(lumeyonFile)) {
    const o = JSON.parse(fs.readFileSync(path.join(sessionsDir, orionFile), "utf8"));
    const l = JSON.parse(fs.readFileSync(path.join(sessionsDir, lumeyonFile), "utf8"));
    check("orion record carries name=orion topology=petersen", o.agent === "orion" && o.topology === "petersen");
    check("lumeyon record carries name=lumeyon topology=petersen", l.agent === "lumeyon" && l.topology === "petersen");
  }
});

scenario("edge canonicalization (alphabetical edge id)", () => {
  // Both directions should resolve to the same edge dir: lumeyon-orion.
  const r1 = run([TURN, "init", "lumeyon", "orion"], orionEnv);
  check("orion can init edge with lumeyon", r1.status === 0, r1.stderr);
  const expected = path.join(convDir, "petersen/lumeyon-orion");
  check("edge dir created at <conv>/petersen/lumeyon-orion (alphabetical)", fs.existsSync(expected));
  // Re-init from lumeyon's side targeting orion should hit the same file and refuse.
  const r2 = run([TURN, "init", "orion", "orion"], lumeyonEnv);
  check(
    "second init refuses (already initialized — same canonical edge)",
    r2.status !== 0 && /already initialized/.test(r2.stderr + r2.stdout),
    `stdout=${r2.stdout}\nstderr=${r2.stderr}`,
  );
});

scenario("wire-protocol round-trip (orion → lumeyon → orion)", () => {
  // The edge was init'd above with turn=orion. Full cycle is
  // lock → append → flip → unlock (flip alone does NOT clear the lock —
  // unlock is a separate step; only `park` releases the lock atomically).
  const lock1 = run([TURN, "lock", "lumeyon"], orionEnv);
  check("orion lock exit 0", lock1.status === 0, lock1.stderr);

  const convoPath = path.join(convDir, "petersen/lumeyon-orion/CONVO.md");
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const orionSection = `\n\n---\n\n## orion — selftest hello (UTC ${stamp})\n\nself-test ping from orion → lumeyon. expecting lumeyon ack on the same edge.\n\n→ lumeyon\n`;
  fs.appendFileSync(convoPath, orionSection);

  const flip1 = run([TURN, "flip", "lumeyon", "lumeyon"], orionEnv);
  check("orion flip → lumeyon exit 0", flip1.status === 0, flip1.stderr);
  const unlock1 = run([TURN, "unlock", "lumeyon"], orionEnv);
  check("orion unlock exit 0", unlock1.status === 0, unlock1.stderr);

  // Lumeyon peeks: should see turn=lumeyon, lock cleared.
  const peek1 = run([TURN, "peek", "orion"], lumeyonEnv);
  check("lumeyon peek exit 0", peek1.status === 0, peek1.stderr);
  check("lumeyon sees turn=lumeyon", /turn:\s+lumeyon/.test(peek1.stdout));
  check("lock cleared after orion's unlock", /lock:\s+\(none\)/.test(peek1.stdout));

  // Lumeyon reads CONVO.md and verifies orion's section is there.
  const convo = fs.readFileSync(convoPath, "utf8");
  check("orion's section visible to lumeyon (cross-process visibility)", /## orion — selftest hello/.test(convo));

  // Lumeyon locks, appends, flips back, unlocks.
  const lock2 = run([TURN, "lock", "orion"], lumeyonEnv);
  check("lumeyon lock exit 0", lock2.status === 0, lock2.stderr);
  const lumeyonSection = `\n\n---\n\n## lumeyon — selftest ack (UTC ${stamp})\n\nack from lumeyon. round-trip protocol verified.\n\n→ orion\n`;
  fs.appendFileSync(convoPath, lumeyonSection);
  const flip2 = run([TURN, "flip", "orion", "orion"], lumeyonEnv);
  check("lumeyon flip → orion exit 0", flip2.status === 0, flip2.stderr);
  const unlock2 = run([TURN, "unlock", "orion"], lumeyonEnv);
  check("lumeyon unlock exit 0", unlock2.status === 0, unlock2.stderr);

  // Orion peeks again — should see turn=orion and lumeyon's reply visible.
  const peek2 = run([TURN, "peek", "lumeyon"], orionEnv);
  check("orion sees turn=orion (round-trip complete)", /turn:\s+orion/.test(peek2.stdout));
  const convo2 = fs.readFileSync(convoPath, "utf8");
  check("lumeyon's reply visible to orion", /## lumeyon — selftest ack/.test(convo2));
});

scenario("park semantics", () => {
  // Orion holds the floor (turn=orion from previous scenario). Park it.
  const park = run([TURN, "park", "lumeyon"], orionEnv);
  check("orion park exit 0", park.status === 0, park.stderr);
  const peek = run([TURN, "peek", "lumeyon"], orionEnv);
  check("turn=parked after park", /turn:\s+parked/.test(peek.stdout));
});

scenario("unauthorized lock refused", () => {
  // .turn = parked; nobody holds the floor. lumeyon must NOT be allowed to
  // lock (only the floor-holder can).
  const r = run([TURN, "lock", "orion"], lumeyonEnv);
  check(
    "lock refused when turn != self (parked edge)",
    r.status !== 0 && /refuse to lock/.test(r.stderr + r.stdout),
    `stdout=${r.stdout}\nstderr=${r.stderr}`,
  );
});

// ── teardown + summary ─────────────────────────────────────────────────────

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const wantJson = process.argv.includes("--json");

if (wantJson) {
  console.log(JSON.stringify({
    skill_root: SKILL_ROOT,
    total: results.length,
    passed,
    failed: failed.length,
    results,
  }, null, 2));
} else {
  console.log(`agent-chat self-test  (skill_root=${SKILL_ROOT})\n`);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`  ${tag}  ${r.name}${r.detail ? `\n        ${r.detail.split("\n").slice(0, 3).join("\n        ")}` : ""}`);
  }
  console.log(`\n${passed}/${results.length} pass${failed.length ? `, ${failed.length} fail` : ""}`);
}

process.exit(failed.length === 0 ? 0 : 1);
