// tests/plugin-manifest.test.ts — Round 15b validation tests.
//
// Pins the JSON shape of the dual-runtime plugin manifests so a future
// edit that breaks marketplace install discovery surfaces as a test
// failure, not a deployment-time silent failure. Same defensive shape
// as Round-13's STUCK_REASONS satisfies-helper drift insurance applied
// to the plugin-manifest layer.

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SKILL_ROOT } from "../scripts/lib.ts";

describe("Round 15b — plugin manifest validity", () => {
  test(".claude-plugin/plugin.json is valid JSON with required fields", () => {
    const p = path.join(SKILL_ROOT, ".claude-plugin/plugin.json");
    expect(fs.existsSync(p)).toBe(true);
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(m.name).toBe("agent-chat");
    expect(typeof m.version).toBe("string");
    expect(typeof m.description).toBe("string");
    expect(m.engines?.claudeCode).toBeDefined();
    expect(m.license).toBe("MIT");
  });

  test(".codex-plugin/plugin.json is valid JSON with required fields", () => {
    const p = path.join(SKILL_ROOT, ".codex-plugin/plugin.json");
    expect(fs.existsSync(p)).toBe(true);
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(m.name).toBe("agent-chat");
    expect(typeof m.version).toBe("string");
    expect(typeof m.description).toBe("string");
    expect(m.license).toBe("MIT");
    // Codex docs don't document an engines.codex constraint; absent is fine.
  });

  test("marketplace.json declares agent-chat as a plugin entry", () => {
    const p = path.join(SKILL_ROOT, "marketplace.json");
    expect(fs.existsSync(p)).toBe(true);
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(Array.isArray(m.plugins)).toBe(true);
    expect(m.plugins.length).toBeGreaterThanOrEqual(1);
    const ac = m.plugins.find((p: any) => p.name === "agent-chat");
    expect(ac).toBeDefined();
    expect(ac?.source).toBe("./");
  });

  test("Claude + Codex manifests share name + version (dual-runtime invariant)", () => {
    const c = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, ".claude-plugin/plugin.json"), "utf8"));
    const x = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, ".codex-plugin/plugin.json"), "utf8"));
    expect(c.name).toBe(x.name);
    expect(c.version).toBe(x.version);
    // Description CAN diverge (Codex variant flags the empirical probe);
    // license + author should match.
    expect(c.license).toBe(x.license);
  });
});

describe("Round 15b — runtime adapter signatures", () => {
  test("scripts/runtimes/claude.ts exports dispatch + scheduleWakeup + RUNTIME_NAME", async () => {
    const m = await import("../scripts/runtimes/claude.ts");
    expect(typeof m.dispatch).toBe("function");
    expect(typeof m.scheduleWakeup).toBe("function");
    expect(m.RUNTIME_NAME).toBe("claude");
  });

  test("scripts/runtimes/codex.ts exports dispatch + scheduleWakeup + RUNTIME_NAME (skeleton; throws)", async () => {
    const m = await import("../scripts/runtimes/codex.ts");
    expect(typeof m.dispatch).toBe("function");
    expect(typeof m.scheduleWakeup).toBe("function");
    expect(m.RUNTIME_NAME).toBe("codex");
    // Skeleton — calling either throws RUNTIME_NOT_IMPLEMENTED.
    await expect(m.dispatch({ prompt: "test" })).rejects.toThrow(/not yet implemented/);
    expect(() => m.scheduleWakeup("test")).toThrow(/not yet implemented/);
  });

  test("Both runtime adapters have symmetric dispatch + scheduleWakeup signatures", async () => {
    const c = await import("../scripts/runtimes/claude.ts");
    const x = await import("../scripts/runtimes/codex.ts");
    // Both export same set of names (cross-runtime substitutability).
    expect(Object.keys(c).sort()).toEqual(Object.keys(x).sort());
  });
});

describe("Round 15b — scheduleWakeup mock surface (Claude side)", () => {
  test("AGENT_CHAT_LOOP_MOCK_WAKEUP=1 emits exact format string (matches loop-driver.ts:29)", async () => {
    const c = await import("../scripts/runtimes/claude.ts");
    const orig = process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP;
    process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP = "1";
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => captured.push(msg);
    try {
      c.scheduleWakeup("test reason");
      expect(captured).toEqual(["WOULD_WAKE delay_seconds=270 reason=test reason"]);
    } finally {
      console.log = origLog;
      if (orig == null) delete process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP;
      else process.env.AGENT_CHAT_LOOP_MOCK_WAKEUP = orig;
    }
  });
});
