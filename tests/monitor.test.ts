// monitor.test.ts — regression test for the tick/lock state-advance race.
//
// The bug: `monitor.ts` advanced its per-edge `prev` state every tick, even
// when `.turn.lock` was held. If a tick landed inside the brief window
// between a peer's `flip` and its `unlock` (the lock is still on disk while
// `.turn` already shows the new value), the monitor correctly declined to
// fire (lockHeld=true) but incorrectly advanced `prev` to the post-flip
// state. The next tick — now lock-free — saw `prev == cur` and fired
// nothing. The peer's flip-to-me notification was silently lost.
//
// Fix: only update `state.set(e.id, cur)` when `!lockHeld`. Hold the
// pre-lock baseline across the lock window so the first post-unlock tick
// computes the real diff and fires.
//
// This test reliably distinguishes buggy from fixed behavior because it
// holds the lock across multiple tick intervals — guaranteed to land at
// least one tick inside the lock window — then asserts a single event
// fires after unlock.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, spawnScript, sessionEnv } from "./helpers.ts";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;
let LUMEYON_ENV: Record<string, string>;
let EDGE_DIR: string;

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  LUMEYON_ENV = sessionEnv(CONVO_DIR, "lumeyon", "petersen");
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  for (const [env, agent] of [[ORION_ENV, "orion"], [LUMEYON_ENV, "lumeyon"]] as const) {
    const key = env.CLAUDE_SESSION_ID!;
    const rec = {
      agent, topology: "petersen", session_key: key,
      claude_session_id: key, host: os.hostname(), pid: process.pid,
      started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
    };
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${key}.json`), JSON.stringify(rec));
  }
  EDGE_DIR = path.join(CONVO_DIR, "petersen", "lumeyon-orion");
  runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("monitor.ts tick/lock state-advance race", () => {
  test("fires the flip-to-self event after a peer's lock window has multiple ticks inside it", async () => {
    // Spawn lumeyon's monitor with the fastest legal tick interval.
    const child = spawnScript("monitor.ts", ["--interval", "1"], LUMEYON_ENV) as
      ChildProcessByStdio<null, Readable, Readable>;
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });

    const exitWhenKilled = new Promise<void>((res) => child.on("exit", () => res()));

    try {
      // Let the monitor come up and prime its initial state silently.
      await sleep(1500);
      expect(stdoutBuf).toBe("");

      // Orion's append+flip sequence, with a deliberately-long lock window
      // so several monitor ticks land inside it. This is the racy gap that
      // the buggy code consumed silently.
      runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
      // Append something to CONVO.md so convoGrew also fires — mirrors the
      // real protocol's lock → append → flip → unlock sequence.
      fs.appendFileSync(
        path.join(EDGE_DIR, "CONVO.md"),
        "\n## orion — testing (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ lumeyon\n",
      );
      runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
      // Lock still held; .turn already shows "lumeyon". Hold for 2.5 ticks.
      await sleep(2500);

      // On the buggy code, by now `prev` has advanced to the post-flip
      // value silently across each in-window tick, so the post-unlock tick
      // will see no diff. On the fixed code, `prev` is still the pre-lock
      // value because lockHeld guarded the state.set.
      runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV);

      // Give the monitor one full tick interval after unlock to fire.
      await sleep(1500);
    } finally {
      child.kill("SIGTERM");
      await exitWhenKilled;
    }

    // Exactly one event line for the orion → lumeyon flip should be present.
    const eventLines = stdoutBuf.split("\n").filter((l) => /value→lumeyon/.test(l));
    expect(eventLines.length).toBe(1);
    expect(eventLines[0]).toContain("edge=lumeyon-orion");
    expect(eventLines[0]).toContain("peer=orion");
    expect(eventLines[0]).toContain(".md-grew");
  }, 15000);
});
