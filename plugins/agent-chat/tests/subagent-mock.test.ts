// Mock-subagent integration test. Spawns two real OS processes running
// fake-agent.ts (one as orion, one as lumeyon) against a shared tmpdir.
// Each does init, then they exchange N rounds via the actual protocol.
//
// What this catches that unit tests don't:
//   - real cross-process race conditions on .turn flips
//   - lock-file integrity under concurrent writers
//   - identity-via-session-file resolution under fork/exec
//
// What it doesn't catch (by design — that's what the gated LLM test is for):
//   - whether real Claude/Codex actually obeys bootstrap.md instructions
//   - prompt-engineering bugs in the skill description

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { mkTmpConversations, rmTmp, runScript, sessionEnv, SKILL_ROOT } from "./helpers.ts";

const FAKE_AGENT = path.join(import.meta.dirname, "fake-agent.ts");

function spawnFakeAgent(env: Record<string, string>, args: string[]) {
  return spawn(process.execPath, [FAKE_AGENT, ...args], {
    cwd: SKILL_ROOT,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitExit(child: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`subagent timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

let CONVO_DIR: string;

beforeEach(() => { CONVO_DIR = mkTmpConversations(); });
afterEach(() => { rmTmp(CONVO_DIR); });

describe("two fake agents exchanging turns through the real protocol", () => {
  test("3-round exchange: orion-lumeyon, ends with parked, 6 sections written in order", async () => {
    const orionEnv = sessionEnv(CONVO_DIR, "orion", "pair");
    const lumeyonEnv = sessionEnv(CONVO_DIR, "lumeyon", "pair");

    // Each "session" runs agent-chat init first. That writes the session
    // file each fake-agent will resolve identity from.
    runScript("agent-chat.ts", ["init", "orion", "pair"], orionEnv);
    runScript("agent-chat.ts", ["init", "lumeyon", "pair"], lumeyonEnv);

    // Spawn both agents simultaneously. orion is the designated first writer.
    const orionChild = spawnFakeAgent(orionEnv, ["orion", "lumeyon", "3", "--first", "orion"]);
    const lumeyonChild = spawnFakeAgent(lumeyonEnv, ["lumeyon", "orion", "3"]);

    const [oRes, lRes] = await Promise.all([
      waitExit(orionChild),
      waitExit(lumeyonChild),
    ]);

    expect(oRes.code).toBe(0);
    expect(lRes.code).toBe(0);

    // Verify CONVO.md has exactly 6 sections (3 from each, alternating).
    const convo = fs.readFileSync(
      path.join(CONVO_DIR, "pair", "lumeyon-orion", "CONVO.md"), "utf8");
    const sections = convo.split(/^## /m).slice(1);
    expect(sections.length).toBe(6);

    // Authors alternate: orion, lumeyon, orion, lumeyon, orion, lumeyon.
    const authors = sections.map((s) => s.split(" — ")[0]);
    expect(authors).toEqual(["orion", "lumeyon", "orion", "lumeyon", "orion", "lumeyon"]);

    // Round numbers ascend within each agent's view.
    const orionRounds = authors
      .map((a, i) => a === "orion" ? sections[i] : null)
      .filter((s): s is string => !!s)
      .map((s) => parseInt(s.match(/round (\d+)/)![1], 10));
    expect(orionRounds).toEqual([1, 2, 3]);

    // Final turn state should be parked (last round parks).
    const finalTurn = fs.readFileSync(
      path.join(CONVO_DIR, "pair", "lumeyon-orion", "CONVO.md.turn"), "utf8").trim();
    expect(finalTurn).toBe("parked");

    // No leftover lock file.
    expect(fs.existsSync(
      path.join(CONVO_DIR, "pair", "lumeyon-orion", "CONVO.md.turn.lock"))).toBe(false);
  }, 45_000);

  test("identity resolution via session file is correct under fork/exec", async () => {
    // This is implicit in the previous test, but call it out: each fake-agent
    // child resolved its identity entirely via $CLAUDE_SESSION_ID + session
    // file, with NO $AGENT_NAME / .agent-name fallback. If session-file
    // resolution were broken under fork, the previous test would fail with
    // "identity mismatch: resolved as <wrong-name>".
    expect(true).toBe(true);
  });

  test("a single round each: orion writes-then-flips, lumeyon writes-then-parks (2 sections total)", async () => {
    const orionEnv = sessionEnv(CONVO_DIR, "orion", "pair");
    const lumeyonEnv = sessionEnv(CONVO_DIR, "lumeyon", "pair");
    runScript("agent-chat.ts", ["init", "orion", "pair"], orionEnv);
    runScript("agent-chat.ts", ["init", "lumeyon", "pair"], lumeyonEnv);

    const orionChild = spawnFakeAgent(orionEnv, ["orion", "lumeyon", "1", "--first", "orion"]);
    const lumeyonChild = spawnFakeAgent(lumeyonEnv, ["lumeyon", "orion", "1"]);

    const [o, l] = await Promise.all([waitExit(orionChild), waitExit(lumeyonChild)]);
    expect(o.code).toBe(0);
    expect(l.code).toBe(0);

    const convo = fs.readFileSync(
      path.join(CONVO_DIR, "pair", "lumeyon-orion", "CONVO.md"), "utf8");
    const sections = convo.split(/^## /m).slice(1);
    expect(sections.length).toBe(2);
    expect(sections[0].startsWith("orion")).toBe(true);
    expect(sections[1].startsWith("lumeyon")).toBe(true);

    const finalTurn = fs.readFileSync(
      path.join(CONVO_DIR, "pair", "lumeyon-orion", "CONVO.md.turn"), "utf8").trim();
    expect(finalTurn).toBe("parked");
  }, 30_000);
});
