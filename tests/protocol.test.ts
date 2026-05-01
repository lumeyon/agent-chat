// Protocol tests: drive turn.ts as a real subprocess against a tmpdir
// conversations directory. Validates the lock+flip+park dance plus all the
// safety nets we added (cross-agent, cross-process, cross-host refusals).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, sessionEnv, freshEnv } from "./helpers.ts";
import { processTag, parseLockFile } from "../scripts/lib.ts";

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;
let LUMEYON_ENV: Record<string, string>;
let EDGE_DIR: string;

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  LUMEYON_ENV = sessionEnv(CONVO_DIR, "lumeyon", "petersen");
  // Pre-seed the session records so turn.ts can resolve identity without
  // requiring agent-chat init (which would auto-launch a monitor we'd have to
  // tear down). Tests that exercise init explicitly do so separately.
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
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("turn.ts init / peek / flip / park", () => {
  test("init creates the edge with the chosen first writer", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const turn = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim();
    expect(turn).toBe("orion");
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md"))).toBe(true);
  });

  test("init refuses if edge already initialized", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("already initialized");
  });

  test("peek shows the current turn and lock state", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["peek", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("turn:        orion");
    expect(r.stdout).toContain("lock:        (none)");
  });

  test("flip from orion's identity succeeds when turn is orion", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("flipped lumeyon-orion: orion → lumeyon");
    const turn = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim();
    expect(turn).toBe("lumeyon");
  });

  test("flip is refused when it is not your turn", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["flip", "orion", "orion"], LUMEYON_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("refuse to flip");
  });

  test("park is refused when it is not your turn", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["park", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("refuse to park");
  });

  test("park sets the turn to parked", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const turn = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim();
    expect(turn).toBe("parked");
  });

  test("flip rejects a non-participant target", () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["flip", "lumeyon", "carina"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("next must be parked or one of");
  });

  test("non-neighbor peer is refused (rhino is not orion's neighbor)", () => {
    const r = runScript("turn.ts", ["peek", "rhino"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not a neighbor");
  });
});

describe("turn.ts lock format and unlock guards", () => {
  beforeEach(() => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
  });

  test("lock writes agent@host:pid <utc-ts>", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    const lockPath = path.join(EDGE_DIR, "CONVO.md.turn.lock");
    const lk = parseLockFile(lockPath);
    expect(lk).not.toBeNull();
    expect(lk!.agent).toBe("orion");
    expect(lk!.host).toBe(os.hostname());
    expect(Number.isInteger(lk!.pid)).toBe(true);
    expect(lk!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("unlock from same agent in fresh subprocess works (dead prior pid)", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("unlocked");
  });

  test("unlock from a different agent name is refused", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["unlock", "orion"], LUMEYON_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("lock owned by orion, not lumeyon");
  });

  test("unlock with same agent + LIVE other-pid is refused (misconfig safety net)", () => {
    // Hand-write a lock claiming live pid = current shell's pid (which is alive).
    const lockPath = path.join(EDGE_DIR, "CONVO.md.turn.lock");
    fs.writeFileSync(lockPath, `orion@${os.hostname()}:${process.pid} 2026-05-01T00:00:00Z\n`);
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("another live process");
  });

  test("unlock with same agent + DEAD other-pid succeeds (stale-lock recovery)", () => {
    const lockPath = path.join(EDGE_DIR, "CONVO.md.turn.lock");
    fs.writeFileSync(lockPath, `orion@${os.hostname()}:99999 2026-05-01T00:00:00Z\n`);
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("unlocked");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("unlock cross-host is refused unconditionally", () => {
    const lockPath = path.join(EDGE_DIR, "CONVO.md.turn.lock");
    fs.writeFileSync(lockPath, `orion@some-other-host:1234 2026-05-01T00:00:00Z\n`);
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("different host");
  });

  test("unlock when no lock exists is a no-op", () => {
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("not locked");
  });

  test("flip succeeds when the writer holds their own lock (documented sequence)", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("orion → lumeyon");
    // Lock still held; writer can clear it next
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(true);
  });

  test("flip is refused when the lock is held by a different agent", () => {
    // Hand-write a lock claiming lumeyon owns it (with a dead pid so unlock
    // won't conflict, but flip should still refuse on agent mismatch).
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:99999 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("locked by lumeyon");
  });

  test("park succeeds when the writer holds their own lock", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("parked lumeyon-orion");
  });

  test("park is refused when the lock is held by a different agent", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:99999 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["park", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("locked by lumeyon");
  });

  test("end-to-end documented sequence: lock → flip → unlock leaves edge clean", () => {
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV);
    const turn = fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim();
    expect(turn).toBe("lumeyon");
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(false);
  });
});
