// tests/notify.test.ts — Round-15n self-flip suppression
//
// notify.ts (Round-15l-D) emits push notifications when peer .turn files
// transition. Pre-15n bug: it emitted `peer-flipped-to-me` on EVERY
// transition where the new value matched my agent name, including
// transitions I authored myself (authoritative atomic .turn rewrite for
// stale-lock recovery, or any concurrent agent-chat-run process running
// as the same identity). False-positive notifications eroded the signal.
//
// Round-15n fix (option B per lumeyon's vote on the petersen lumeyon-orion
// edge, 2026-05-06T03:06): watch the .turn.lock file in addition to
// .turn, capture the lock holder per-edge, and suppress the
// peer-flipped-to-me emission when the recent lock holder's agent name
// matches `id.name` within a SELF_FLIP_WINDOW_MS TTL.
//
// Test cases (per lumeyon's guardrail #5):
//   1. peer flip — peer holds lock, flips to me → emit peer-flipped-to-me
//   2. self flip with lock still present — id.name holds lock, flips to me → suppress
//   3. self flip after unlock but within TTL — id.name held lock, then unlock,
//      then atomic .turn rewrite to me → suppress (snapshot outlives unlock)
//   4. self flip OUTSIDE the TTL — old lock from id.name, but >TTL ago →
//      treat as peer flip (no false suppression of stale state)
//   5. parked (other transitions still fire as before) — unchanged

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { SKILL_ROOT } from "../scripts/lib.ts";

const NOTIFY = path.join(SKILL_ROOT, "scripts/notify.ts");
const AGENT_CHAT = path.join(SKILL_ROOT, "scripts/agent-chat.ts");

