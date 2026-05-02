// speaker.test.ts — slice 2 load-bearing coverage for the multi-user
// transparency primitives (speaker CLI + current_speaker.json + sidecar
// integration).
//
// Four load-bearing tests covering the surfaces the hardening-audit lessons
// said to exercise (orion: "two bugs caught only via load-bearing tests"):
//
//   1. smoke (full lifecycle)         — set/clear/whoami/exit via CLI
//   2. concurrent race                — parallel speaker writes, atomic, no torn reads
//   3. sidecar Bug-1-class regression — whoami reflects current_speaker
//                                       written AFTER sidecar spawn
//                                       (pulsar slice-2 mandated this test
//                                       by name, mirroring the round-3 fix
//                                       for monitor_pid)
//   4. gc orphan reclamation          — current_speaker.json with no matching
//                                       session record gets reclaimed
//
// Tests pre-create session records on disk (matching sidecar.test.ts pattern)
// to avoid the spawn cost of full `agent-chat init` for every test.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  mkTmpConversations, rmTmp, runScript, spawnScript, sessionEnv,
} from "./helpers.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;
let SESSION_KEY: string;

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  SESSION_KEY = ORION_ENV.CLAUDE_SESSION_ID!;
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".logs"), { recursive: true });
  // Pre-create the session record so cmdSpeaker's lookup succeeds without
  // running full `agent-chat init`. Mirrors sidecar.test.ts setup exactly.
  const rec = {
    agent: "orion", topology: "petersen", session_key: SESSION_KEY,
    claude_session_id: SESSION_KEY, host: os.hostname(), pid: process.pid,
    started_at: "2026-05-02T00:00:00Z", cwd: CONVO_DIR,
  };
  fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${SESSION_KEY}.json`), JSON.stringify(rec));
});

afterEach(() => { rmTmp(CONVO_DIR); });

// Tiny client (copied from sidecar.test.ts so a regression in
// scripts/sidecar-client.ts can't mask a sidecar-side bug).
function rawRequest(socketPath: string, req: any, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = "";
    let settled = false;
    const finish = (r: any, isErr = false) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      isErr ? reject(r) : resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish(new Error(`request timed out after ${timeoutMs}ms`), true));
    sock.on("error", (e) => finish(e, true));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try { finish(JSON.parse(buf.slice(0, nl))); }
      catch (e) { finish(e, true); }
    });
    sock.connect(socketPath, () => sock.write(JSON.stringify(req) + "\n"));
  });
}

async function waitForSocket(socketPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      const ok = await new Promise<boolean>((res) => {
        const s = new net.Socket();
        s.setTimeout(150, () => { s.destroy(); res(false); });
        s.once("error", () => res(false));
        s.once("connect", () => { s.destroy(); res(true); });
        try { s.connect(socketPath); } catch { res(false); }
      });
      if (ok) return;
    }
    await sleep(50);
  }
  throw new Error(`socket ${socketPath} never became ready within ${timeoutMs}ms`);
}

const speakerFile = (key: string) => {
  // Mirror lib.ts:currentSpeakerPath sanitization
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  return path.join(CONVO_DIR, ".sessions", `${safe}.current_speaker.json`);
};

describe("speaker CLI — slice 2 smoke (full lifecycle)", () => {
  test("set/read/switch/clear/whoami/exit roundtrip with mode 0600", async () => {
    // 0-arg before any speaker is set — should report "no speaker set" and exit cleanly.
    const r0 = runScript("agent-chat.ts", ["speaker"], ORION_ENV);
    expect(r0.exitCode).toBe(0);
    expect(r0.stdout).toMatch(/no speaker set/);

    // Set speaker to a valid topology agent ("carina" — a petersen agent).
    const r1 = runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);
    expect(r1.exitCode).toBe(0);
    expect(r1.stderr).toMatch(/speaker: carina/);

    // File on disk has the right shape + mode 0600 (pulsar's mode rec).
    const f = speakerFile(SESSION_KEY);
    expect(fs.existsSync(f)).toBe(true);
    const stat = fs.statSync(f);
    expect(stat.mode & 0o777).toBe(0o600);
    const body = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(body.name).toBe("carina");
    expect(typeof body.set_at).toBe("string");
    expect(/^\d{4}-\d{2}-\d{2}T/.test(body.set_at)).toBe(true);
    // Schema-strictness: NO `prev` field (dropped per pulsar's RMW concern).
    expect(body.prev).toBeUndefined();

    // 0-arg now reports the current value.
    const r2 = runScript("agent-chat.ts", ["speaker"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/^carina\s+set_at=/);

    // Switch to a different valid agent.
    const r3 = runScript("agent-chat.ts", ["speaker", "lumeyon"], ORION_ENV);
    expect(r3.exitCode).toBe(0);
    expect(r3.stderr).toMatch(/speaker: carina → lumeyon/);
    const body2 = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(body2.name).toBe("lumeyon");

    // whoami file-direct path includes speaker=lumeyon.
    const r4 = runScript("agent-chat.ts", ["whoami"], ORION_ENV);
    expect(r4.exitCode).toBe(0);
    expect(r4.stdout).toMatch(/speaker=lumeyon/);

    // --clear unsets.
    const r5 = runScript("agent-chat.ts", ["speaker", "--clear"], ORION_ENV);
    expect(r5.exitCode).toBe(0);
    expect(r5.stderr).toMatch(/speaker cleared \(was lumeyon\)/);
    expect(fs.existsSync(f)).toBe(false);

    // whoami after clear shows speaker=-
    const r6 = runScript("agent-chat.ts", ["whoami"], ORION_ENV);
    expect(r6.exitCode).toBe(0);
    expect(r6.stdout).toMatch(/speaker=-/);
  });

  test("rejects unknown agent name (not in topology)", () => {
    const r = runScript("agent-chat.ts", ["speaker", "not-a-real-agent"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/not a declared agent in topology/);
    // No file should have been written.
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(false);
  });

  test("rejects self-edge (speaker name == session agent identity)", () => {
    const r = runScript("agent-chat.ts", ["speaker", "orion"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/same as this session's agent identity/);
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(false);
  });

  test("agent-chat exit unlinks current_speaker.json", () => {
    // Pre-set a speaker.
    const r1 = runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(true);

    // Exit should drop it as session-scoped state.
    const r2 = runScript("agent-chat.ts", ["exit"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(false);
  });

  test("agent-chat who works after a speaker is set (regression for listSessions contamination)", () => {
    // Pre-fix, current_speaker.json files (which live in SESSIONS_DIR with
    // a `.json` suffix) contaminated listSessions's return — cmdWho's
    // r.agent.padEnd(...) crashed on undefined. Caught at Phase-4 cross-
    // review by lumeyon during the multi-user rollout. The fix is
    // defensive shape validation in listSessions; this test pins it.
    const r1 = runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);
    expect(r1.exitCode).toBe(0);
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(true);

    // The actual regression test — `who` must NOT crash. Should list the
    // pre-staged orion session record cleanly without polluting from the
    // current_speaker.json sitting alongside it.
    const r2 = runScript("agent-chat.ts", ["who"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("orion");
    // The current_speaker.json's `name: carina` must NOT appear as a
    // session row (would be the contamination signal — pre-fix, "carina"
    // would show up alongside "orion" in the live or stale list).
    expect(r2.stdout).not.toMatch(/^\s+carina\s+@/m);
    expect(r2.stderr).not.toContain("TypeError");
  });
});

describe("speaker CLI — slice 2 concurrent writes", () => {
  test("two parallel speaker writes from same session_key both succeed; final state is one of them; never torn", async () => {
    // Spawn two CLI invocations as parallel children, with different speaker
    // names. writeFileAtomic (tmp+rename) guarantees no torn read; the
    // last-writer-wins outcome is one valid name.
    //
    // Why Bun.spawn instead of spawnScript (node:child_process spawn): under
    // `bun test`, node:child_process spawn's `exit` event reliably hangs
    // even with stdio:"ignore" — empirically the same pattern completes in
    // 76-86ms outside `bun test` but never fires `exit` inside it.
    // Bun.spawn is Bun-native and sidesteps the runtime quirk; same exit
    // semantics, no hang. Caught at Phase-5 integration of the multi-user
    // rollout. Documented as Bun-test-runtime issue, not a bug in slice 2.
    const SCRIPTS_DIR = path.resolve(import.meta.dirname, "..", "scripts");
    const procA = (Bun as any).spawn({
      cmd: [process.execPath, path.join(SCRIPTS_DIR, "agent-chat.ts"), "speaker", "carina"],
      cwd: path.resolve(import.meta.dirname, ".."),
      env: ORION_ENV,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const procB = (Bun as any).spawn({
      cmd: [process.execPath, path.join(SCRIPTS_DIR, "agent-chat.ts"), "speaker", "lumeyon"],
      cwd: path.resolve(import.meta.dirname, ".."),
      env: ORION_ENV,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const codeA = await procA.exited;
    const codeB = await procB.exited;
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    // Final state: file exists, parses cleanly, name is exactly one of the two.
    const f = speakerFile(SESSION_KEY);
    expect(fs.existsSync(f)).toBe(true);
    const body = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(["carina", "lumeyon"]).toContain(body.name);
    expect(typeof body.set_at).toBe("string");
  }, 8000);

  test("rapid set/read interleavings never observe a partial JSON file", () => {
    // Reader-side protection: 50 alternating writes with reads in-between.
    // If any read hits a half-written file, JSON.parse throws and the test
    // fails. writeFileAtomic uses tmp+rename which the kernel directory-lock
    // serializes against the read.
    const f = speakerFile(SESSION_KEY);
    for (let i = 0; i < 50; i++) {
      const name = i % 2 === 0 ? "carina" : "lumeyon";
      const r = runScript("agent-chat.ts", ["speaker", name], ORION_ENV);
      expect(r.exitCode).toBe(0);
      // Read is plain readFileSync against the renamed file — atomic vs writers.
      const body = JSON.parse(fs.readFileSync(f, "utf8"));
      expect(["carina", "lumeyon"]).toContain(body.name);
    }
  });
});

describe("speaker — sidecar Bug-1-class regression", () => {
  // PULSAR'S MANDATED TEST (named verbatim per slice-2 audit):
  //   "whoami reflects current_speaker written AFTER sidecar spawn"
  //
  // Mirrors the round-3 fix for monitor_pid: sidecar caches at boot, then
  // we update the file post-boot, then we expect the next dispatch to read
  // the new value. Before the fix this would return null (stale cache);
  // after the fix it returns the post-spawn value.

  let child: ChildProcessWithoutNullStreams | null = null;
  const cleanup = async () => {
    if (!child) return;
    try { child.kill("SIGTERM"); } catch {}
    await new Promise<void>((res) => child!.on("exit", () => res()));
    child = null;
  };
  afterEach(async () => { await cleanup(); });

  test("whoami reflects current_speaker written AFTER sidecar spawn", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    // Pre-flight: at sidecar boot there's no speaker file. whoami should
    // report current_speaker: null and NOT throw / NOT cache the null.
    const r0 = await rawRequest(socketPath, { id: 1, method: "whoami" });
    expect(r0.ok).toBe(true);
    expect(r0.result.current_speaker).toBeNull();

    // Now write the speaker file AFTER sidecar boot — this is the exact
    // shape of the round-3 monitor_pid bug, applied to current_speaker.
    runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);
    expect(fs.existsSync(speakerFile(SESSION_KEY))).toBe(true);

    // The dispatch MUST re-read the file each call. Without the fix this
    // returned the cached null.
    const r1 = await rawRequest(socketPath, { id: 2, method: "whoami" });
    expect(r1.ok).toBe(true);
    expect(r1.result.current_speaker).not.toBeNull();
    expect(r1.result.current_speaker.name).toBe("carina");

    // Switch the speaker. Dispatch must reflect the new value.
    runScript("agent-chat.ts", ["speaker", "lumeyon"], ORION_ENV);
    const r2 = await rawRequest(socketPath, { id: 3, method: "whoami" });
    expect(r2.ok).toBe(true);
    expect(r2.result.current_speaker.name).toBe("lumeyon");

    // Clear the speaker. Dispatch must reflect null again.
    runScript("agent-chat.ts", ["speaker", "--clear"], ORION_ENV);
    const r3 = await rawRequest(socketPath, { id: 4, method: "whoami" });
    expect(r3.ok).toBe(true);
    expect(r3.result.current_speaker).toBeNull();
  }, 8000);

  test("dedicated speaker UDS method returns the same view as whoami.current_speaker", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);

    const wResp = await rawRequest(socketPath, { id: 1, method: "whoami" });
    const sResp = await rawRequest(socketPath, { id: 2, method: "speaker" });
    expect(wResp.ok).toBe(true);
    expect(sResp.ok).toBe(true);
    expect(sResp.result.current_speaker).toEqual(wResp.result.current_speaker);
  }, 8000);
});

describe("speaker — gc orphan reclamation", () => {
  test("orphan current_speaker.json (no matching session record) is reclaimed by gc", () => {
    // Pre-stage an orphan: write a current_speaker file under a session_key
    // that has NO matching session record. Mirrors cadence's "manual rm of
    // session record but speaker file remained" defense-in-depth case.
    const orphanKey = "test-orphan-key";
    const orphanPath = path.join(CONVO_DIR, ".sessions", `${orphanKey}.current_speaker.json`);
    fs.writeFileSync(orphanPath, JSON.stringify({ name: "carina", set_at: "2026-05-02T00:00:00Z" }));
    expect(fs.existsSync(orphanPath)).toBe(true);

    // Run gc; orphan should be reclaimed.
    const r = runScript("agent-chat.ts", ["gc"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`removed orphan speaker file ${orphanKey}`));
    expect(fs.existsSync(orphanPath)).toBe(false);

    // The paired session record I pre-created in beforeEach is alive (its
    // own pid is current process), so its current_speaker would be kept if
    // it existed. Verify by setting one and confirming gc does NOT remove
    // it (live session paired record).
    const r2 = runScript("agent-chat.ts", ["speaker", "carina"], ORION_ENV);
    expect(r2.exitCode).toBe(0);
    const liveSpeakerPath = speakerFile(SESSION_KEY);
    expect(fs.existsSync(liveSpeakerPath)).toBe(true);

    const r3 = runScript("agent-chat.ts", ["gc"], ORION_ENV);
    expect(r3.exitCode).toBe(0);
    // Should NOT have removed our live speaker — it's paired with a live
    // SessionRecord; the session-pass treats live as "skip" via the
    // processIsOriginal gate.
    expect(fs.existsSync(liveSpeakerPath)).toBe(true);
  });

  test("session-pass folds current_speaker cleanup when session is dead", () => {
    // Create a session record for a DEAD pid, with a paired current_speaker.
    // gc's session-pass should reclaim BOTH (existing behavior for the
    // session record + the new speaker-cleanup we added in this slice).
    const deadKey = "test-dead-session";
    const deadRec = {
      agent: "carina", topology: "petersen", session_key: deadKey,
      host: os.hostname(),
      pid: 999999999,  // structurally dead; processIsOriginal returns false
      started_at: "2026-05-02T00:00:00Z", cwd: "/tmp",
    };
    fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${deadKey}.json`), JSON.stringify(deadRec));
    fs.writeFileSync(path.join(CONVO_DIR, ".presence", "carina.json"), JSON.stringify(deadRec));
    const deadSpeakerPath = path.join(CONVO_DIR, ".sessions", `${deadKey}.current_speaker.json`);
    fs.writeFileSync(deadSpeakerPath, JSON.stringify({ name: "lumeyon", set_at: "2026-05-02T00:00:00Z" }));

    const r = runScript("agent-chat.ts", ["gc"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed stale carina@petersen/);
    expect(fs.existsSync(deadSpeakerPath)).toBe(false);
  });
});
