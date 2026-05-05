// tests/config.test.ts — Round 15g config.json loader.
//
// CONVERSATIONS_DIR is a top-level `export const`, evaluated once at module
// load. So we can't unit-test the resolution in-process with import side
// effects — we spawn subprocesses with a fake $HOME and assert what the
// child reports. Same pattern as ephemeral.test.ts uses for daemons.

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL_ROOT } from "../scripts/lib.ts";

const LIB_PATH = path.join(SKILL_ROOT, "scripts/lib.ts");
const PRINT = `import('${LIB_PATH}').then(m => console.log(JSON.stringify({c: m.CONVERSATIONS_DIR, p: m.CONFIG_PATH, cfg: m.CONFIG})))`;

function runWithHome(home: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = { ...process.env as any, HOME: home };
  // Strip any inherited override unless the test sets it.
  delete merged.AGENT_CHAT_CONVERSATIONS_DIR;
  for (const [k, v] of Object.entries(env)) {
    if (v == null) delete merged[k];
    else merged[k] = v;
  }
  const r = spawnSync("bun", ["-e", PRINT], { env: merged, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`bun child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("Round 15g — CONVERSATIONS_DIR resolution order", () => {
  test("default: ~/.claude/data/agent-chat/conversations when no env, no config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-default-"));
    try {
      const out = runWithHome(tmp);
      expect(out.c).toBe(path.join(tmp, ".claude/data/agent-chat/conversations"));
      expect(out.cfg).toEqual({});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json conversations_dir overrides default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-file-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      const sharedDir = path.join(tmp, "shared/across/runtimes");
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ conversations_dir: sharedDir }));
      const out = runWithHome(tmp);
      expect(out.c).toBe(sharedDir);
      expect(out.cfg.conversations_dir).toBe(sharedDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("env var beats config.json (highest precedence)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-env-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ conversations_dir: "/from/config" }));
      const envDir = path.join(tmp, "from/env");
      const out = runWithHome(tmp, { AGENT_CHAT_CONVERSATIONS_DIR: envDir });
      expect(out.c).toBe(envDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json with non-absolute path is ignored (defaults applied)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-rel-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ conversations_dir: "relative/path" }));
      const out = runWithHome(tmp);
      expect(out.c).toBe(path.join(tmp, ".claude/data/agent-chat/conversations"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("malformed config.json (invalid JSON) is ignored, defaults applied", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-bad-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), "{ this is not json");
      const out = runWithHome(tmp);
      expect(out.c).toBe(path.join(tmp, ".claude/data/agent-chat/conversations"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json that is a JSON array (not an object) is ignored", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cfg-arr-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(["nope"]));
      const out = runWithHome(tmp);
      expect(out.c).toBe(path.join(tmp, ".claude/data/agent-chat/conversations"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