// Spawn notify.ts as a child, observe stdout for ~timeoutMs, kill, return all
// notification lines emitted during the window. The fs.watch in notify.ts
// needs a brief warm-up before we mutate state, so we wait `warmupMs` ms
// after spawn before triggering the test action.
type RunResult = { lines: string[]; stderr: string };
async function runNotifyForWindow(
  env: Record<string, string>,
  warmupMs: number,
  testAction: () => void,
  observeMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [NOTIFY], {
      env: { ...(process.env as Record<string, string>), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      for (const line of chunk.split("\n")) {
        if (line.trim()) lines.push(line);
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    let actionFired = false;
    setTimeout(() => {
      if (!actionFired) {
        actionFired = true;
        try { testAction(); } catch (e) { stderr += `\n[test-action error] ${(e as Error).message}`; }
        setTimeout(() => {
          child.kill("SIGTERM");
        }, observeMs);
      }
    }, warmupMs);
    child.on("exit", () => resolve({ lines, stderr }));
    child.on("error", () => resolve({ lines, stderr }));
  });
}

function setupOrionPeterson(): { tmp: string; convDir: string; lumeyonOrionEdge: string; orionEnv: Record<string, string> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-notify-"));
  const convDir = path.join(tmp, "conv");
  fs.mkdirSync(convDir, { recursive: true });
  const orionEnv = { AGENT_CHAT_CONVERSATIONS_DIR: convDir, CLAUDE_SESSION_ID: "notify-test-orion" };
  // Init orion + a fake lumeyon (just to get edges enumerated; no actual session needed)
  const init = require("node:child_process").spawnSync("bun", [AGENT_CHAT, "init", "orion", "petersen"], {
    env: { ...(process.env as Record<string, string>), ...orionEnv }, encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`orion init failed: ${init.stderr}`);
  const lumeyonOrionEdge = path.join(convDir, "petersen", "lumeyon-orion");
  fs.mkdirSync(lumeyonOrionEdge, { recursive: true });
  return { tmp, convDir, lumeyonOrionEdge, orionEnv };
}

function writeTurnAtomic(turnFile: string, value: string) {
  const tmp = `${turnFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, turnFile);
}

function writeLockAtomic(lockFile: string, body: string) {
  fs.writeFileSync(lockFile, body);
}

describe("Round-15n notify.ts self-flip suppression", () => {
  test("1. peer flip with peer's lock body → emits peer-flipped-to-me", async () => {
    const { tmp, lumeyonOrionEdge, orionEnv } = setupOrionPeterson();
    try {
      const turnFile = path.join(lumeyonOrionEdge, "CONVO.md.turn");
      const lockFile = path.join(lumeyonOrionEdge, "CONVO.md.turn.lock");
      writeTurnAtomic(turnFile, "lumeyon"); // initial: peer holds floor
      const r = await runNotifyForWindow(orionEnv, 600, () => {
        // Simulate peer's flip cycle: lumeyon takes lock, flips turn to orion, releases lock.
        writeLockAtomic(lockFile, "lumeyon@host:1234:0:test 2026-05-06T03:00:00Z");
        // Brief delay so lock-watcher captures the snapshot before turn flip.
        const start = Date.now(); while (Date.now() - start < 150) {} // sync sleep — wide enough for Bun fs.watch lock event
        writeTurnAtomic(turnFile, "orion");
      }, 1500);
      const myFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] my-flip/.test(l));
      const peerFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] peer-flipped-to-me/.test(l));
      expect(peerFlipLines.length).toBe(1);
      expect(peerFlipLines[0]).toContain("peer=lumeyon");
      expect(myFlipLines.length).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("2. self flip with my lock still present → suppresses peer-flipped-to-me, emits my-flip", async () => {
    const { tmp, lumeyonOrionEdge, orionEnv } = setupOrionPeterson();
    try {
      const turnFile = path.join(lumeyonOrionEdge, "CONVO.md.turn");
      const lockFile = path.join(lumeyonOrionEdge, "CONVO.md.turn.lock");
      writeTurnAtomic(turnFile, "parked"); // initial state: parked
      const r = await runNotifyForWindow(orionEnv, 600, () => {
        // Simulate orion taking the floor: write own lock, atomic-rewrite turn to orion.
        writeLockAtomic(lockFile, "orion@host:9999:0:test 2026-05-06T03:00:00Z");
        const start = Date.now(); while (Date.now() - start < 200) {}
        writeTurnAtomic(turnFile, "orion");
      }, 1500);
      const peerFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] peer-flipped-to-me/.test(l));
      const myFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] my-flip/.test(l));
      const detail = `peer=${peerFlipLines.length} my=${myFlipLines.length} all=${JSON.stringify(r.lines.slice(0, 8))} stderr=${r.stderr.slice(0, 400)}`;
      expect(peerFlipLines.length, detail).toBe(0);
      expect(myFlipLines.length, detail).toBe(1);
      expect(myFlipLines[0]).toContain("suppressing peer-flipped-to-me");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("3. self flip after unlock but within TTL → suppresses peer-flipped-to-me", async () => {
    const { tmp, lumeyonOrionEdge, orionEnv } = setupOrionPeterson();
    try {
      const turnFile = path.join(lumeyonOrionEdge, "CONVO.md.turn");
      const lockFile = path.join(lumeyonOrionEdge, "CONVO.md.turn.lock");
      writeTurnAtomic(turnFile, "parked");
      const r = await runNotifyForWindow(orionEnv, 600, () => {
        // Simulate orion's full lock+flip+unlock cycle, then a stale-lock-
        // recovery atomic rewrite happens AFTER the unlock. The recent lock
        // snapshot should outlive the unlock and still be inside the TTL.
        writeLockAtomic(lockFile, "orion@host:9999:0:test 2026-05-06T03:00:00Z");
        const s1 = Date.now(); while (Date.now() - s1 < 30) {}
        // Unlock first.
        try { fs.unlinkSync(lockFile); } catch {}
        const s2 = Date.now(); while (Date.now() - s2 < 30) {}
        // Then the atomic .turn rewrite (no fresh lock).
        writeTurnAtomic(turnFile, "orion");
      }, 1500);
      const peerFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] peer-flipped-to-me/.test(l));
      const myFlipLines = r.lines.filter((l) => /^\[notify [^\]]*\] my-flip/.test(l));
      expect(peerFlipLines.length).toBe(0);
      expect(myFlipLines.length).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("4. parked emission unchanged by suppression logic", async () => {
    const { tmp, lumeyonOrionEdge, orionEnv } = setupOrionPeterson();
    try {
      const turnFile = path.join(lumeyonOrionEdge, "CONVO.md.turn");
      const lockFile = path.join(lumeyonOrionEdge, "CONVO.md.turn.lock");
      writeTurnAtomic(turnFile, "lumeyon"); // initial state
      const r = await runNotifyForWindow(orionEnv, 600, () => {
        writeLockAtomic(lockFile, "lumeyon@host:1234:0:test 2026-05-06T03:00:00Z");
        const start = Date.now(); while (Date.now() - start < 150) {}
        writeTurnAtomic(turnFile, "parked");
      }, 1500);
      const parkedLines = r.lines.filter((l) => /peer-parked/.test(l));
      expect(parkedLines.length).toBe(1);
      expect(parkedLines[0]).toContain("peer=lumeyon");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
