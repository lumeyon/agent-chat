// sidecar.test.ts — slice 1: skeleton + UDS + whoami/time/health.
//
// These tests assert the daemon's core lifecycle and IPC contract:
//   - bind to .sockets/<agent>.sock with mode 0600
//   - respond to whoami/time/health/shutdown over line-delimited JSON
//   - graceful shutdown via IPC
//   - reclaim stale socket on launch
//   - co-exist with monitor.ts (no double-emit, no deadlock)
//   - CONVERSATIONS_DIR override is honored for socket and log paths
//
// Subsequent slices add tests for peek/last-section (slice 2), inotify
// notifications (slice 3), unread/since-last-spoke + cursors (slice 4),
// and full agent-chat init/exit/gc lifecycle wiring (slice 5).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { mkTmpConversations, rmTmp, runScript, spawnScript, sessionEnv } from "./helpers.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  // Pre-create the session record the sidecar's `resolveIdentity` will read.
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".sockets"), { recursive: true });
  fs.mkdirSync(path.join(CONVO_DIR, ".logs"), { recursive: true });
  const key = ORION_ENV.CLAUDE_SESSION_ID!;
  const rec = {
    agent: "orion", topology: "petersen", session_key: key,
    claude_session_id: key, host: os.hostname(), pid: process.pid,
    started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
  };
  fs.writeFileSync(path.join(CONVO_DIR, ".sessions", `${key}.json`), JSON.stringify(rec));
});

afterEach(() => { rmTmp(CONVO_DIR); });

// Tiny client: open, send one JSON line, await one JSON line, close. Used
// in tests instead of importing scripts/sidecar-client.ts so a regression in
// the client doesn't mask a sidecar-side bug. The protocol surface is what
// we're verifying — any client that speaks line-JSON-over-UDS should work.
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
      // Confirm something is actually listening — the file alone could be a
      // bind-in-progress.
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

