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

describe("Round 15k Item-8 — configurable Dot axes via config.json", () => {
  const PRINT_AXES = `import('${LIB_PATH}').then(m => console.log(JSON.stringify({axes: m.DOT_AXES, defaults: m.DEFAULT_DOT_AXES, cfg: m.CONFIG.dot_axes})))`;

  function runAxes(home: string) {
    const env: Record<string, string> = { ...(process.env as any), HOME: home };
    delete env.AGENT_CHAT_CONVERSATIONS_DIR;
    const r = spawnSync("bun", ["-e", PRINT_AXES], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`bun child exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split("\n").pop()!);
  }

  test("default DOT_AXES is the 4-axis Dalio set when config absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-default-"));
    try {
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["clarity", "depth", "reliability", "speed"]);
      expect(out.defaults).toEqual(["clarity", "depth", "reliability", "speed"]);
      expect(out.cfg).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes overrides default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-custom-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
        dot_axes: ["creativity", "rigor", "specificity", "openness"],
      }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["creativity", "rigor", "specificity", "openness"]);
      expect(out.cfg).toEqual(["creativity", "rigor", "specificity", "openness"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes accepts 1-axis minimum", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-1-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ dot_axes: ["correctness"] }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["correctness"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes accepts 8-axis maximum", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-8-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ dot_axes: eight }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(eight);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes > 8 entries falls back to defaults (with warning)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-toomany-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ dot_axes: nine }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["clarity", "depth", "reliability", "speed"]);
      expect(out.cfg).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes with bad name (special chars) falls back to defaults", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-badname-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
        dot_axes: ["valid", "with space", "bad/slash"],
      }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["clarity", "depth", "reliability", "speed"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("config.json dot_axes with duplicates falls back to defaults", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-dup-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
        dot_axes: ["clarity", "clarity", "depth"],
      }));
      const out = runAxes(tmp);
      expect(out.axes).toEqual(["clarity", "depth", "reliability", "speed"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("aggregateDots respects custom axes (not the 4 hardcoded)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-axes-agg-"));
    try {
      const cfgDir = path.join(tmp, ".claude/data/agent-chat");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
        dot_axes: ["correctness", "speed"],
      }));
      // Plant a dot directly in the conv dir, then aggregate via subprocess.
      const convDir = path.join(tmp, ".claude/data/agent-chat/conversations");
      const dotsDir = path.join(convDir, ".dots");
      fs.mkdirSync(dotsDir, { recursive: true });
      fs.writeFileSync(path.join(dotsDir, "alice.jsonl"),
        JSON.stringify({ ts: "x", grader: "bob", axes: { correctness: 9, speed: 7 } }) + "\n");
      const probe = `import('${LIB_PATH}').then(m => console.log(JSON.stringify(m.aggregateDots('alice'))))`;
      const env: Record<string, string> = { ...(process.env as any), HOME: tmp };
      delete env.AGENT_CHAT_CONVERSATIONS_DIR;
      const r = spawnSync("bun", ["-e", probe], { env, encoding: "utf8" });
      const agg = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(agg.count).toBe(1);
      expect(agg.weighted.correctness).toBeGreaterThan(0);
      expect(agg.weighted.speed).toBeGreaterThan(0);
      // The default axes (depth, reliability, clarity) should NOT appear in
      // the aggregate when config overrides them.
      expect(agg.weighted.clarity).toBeUndefined();
      expect(agg.weighted.depth).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
