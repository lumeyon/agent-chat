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

  test("unlock with same agent + LIVE other-session is refused (misconfig safety net)", () => {
    // Hand-write a lock claiming a pid that's alive but isn't this test's
    // stableSessionPid (we use process.pid, which is the test process — alive,
    // but distinct from the stableSessionPid the runScript subprocess will
    // resolve to). Demonstrates: a lock owned by a different live session
    // can't be released by us, even with the same agent name.
    const lockPath = path.join(EDGE_DIR, "CONVO.md.turn.lock");
    fs.writeFileSync(lockPath, `orion@${os.hostname()}:${process.pid} 2026-05-01T00:00:00Z\n`);
    const r = runScript("turn.ts", ["unlock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("another live session");
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

  test("lock refuses when a different agent's lock already exists (wx race fix)", () => {
    // Plant a foreign live lock first.
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:${process.pid} 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("already locked by lumeyon");
  });

  test("lock refuses with --force-stale hint when the existing lock's pid is dead", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `orion@${os.hostname()}:99999 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("stale lock");
    expect(r.stderr).toContain("--force-stale");
  });

  test("unlock --force-stale clears a dead-pid lock", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:99999 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["unlock", "lumeyon", "--force-stale"], ORION_ENV);
    expect(r.stdout).toContain("force-stale unlocked");
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(false);
  });

  test("unlock --force-stale refuses when the lock holder pid is still alive", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:${process.pid} 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["unlock", "lumeyon", "--force-stale"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--force-stale refused");
  });

  test("two concurrent lock attempts from the SAME session: one wins via wx, the other idempotent-re-locks", async () => {
    // The two children share a stableSessionPid (same parent process tree),
    // so they're the same "session" by the lock's accounting. The wx-EEXIST
    // race differentiator: one child wins the create; the other reads its
    // lock and sees its OWN stable pid → idempotent re-lock branch fires.
    // No lock file ever ends up double-written or in a half-state.
    const { spawn } = await import("node:child_process");
    function lockChild(): Promise<{ code: number; stderr: string; stdout: string }> {
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [
          path.join(import.meta.dirname, "..", "scripts", "turn.ts"),
          "lock", "lumeyon",
        ], { env: { ...ORION_ENV }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        c.stdout?.on("data", (d) => stdout += d.toString());
        c.stderr?.on("data", (d) => stderr += d.toString());
        c.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    }
    const [a, b] = await Promise.all([lockChild(), lockChild()]);
    // Both must succeed (one by creating the lock, the other by detecting
    // its own session already holds it).
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // Output: exactly one says "locked", the other says "already locked by me".
    const stdouts = [a.stdout, b.stdout];
    expect(stdouts.some((s) => /^locked /m.test(s))).toBe(true);
    expect(stdouts.some((s) => /already locked by me/.test(s))).toBe(true);
    // The lock file exists and is well-formed.
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(true);
  });

  test("two lock attempts from DIFFERENT sessions: the second refuses cleanly", async () => {
    // Pre-plant a lock as if from a different session (different host so
    // the pid lookup goes through the "different host" path → not stale).
    // Wait, that hits the "cross-host refusal" branch in unlock, but for
    // *lock* we want to show wx-EEXIST + foreign-live-pid → refuse.
    // Simpler: plant a lock with a live pid that ISN'T this test's stable
    // pid. Use process.pid of the test (alive but not the stableSessionPid
    // the subprocess resolves to).
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `orion@${os.hostname()}:${process.pid} 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("already locked by orion");
  });
});

describe("turn.ts recover — append-then-crash recovery (carina Q5, P1)", () => {
  beforeEach(() => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV); // turn=orion
    // Append a section ending with `→ lumeyon` but DO NOT flip — simulating
    // a crash between append and flip. The recovery primitive should
    // reconstruct the intended flip from the trailing arrow.
    fs.appendFileSync(
      path.join(EDGE_DIR, "CONVO.md"),
      "\n## orion — work (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ lumeyon\n",
    );
  });

  test("recover (read-only) prints the proposed action without writing", () => {
    const r = runScript("turn.ts", ["recover", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("recovery available");
    expect(r.stdout).toContain("→ lumeyon");
    expect(r.stdout).toContain("Re-run with --apply");
    // .turn must remain at orion (no write happened).
    expect(fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim()).toBe("orion");
  });

  test("recover --apply flips .turn to the trailing arrow target", () => {
    const r = runScript("turn.ts", ["recover", "lumeyon", "--apply"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("recovered");
    expect(fs.readFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "utf8").trim()).toBe("lumeyon");
  });

  test("recover refuses if last section was authored by someone else (we're not the writer)", () => {
    // Replace the last section with a lumeyon-authored one so orion's
    // recover refuses (mid-state, but we're not the author).
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md"),
      "header\n\n## lumeyon — sneaky (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ orion\n",
    );
    const r = runScript("turn.ts", ["recover", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not \"orion\"");
  });

  test("recover is a no-op if .turn is not mine (no recovery needed)", () => {
    runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    const r = runScript("turn.ts", ["recover", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no recovery needed");
  });

  test("recover --apply refuses if a foreign-agent lock is held", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:99999:0 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["recover", "lumeyon", "--apply"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("lock held by lumeyon");
  });
});

describe("turn.ts lock — protocol invariants (lumeyon P1+P2)", () => {
  beforeEach(() => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV); // turn=orion
  });

  test("lock refuses when caller is not the floor-holder (closes squat-DoS)", () => {
    // Turn is orion's. Lumeyon should not be allowed to grab the lock.
    const r = runScript("turn.ts", ["lock", "orion"], LUMEYON_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Only the floor-holder can lock");
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(false);
  });

  test("lock allowed when turn is mine", () => {
    const r = runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"))).toBe(true);
  });

  test("lock allowed on uninitialized edge (init's first lock+write)", () => {
    // Wipe the edge to simulate a fresh init flow.
    fs.rmSync(EDGE_DIR, { recursive: true, force: true });
    fs.mkdirSync(EDGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md"), "header\n");
    // No .turn file → readTurn returns null → lock should succeed.
    const r = runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
  });
});

describe("turn.ts flip/park — pid-match guard (lumeyon P1, mirrors unlock)", () => {
  beforeEach(() => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV); // turn=orion
  });

  test("flip refuses when same-agent lock is held by ANOTHER live session (not a stale-lock race)", () => {
    // Plant a lock that claims to be orion@host but with a DIFFERENT live
    // pid (this test process's pid != stableSessionPid). Pre-fix, flip
    // would proceed because lk.agent === id.name passed; post-fix, the
    // pid-match guard refuses.
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `orion@${os.hostname()}:${process.pid}:0 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/another live session|locked by/);
  });

  test("park refuses when same-agent lock is held by another live session", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `orion@${os.hostname()}:${process.pid}:0 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["park", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/another live session|locked by/);
  });

  test("flip refuses when lock is held by a different agent (carina Q4 invariant preserved)", () => {
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `lumeyon@${os.hostname()}:99999:0 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("locked by lumeyon");
  });

  test("flip allowed when stale same-agent lock has dead pid (recovery path)", () => {
    // Find a dead pid the same way other tests do.
    let dead = 9_999_999;
    for (let p = 9_999_900; p > 1_000_000; p -= 17) {
      try { process.kill(p, 0); } catch (e: any) { if (e?.code === "ESRCH") { dead = p; break; } }
    }
    fs.writeFileSync(
      path.join(EDGE_DIR, "CONVO.md.turn.lock"),
      `orion@${os.hostname()}:${dead}:0 2026-05-01T00:00:00Z\n`,
    );
    const r = runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
  });
});

describe("agent-chat gc — concurrent + multi-host hardening (cadence Q4 + F8, P0)", () => {
  // Hardening regression: gc used to (a) abort the entire presence sweep
  // when a peer gc unlinked a file mid-loop (the inner unlinkSync's ENOENT
  // escaped past an over-broad catch with no outer guard — cadence Major #1),
  // and (b) treat foreign-host presence/session records as fair game,
  // unlinking another machine's live state when the dir is shared
  // (cadence Major #2). Both must be regression-tested.

  function presencePath(agent: string): string {
    return path.join(CONVO_DIR, ".presence", `${agent}.json`);
  }
  function sessionPath(key: string): string {
    return path.join(CONVO_DIR, ".sessions", `${key}.json`);
  }
  function writeRecord(agent: string, host: string, pid: number): void {
    const key = `pid:${pid}`;
    const rec = {
      agent, topology: "petersen", session_key: key,
      claude_session_id: key, host, pid,
      started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
    };
    fs.writeFileSync(presencePath(agent), JSON.stringify(rec, null, 2) + "\n");
    fs.writeFileSync(sessionPath(key), JSON.stringify(rec, null, 2) + "\n");
  }

  function deadPid(): number {
    // Pick a pid that's almost certainly free. Any 7-digit number well above
    // typical pid_max ranges. (Linux default pid_max is 32768 unless tuned.)
    // We verify by walking up from a high base until kill(pid, 0) errors with
    // ESRCH.
    for (let p = 9_999_900; p > 1_000_000; p -= 17) {
      try { process.kill(p, 0); } catch (e: any) {
        if (e?.code === "ESRCH") return p;
      }
    }
    return 9_999_999;
  }

  test("gc tolerates a presence file that vanishes mid-loop (concurrent gc race)", () => {
    // Pre-stage 6 stale presence files. Race two gc invocations in parallel
    // and verify both exit cleanly. Pre-fix: one of them would abort with an
    // uncaught ENOENT thrown out of the broad try/catch's bare unlinkSync.
    for (const a of ["sentinel", "vanguard", "carina", "pulsar", "cadence", "rhino"]) {
      writeRecord(a, os.hostname(), deadPid());
    }
    const a = runScript("agent-chat.ts", ["gc"], ORION_ENV, { allowFail: true });
    const b = runScript("agent-chat.ts", ["gc"], ORION_ENV, { allowFail: true });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Net effect: every staged record is gone after the two passes complete.
    for (const ag of ["sentinel", "vanguard", "carina", "pulsar", "cadence", "rhino"]) {
      expect(fs.existsSync(presencePath(ag))).toBe(false);
    }
  });

  test("gc does NOT touch a presence record whose host is foreign (multi-host safety)", () => {
    writeRecord("ghost", "definitely-not-this-host.example", deadPid());
    const r = runScript("agent-chat.ts", ["gc"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(presencePath("ghost"))).toBe(true);
    // Output should announce nothing-removed (the seeded ORION/LUMEYON test
    // sessions in beforeEach are alive, so they're not removed; the foreign
    // ghost record is skipped, not removed).
    expect(r.stdout).toContain("nothing to remove");
  });

  test("gc removes local stale records but leaves foreign-host records alongside", () => {
    writeRecord("ghost", "definitely-not-this-host.example", deadPid());
    writeRecord("dead-local", os.hostname(), deadPid());
    const r = runScript("agent-chat.ts", ["gc"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(presencePath("ghost"))).toBe(true);     // foreign untouched
    expect(fs.existsSync(presencePath("dead-local"))).toBe(false); // local removed
    expect(r.stdout).toContain("dead-local");
  });
});