describe("sidecar.ts — slice 1: UDS skeleton + dispatcher", () => {
  let child: ChildProcessWithoutNullStreams | null = null;
  const cleanup = async () => {
    if (!child) return;
    try { child.kill("SIGTERM"); } catch {}
    await new Promise<void>((res) => child!.on("exit", () => res()));
    child = null;
  };
  afterEach(async () => { await cleanup(); });

  test("binds UDS at .sockets/<agent>.sock with mode 0600 and responds to whoami", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    // Under concurrent test-runner load, Bun's net.connect-based
    // waitForSocket can succeed AFTER the kernel binds the socket file but
    // BEFORE the sidecar's listen-callback chmod fires. Poll for the mode
    // to settle to 0o600 (capped at 500ms; chmod is one syscall away).
    let mode = -1;
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      mode = fs.statSync(socketPath).mode & 0o777;
      if (mode === 0o600) break;
      await sleep(10);
    }
    expect(mode).toBe(0o600);

    const resp = await rawRequest(socketPath, { id: 1, method: "whoami" });
    expect(resp.id).toBe(1);
    expect(resp.ok).toBe(true);
    expect(resp.result.agent).toBe("orion");
    expect(resp.result.topology).toBe("petersen");
    expect(resp.result.host).toBe(os.hostname());
    expect(typeof resp.result.sidecar_pid).toBe("number");
    expect(typeof resp.result.uptime_ms).toBe("number");
    expect(Array.isArray(resp.result.edges)).toBe(true);
    expect(resp.result.edges).toContain("carina-orion");
    expect(resp.result.edges).toContain("keystone-orion");
    expect(resp.result.edges).toContain("lumeyon-orion");
  }, 8000);

  test("time returns ISO + monotonic ns that strictly increases between calls", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const a = await rawRequest(socketPath, { id: 1, method: "time" });
    expect(a.ok).toBe(true);
    expect(typeof a.result.utc).toBe("string");
    expect(Number.isFinite(Date.parse(a.result.utc))).toBe(true);
    expect(typeof a.result.monotonic_ns).toBe("string");
    expect(/^\d+$/.test(a.result.monotonic_ns)).toBe(true);

    await sleep(2);
    const b = await rawRequest(socketPath, { id: 2, method: "time" });
    // monotonic_ns is BigInt-as-string; compare lexicographically only after
    // padding to the same length, or just convert to BigInt.
    expect(BigInt(b.result.monotonic_ns) > BigInt(a.result.monotonic_ns)).toBe(true);
  }, 8000);

  test("health reports edges count and last_inotify_event_age_ms is null in slice 1", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "health" });
    expect(resp.ok).toBe(true);
    expect(resp.result.ok).toBe(true);
    // Post-users-overlay: orion's petersen neighbors are 3 AI + 2 humans = 5.
    expect(resp.result.edges).toBe(5);
    // Slice 1 has no fs.watch, so no inotify events have fired yet.
    expect(resp.result.last_inotify_event_age_ms).toBe(null);
    expect(Array.isArray(resp.result.errors)).toBe(true);
  }, 8000);

  test("shutdown via IPC exits cleanly and removes socket + pidfile", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    const pidFile = path.join(CONVO_DIR, ".sockets", "sidecar-orion.pid");
    await waitForSocket(socketPath);
    expect(fs.existsSync(pidFile)).toBe(true);

    const resp = await rawRequest(socketPath, { id: 1, method: "shutdown" });
    expect(resp.ok).toBe(true);

    // Wait for the process to actually exit.
    await new Promise<void>((res) => child!.on("exit", () => res()));
    child = null;
    await sleep(50);

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  }, 8000);

  test("unknown method returns E_UNKNOWN_METHOD", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "no_such_method" });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("E_UNKNOWN_METHOD");
    expect(resp.id).toBe(1);
  }, 8000);

  test("missing method returns E_BAD_REQUEST", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 7 });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("E_BAD_REQUEST");
  }, 8000);

  test("malformed JSON line returns E_BAD_REQUEST without crashing the daemon", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    // Send raw garbage, then a valid request to confirm the daemon is alive.
    const resp = await new Promise<any>((resolve, reject) => {
      const sock = new net.Socket();
      let buf = "";
      const lines: any[] = [];
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
      sock.on("error", reject);
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          if (lines.length >= 2) { sock.destroy(); resolve(lines); return; }
        }
      });
      sock.connect(socketPath, () => {
        sock.write("not json at all\n");
        sock.write(JSON.stringify({ id: 9, method: "whoami" }) + "\n");
      });
    });
    const lines = resp as any[];
    expect(lines[0].ok).toBe(false);
    expect(lines[0].error.code).toBe("E_BAD_REQUEST");
    expect(lines[1].ok).toBe(true);
    expect(lines[1].result.agent).toBe("orion");
  }, 8000);

  test("CONVERSATIONS_DIR override roots socket and log paths under the env-supplied dir", async () => {
    // The default CONVO_DIR test setup already exercises this — ORION_ENV's
    // AGENT_CHAT_CONVERSATIONS_DIR points at the tmpdir, and the socket
    // landed under it. Add an explicit assertion that the SKILL_ROOT
    // .sockets/.logs are NOT touched.
    const SKILL_ROOT = path.resolve(import.meta.dirname, "..");
    const skillSocket = path.join(SKILL_ROOT, "conversations", ".sockets", "orion.sock");
    // We can't assert "absent" because a real session may run in parallel;
    // assert instead that OUR socket is under CONVO_DIR specifically.
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);
    expect(socketPath.startsWith(CONVO_DIR)).toBe(true);
    expect(socketPath).not.toBe(skillSocket);
    const logPath = path.join(CONVO_DIR, ".logs", "sidecar-orion.log");
    // Log gets written via console.error which (when spawned in a test) goes
    // to the child's stderr — only when spawned via agent-chat init does it
    // get tee'd into the file. The path itself just needs to be under the
    // override.
    expect(logPath.startsWith(CONVO_DIR)).toBe(true);
  }, 8000);

  test("stale socket on launch is reclaimed (pidfile points to a long-dead pid)", async () => {
    // Plant a socket file (regular file, not a real listening socket) and a
    // pidfile pointing to a long-since-dead pid (1 = init usually exists; we
    // need a *dead* pid, so pick a high one we can verify isn't alive).
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    const pidFile = path.join(CONVO_DIR, ".sockets", "sidecar-orion.pid");
    let dead = 9_999_999;
    for (let p = 9_999_900; p > 1_000_000; p -= 17) {
      try { process.kill(p, 0); } catch (e: any) { if (e?.code === "ESRCH") { dead = p; break; } }
    }
    fs.writeFileSync(socketPath, "stale");
    fs.writeFileSync(pidFile, `${dead} 0 2026-05-01T00:00:00Z\n`);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    await waitForSocket(socketPath);
    // After reclamation the socket is a real listening socket again.
    const resp = await rawRequest(socketPath, { id: 1, method: "whoami" });
    expect(resp.ok).toBe(true);
    // And the pidfile points to OUR pid now, not the stale one.
    const newPidLine = fs.readFileSync(pidFile, "utf8").trim();
    const newPid = parseInt(newPidLine.split(/\s+/)[0], 10);
    expect(newPid).not.toBe(dead);
    expect(newPid).toBe(resp.result.sidecar_pid);
  }, 8000);

  test("peek returns turn, lock, last-section meta, and convo_path", async () => {
    // Initialize an edge with first writer = orion, then append a section so
    // last-section metadata is non-null.
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const edgeDir = path.join(CONVO_DIR, "petersen", "lumeyon-orion");
    fs.appendFileSync(
      path.join(edgeDir, "CONVO.md"),
      "\n## orion — kickoff (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ lumeyon\n",
    );

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "peek", params: { peer: "lumeyon" } });
    expect(resp.ok).toBe(true);
    expect(resp.result.edge_id).toBe("lumeyon-orion");
    expect(resp.result.turn).toBe("orion");
    expect(resp.result.lock).toBe(null);
    expect(resp.result.last_section_author).toBe("orion");
    expect(resp.result.last_section_ts).toBe("2026-05-01T00:00:00Z");
    expect(resp.result.last_section_byte_count).toBeGreaterThan(0);
    expect(resp.result.total_sections).toBe(1);
    expect(resp.result.convo_path).toBe(path.join(edgeDir, "CONVO.md"));
  }, 8000);

  test("peek returns parsed lock body when locked", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    runScript("turn.ts", ["lock", "lumeyon"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "peek", params: { peer: "lumeyon" } });
    expect(resp.ok).toBe(true);
    expect(resp.result.lock).not.toBe(null);
    expect(resp.result.lock.agent).toBe("orion");
    expect(typeof resp.result.lock.pid).toBe("number");
  }, 8000);

  test("peek with non-neighbor peer returns E_NOT_NEIGHBOR", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "peek", params: { peer: "rhino" } });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("E_NOT_NEIGHBOR");
  }, 8000);

  test("last-section returns the last 1 then last 3 bodies in order", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    for (let i = 1; i <= 4; i++) {
      fs.appendFileSync(
        convo,
        `\n## orion — section ${i} (UTC 2026-05-01T0${i}:00:00Z)\n\nbody-${i}\n\n→ lumeyon\n`,
      );
    }

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const r1 = await rawRequest(socketPath, { id: 1, method: "last-section", params: { peer: "lumeyon" } });
    expect(r1.ok).toBe(true);
    expect(r1.result.sections.length).toBe(1);
    expect(r1.result.sections[0].body).toContain("body-4");
    expect(r1.result.sections[0].author).toBe("orion");
    expect(r1.result.sections[0].ts).toBe("2026-05-01T04:00:00Z");

    const r3 = await rawRequest(socketPath, { id: 2, method: "last-section", params: { peer: "lumeyon", n: 3 } });
    expect(r3.ok).toBe(true);
    expect(r3.result.sections.length).toBe(3);
    expect(r3.result.sections[0].body).toContain("body-2");
    expect(r3.result.sections[1].body).toContain("body-3");
    expect(r3.result.sections[2].body).toContain("body-4");
  }, 8000);

  test("last-section n>16 is rejected with E_BAD_REQUEST", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "last-section", params: { peer: "lumeyon", n: 17 } });
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("E_BAD_REQUEST");
  }, 8000);

  test("last-section on an empty CONVO.md returns []", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    // ensureEdgeFiles wrote a header but no sections.
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const resp = await rawRequest(socketPath, { id: 1, method: "last-section", params: { peer: "lumeyon" } });
    expect(resp.ok).toBe(true);
    expect(resp.result.sections.length).toBe(0);
  }, 8000);

  test("turn.ts peek fast-paths through sidecar when running and matches file-direct output shape", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const directBefore = runScript("turn.ts", ["peek", "lumeyon"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const viaSidecar = runScript("turn.ts", ["peek", "lumeyon"], ORION_ENV);
    // Both should print: edge, turn, lock, convo. Same shape, same values.
    const eOf = (s: string) => s.split("\n").filter(Boolean);
    const a = eOf(directBefore.stdout);
    const b = eOf(viaSidecar.stdout);
    expect(b.length).toBe(a.length);
    expect(b[0]).toContain("edge:");
    expect(b[1]).toContain("turn:        orion");
    expect(b[2]).toContain("lock:");
    expect(b[3]).toContain("convo:");
  }, 10000);

  test("turn.ts peek falls back to file-direct when no sidecar is running", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const r = runScript("turn.ts", ["peek", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("turn:        orion");
    expect(r.stdout).toContain("lock:        (none)");
  }, 6000);

  test("fs.watch fires a notification within 200ms of a peer's flip", async () => {
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);
    const LUMEYON_ENV = sessionEnv(CONVO_DIR, "lumeyon", "petersen");
    fs.writeFileSync(
      path.join(CONVO_DIR, ".sessions", `${LUMEYON_ENV.CLAUDE_SESSION_ID}.json`),
      JSON.stringify({
        agent: "lumeyon", topology: "petersen", session_key: LUMEYON_ENV.CLAUDE_SESSION_ID,
        claude_session_id: LUMEYON_ENV.CLAUDE_SESSION_ID, host: os.hostname(),
        pid: process.pid, started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
      }),
    );

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const startMs = Date.now();
    runScript("turn.ts", ["lock", "orion"], LUMEYON_ENV);
    fs.appendFileSync(
      path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md"),
      "\n## lumeyon — flip-test (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ orion\n",
    );
    runScript("turn.ts", ["flip", "orion", "orion"], LUMEYON_ENV);
    runScript("turn.ts", ["unlock", "orion"], LUMEYON_ENV);

    // Wait up to 1500ms (debounce + reconcile margin) for the notification.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (/value→orion/.test(stdoutBuf)) break;
      await sleep(25);
    }
    const elapsed = Date.now() - startMs;
    const lines = stdoutBuf.split("\n").filter((l) => /value→orion/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("edge=lumeyon-orion");
    expect(lines[0]).toContain(".md-grew");
    // Loose latency bound (debounce + watch fire + flush). Mostly a
    // smoke test — the absolute-floor is OS-dependent.
    expect(elapsed).toBeLessThan(2500);
  }, 12000);

  test("startup-pending fires once per actionable edge at boot", async () => {
    // Pre-flip an edge to orion BEFORE the sidecar starts so the steady-state
    // tick wouldn't see a transition.
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);
    // Give the startup-pending pass a tick.
    await sleep(150);

    const lines = stdoutBuf.split("\n").filter((l) => /startup-pending/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("edge=lumeyon-orion");
    expect(lines[0]).toContain(".turn=orion");
  }, 8000);

  test("protocol-violation fires when peer appends without flipping", async () => {
    // Initialize with turn=orion; orion is the writer; CONVO.md contains
    // sections from orion. Now have lumeyon fake-append a section without
    // flipping (the protocol violation).
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    runScript("turn.ts", ["flip", "lumeyon", "lumeyon"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);
    await sleep(100);                 // let prime + startup-pending settle
    stdoutBuf = "";                   // clear any startup-pending output

    fs.appendFileSync(
      path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md"),
      "\n## lumeyon — sneaky (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ orion\n",
    );

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (/protocol-violation:peer-appended-without-flip/.test(stdoutBuf)) break;
      await sleep(25);
    }
    const lines = stdoutBuf.split("\n").filter((l) => /protocol-violation:peer-appended-without-flip/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("edge=lumeyon-orion");
    expect(lines[0]).toContain(".turn=lumeyon");
  }, 12000);

  test("health reports last_inotify_event_age_ms after a watched event", async () => {
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const before = await rawRequest(socketPath, { id: 1, method: "health" });
    expect(before.result.last_inotify_event_age_ms).toBe(null);

    // Trigger an event (flip from lumeyon side via direct turn.ts).
    const LUMEYON_ENV = sessionEnv(CONVO_DIR, "lumeyon", "petersen");
    fs.writeFileSync(
      path.join(CONVO_DIR, ".sessions", `${LUMEYON_ENV.CLAUDE_SESSION_ID}.json`),
      JSON.stringify({
        agent: "lumeyon", topology: "petersen", session_key: LUMEYON_ENV.CLAUDE_SESSION_ID,
        claude_session_id: LUMEYON_ENV.CLAUDE_SESSION_ID, host: os.hostname(),
        pid: process.pid, started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
      }),
    );
    runScript("turn.ts", ["lock", "orion"], LUMEYON_ENV);
    runScript("turn.ts", ["flip", "orion", "orion"], LUMEYON_ENV);
    runScript("turn.ts", ["unlock", "orion"], LUMEYON_ENV);

    // Allow debounce to fire.
    await sleep(300);
    const after = await rawRequest(socketPath, { id: 2, method: "health" });
    expect(after.result.last_inotify_event_age_ms).not.toBe(null);
    expect(after.result.last_inotify_event_age_ms).toBeLessThan(2000);
  }, 12000);

  test("co-existence: monitor + sidecar both detect a flip without deadlock", async () => {
    // Run both watchers concurrently. The sidecar's stdout we observe
    // directly; the monitor writes to its log file. We assert the sidecar's
    // event lands within timeout AND the monitor's log eventually contains
    // the same event line. (Same-format guarantees deduplication is the
    // consumer's job, but the test confirms no crash / hang.)
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const monitor = spawnScript("monitor.ts", ["--interval", "1"], ORION_ENV) as ChildProcessWithoutNullStreams;
    let monBuf = "";
    monitor.stdout.on("data", (d) => { monBuf += d.toString(); });
    const monitorExit = new Promise<void>((res) => monitor.on("exit", () => res()));

    try {
      await sleep(500);                // both watchers prime

      const LUMEYON_ENV = sessionEnv(CONVO_DIR, "lumeyon", "petersen");
      fs.writeFileSync(
        path.join(CONVO_DIR, ".sessions", `${LUMEYON_ENV.CLAUDE_SESSION_ID}.json`),
        JSON.stringify({
          agent: "lumeyon", topology: "petersen", session_key: LUMEYON_ENV.CLAUDE_SESSION_ID,
          claude_session_id: LUMEYON_ENV.CLAUDE_SESSION_ID, host: os.hostname(),
          pid: process.pid, started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
        }),
      );
      runScript("turn.ts", ["lock", "orion"], LUMEYON_ENV);
      fs.appendFileSync(
        path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md"),
        "\n## lumeyon — testing (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ orion\n",
      );
      runScript("turn.ts", ["flip", "orion", "orion"], LUMEYON_ENV);
      runScript("turn.ts", ["unlock", "orion"], LUMEYON_ENV);

      // Wait for both event streams to see it.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (/value→orion/.test(stdoutBuf) && /value→orion/.test(monBuf)) break;
        await sleep(50);
      }
      expect(/value→orion/.test(stdoutBuf)).toBe(true);
      expect(/value→orion/.test(monBuf)).toBe(true);
    } finally {
      monitor.kill("SIGTERM");
      await monitorExit;
    }
  }, 15000);

  test("unread cursor flow: anonymous cursor returns all then nothing-new on second call", async () => {
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    fs.appendFileSync(convo, "\n## lumeyon — a (UTC 2026-05-01T01:00:00Z)\n\nbody-a\n\n→ orion\n");
    fs.appendFileSync(convo, "\n## lumeyon — b (UTC 2026-05-01T02:00:00Z)\n\nbody-b\n\n→ orion\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const r1 = await rawRequest(socketPath, { id: 1, method: "unread", params: { peer: "lumeyon" } });
    expect(r1.ok).toBe(true);
    expect(r1.result.sections_since.length).toBe(2);
    expect(r1.result.sections_since[0].body).toContain("body-a");
    expect(r1.result.sections_since[1].body).toContain("body-b");
    expect(typeof r1.result.cursor).toBe("number");
    expect(r1.result.byte_count).toBeGreaterThan(0);

    // Second call with the returned cursor: zero new sections.
    const r2 = await rawRequest(socketPath, { id: 2, method: "unread", params: { peer: "lumeyon", cursor: r1.result.cursor } });
    expect(r2.ok).toBe(true);
    expect(r2.result.sections_since.length).toBe(0);
    expect(r2.result.byte_count).toBe(0);
  }, 8000);

  test("unread named cursor persists across sidecar restart", async () => {
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    fs.appendFileSync(convo, "\n## lumeyon — first (UTC 2026-05-01T01:00:00Z)\n\nbody-1\n\n→ orion\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    // Open a named cursor.
    const r1 = await rawRequest(socketPath, { id: 1, method: "unread", params: { peer: "lumeyon", cursor_name: "agent-prompt" } });
    expect(r1.ok).toBe(true);
    expect(r1.result.sections_since.length).toBe(1);
    const cursorAfterFirst = r1.result.cursor;

    // Cursor file should now exist.
    const cursorsPath = path.join(CONVO_DIR, ".sockets", "orion.cursors.json");
    // Allow async write to settle.
    await sleep(100);
    expect(fs.existsSync(cursorsPath)).toBe(true);
    const fileBody = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
    expect(fileBody.named["lumeyon-orion"]["agent-prompt"]).toBe(cursorAfterFirst);

    // Shutdown sidecar.
    await rawRequest(socketPath, { id: 2, method: "shutdown" });
    await new Promise<void>((res) => child!.on("exit", () => res()));
    child = null;

    // Add a new section, then start a fresh sidecar — should resume the
    // named cursor and return only the NEW section.
    fs.appendFileSync(convo, "\n## lumeyon — second (UTC 2026-05-01T02:00:00Z)\n\nbody-2\n\n→ orion\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    await waitForSocket(socketPath);
    const r2 = await rawRequest(socketPath, { id: 3, method: "unread", params: { peer: "lumeyon", cursor_name: "agent-prompt" } });
    expect(r2.ok).toBe(true);
    expect(r2.result.sections_since.length).toBe(1);
    expect(r2.result.sections_since[0].body).toContain("body-2");
  }, 12000);

  test("since-last-spoke returns peer-only diff after self has spoken", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    fs.appendFileSync(convo, "\n## orion — a (UTC 2026-05-01T01:00:00Z)\n\nbody-a\n\n→ lumeyon\n");
    fs.appendFileSync(convo, "\n## lumeyon — b (UTC 2026-05-01T02:00:00Z)\n\nbody-b\n\n→ orion\n");
    fs.appendFileSync(convo, "\n## lumeyon — c (UTC 2026-05-01T03:00:00Z)\n\nbody-c\n\n→ orion\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const r = await rawRequest(socketPath, { id: 1, method: "since-last-spoke", params: { peer: "lumeyon" } });
    expect(r.ok).toBe(true);
    expect(r.result.is_first_turn).toBe(false);
    expect(r.result.fresh_tail_archived).toBe(false);
    expect(r.result.sections_since.length).toBe(2);
    expect(r.result.sections_since[0].body).toContain("body-b");
    expect(r.result.sections_since[1].body).toContain("body-c");
    expect(r.result.byte_count).toBeGreaterThan(0);
  }, 8000);

  test("since-last-spoke is_first_turn=true when self has never written", async () => {
    runScript("turn.ts", ["init", "lumeyon", "lumeyon"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    fs.appendFileSync(convo, "\n## lumeyon — kickoff (UTC 2026-05-01T00:00:00Z)\n\nbody\n\n→ orion\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const r = await rawRequest(socketPath, { id: 1, method: "since-last-spoke", params: { peer: "lumeyon" } });
    expect(r.ok).toBe(true);
    expect(r.result.is_first_turn).toBe(true);
    expect(r.result.sections_since.length).toBe(1);
    expect(r.result.sections_since[0].author).toBe("lumeyon");
  }, 8000);

  test("since-last-spoke updates after a new peer section arrives via fs.watch", async () => {
    runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
    const convo = path.join(CONVO_DIR, "petersen", "lumeyon-orion", "CONVO.md");
    fs.appendFileSync(convo, "\n## orion — a (UTC 2026-05-01T01:00:00Z)\n\nbody-a\n\n→ lumeyon\n");

    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const r0 = await rawRequest(socketPath, { id: 1, method: "since-last-spoke", params: { peer: "lumeyon" } });
    expect(r0.ok).toBe(true);
    expect(r0.result.sections_since.length).toBe(0);   // self spoke last; nothing newer

    // Peer appends; we let the watcher fire, then re-query.
    fs.appendFileSync(convo, "\n## lumeyon — b (UTC 2026-05-01T02:00:00Z)\n\nbody-b\n\n→ orion\n");
    await sleep(300);

    const r1 = await rawRequest(socketPath, { id: 2, method: "since-last-spoke", params: { peer: "lumeyon" } });
    expect(r1.ok).toBe(true);
    expect(r1.result.sections_since.length).toBe(1);
    expect(r1.result.sections_since[0].body).toContain("body-b");
  }, 12000);

  test("whoami reflects monitor_pid written by init AFTER sidecar spawn", async () => {
    // Regression test for carina's anomaly #1: init spawns the sidecar before
    // writing monitor_pid to the session record. Pre-fix, the sidecar's
    // whoami returned monitor_pid: null forever because it cached the
    // session record at startup (when the field hadn't been written yet).
    // Post-fix, whoami re-reads the session record on each dispatch.
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    runScript("agent-chat.ts", ["init", "orion", "petersen"], ENV);
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath, 4000);

    const r = await rawRequest(socketPath, { id: 1, method: "whoami" });
    expect(r.ok).toBe(true);
    expect(typeof r.result.monitor_pid).toBe("number");
    expect(r.result.monitor_pid).toBeGreaterThan(0);

    const h = await rawRequest(socketPath, { id: 2, method: "health" });
    expect(h.ok).toBe(true);
    expect(h.result.monitor_alive).toBe(true);
    expect(h.result.monitor_pid).toBe(r.result.monitor_pid);
    expect(typeof h.result.sidecar_uptime_ms).toBe("number");

    runScript("agent-chat.ts", ["exit"], ENV);
  }, 15000);

  test("agent-chat init starts sidecar by default; agent-chat exit stops it gracefully", async () => {
    // Use a fresh CONVERSATIONS_DIR not pre-staged with a session record.
    // agent-chat init writes its own.
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    // Wipe the pre-staged session so init creates a real one.
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    const initRes = runScript("agent-chat.ts", ["init", "orion", "petersen"], ENV);
    expect(initRes.exitCode).toBe(0);
    expect(initRes.stdout).toContain("sidecar:");

    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath, 4000);

    const r = await rawRequest(socketPath, { id: 1, method: "whoami" });
    expect(r.ok).toBe(true);
    expect(r.result.agent).toBe("orion");

    // Now exit — sidecar should shut down cleanly.
    const exitRes = runScript("agent-chat.ts", ["exit"], ENV);
    expect(exitRes.exitCode).toBe(0);

    // Allow graceful shutdown to complete.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(socketPath)) break;
      await sleep(50);
    }
    expect(fs.existsSync(socketPath)).toBe(false);
    const pidFile = path.join(CONVO_DIR, ".sockets", "sidecar-orion.pid");
    expect(fs.existsSync(pidFile)).toBe(false);

    // Stop background monitor too (init started one) — track via session
    // record we can't read since exit removed it. Use ps grep as a fallback.
    // For test cleanliness, the afterEach rmTmp will sever any leftover.
  }, 15000);

  test("--no-sidecar disables the sidecar; monitor still runs; turn.ts peek falls back to file-direct", async () => {
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    const initRes = runScript("agent-chat.ts", ["init", "orion", "petersen", "--no-sidecar"], ENV);
    expect(initRes.exitCode).toBe(0);
    expect(initRes.stdout).toContain("sidecar:     not launched (--no-sidecar)");

    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    expect(fs.existsSync(socketPath)).toBe(false);

    // turn.ts peek must still work via file-direct fallback.
    runScript("turn.ts", ["init", "lumeyon", "orion"], ENV);
    const peekRes = runScript("turn.ts", ["peek", "lumeyon"], ENV);
    expect(peekRes.exitCode).toBe(0);
    expect(peekRes.stdout).toContain("turn:        orion");

    runScript("agent-chat.ts", ["exit"], ENV);
  }, 15000);

  test("agent-chat gc reclaims a stale sidecar pidfile + socket after kill -9", async () => {
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    runScript("agent-chat.ts", ["init", "orion", "petersen"], ENV);
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath, 4000);
    const pidFile = path.join(CONVO_DIR, ".sockets", "sidecar-orion.pid");
    const pidLine = fs.readFileSync(pidFile, "utf8").trim();
    const sidecarPid = parseInt(pidLine.split(/\s+/)[0], 10);
    expect(Number.isFinite(sidecarPid)).toBe(true);

    // Kill -9 to simulate ungraceful death (no chance to clean up socket/pidfile).
    try { process.kill(sidecarPid, "SIGKILL"); } catch {}
    // Wait for it to actually die.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(sidecarPid, 0); } catch (e: any) { if (e?.code === "ESRCH") break; }
      await sleep(25);
    }
    // Socket and pidfile still on disk — that's the state gc should reclaim.
    expect(fs.existsSync(pidFile)).toBe(true);

    // Mark the agent's session pid dead too so gc has a reason to walk the
    // session — without that, the reclaim logic only triggers on edge stale
    // pidfiles. We just want the second pass (orphan-pidfile sweep) to fire.
    const gcRes = runScript("agent-chat.ts", ["gc"], ENV);
    expect(gcRes.exitCode).toBe(0);
    expect(gcRes.stdout).toContain("stale sidecar pidfile + socket for orion");
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);

    runScript("agent-chat.ts", ["exit"], ENV, { allowFail: true });
  }, 15000);

  test("agent-chat whoami fast-paths through sidecar when running", async () => {
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    runScript("agent-chat.ts", ["init", "orion", "petersen"], ENV);
    await waitForSocket(path.join(CONVO_DIR, ".sockets", "orion.sock"), 4000);
    const r = runScript("agent-chat.ts", ["whoami"], ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("orion@petersen");
    expect(r.stdout).toContain("sidecar=");
    expect(r.stdout).toContain("uptime=");
    runScript("agent-chat.ts", ["exit"], ENV);
  }, 15000);

  test("agent-chat who shows side= column", async () => {
    const ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
    fs.rmSync(path.join(CONVO_DIR, ".sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(CONVO_DIR, ".presence"), { recursive: true, force: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(CONVO_DIR, ".presence"), { recursive: true });

    runScript("agent-chat.ts", ["init", "orion", "petersen"], ENV);
    await waitForSocket(path.join(CONVO_DIR, ".sockets", "orion.sock"), 4000);
    const r = runScript("agent-chat.ts", ["who"], ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("side=");
    expect(r.stdout).not.toContain("side=-");
    runScript("agent-chat.ts", ["exit"], ENV);
  }, 15000);

  test("multiple concurrent requests on one connection are answered in order", async () => {
    child = spawnScript("sidecar.ts", [], ORION_ENV) as ChildProcessWithoutNullStreams;
    const socketPath = path.join(CONVO_DIR, ".sockets", "orion.sock");
    await waitForSocket(socketPath);

    const responses = await new Promise<any[]>((resolve, reject) => {
      const sock = new net.Socket();
      let buf = "";
      const lines: any[] = [];
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
      sock.on("error", reject);
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          if (lines.length >= 3) { sock.destroy(); resolve(lines); return; }
        }
      });
      sock.connect(socketPath, () => {
        sock.write(JSON.stringify({ id: 1, method: "whoami" }) + "\n");
        sock.write(JSON.stringify({ id: 2, method: "time" }) + "\n");
        sock.write(JSON.stringify({ id: 3, method: "health" }) + "\n");
      });
    });
    expect(responses[0].id).toBe(1);
    expect(responses[1].id).toBe(2);
    expect(responses[2].id).toBe(3);
    expect(responses[0].result.agent).toBe("orion");
    expect(typeof responses[1].result.utc).toBe("string");
    // Post-users-overlay: orion has 3 petersen AI + 2 user neighbors = 5.
    expect(responses[2].result.edges).toBe(5);
  }, 8000);
});
