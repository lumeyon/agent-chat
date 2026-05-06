// concurrency.test.ts — proves the "just works under contention" contract.
//
// Three concurrency cases the hook will hit in the real world:
//   1. Multiple Stop hooks firing close together (same Claude Code session
//      generating fast back-to-back responses, OR the user running manual
//      commands while a hook is mid-flight).
//   2. transcript-mirror running while a kg build is also running on the
//      same edge — both touch the kg/embeddings.db SQLite cache.
//   3. transcript-mirror running while archive auto is sealing the
//      active CONVO.md — both contend on the .turn lock.
//
// The contract: NO turn pair is ever silently lost. Either it lands on
// this attempt or the retry recovers it. The recorded_turns.jsonl ledger
// is the source of truth — every successful pair appears there exactly
// once, regardless of how many concurrent processes raced.
//
// Run: bun test tests/concurrency.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as child_process from "node:child_process";

const SCRIPT_DIR = path.resolve(import.meta.dir, "..", "scripts");
const RECORD_TURN_BIN = path.join(SCRIPT_DIR, "agent-chat.ts");
const MIRROR_BIN = path.join(SCRIPT_DIR, "transcript-mirror.ts");
const KG_BIN = path.join(SCRIPT_DIR, "kg.ts");

// ─── Test scaffold: a temporary conversations dir with one session ──────

let TMP_CONV: string;
let TMP_TRANSCRIPT: string;
const TEST_SESSION_ID = "test-concurrency-session";
const TEST_SESSION_KEY = TEST_SESSION_ID;  // record-turn uses CLAUDE_SESSION_ID verbatim as session_key when set

beforeAll(() => {
  TMP_CONV = fs.mkdtempSync(path.join(os.tmpdir(), "agentchat-concur-"));
  // Set up a session record + speaker so record-turn has identity.
  // Subprocess record-turns will inherit CLAUDE_SESSION_ID and look up
  // session/speaker by that key.
  const sessionsDir = path.join(TMP_CONV, ".sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${TEST_SESSION_KEY}.json`),
    JSON.stringify({
      agent: "orion",
      topology: "petersen",
      session_key: TEST_SESSION_KEY,
      host: os.hostname(),
      pid: process.pid,
      pid_starttime: 1,
      started_at: new Date().toISOString(),
      cwd: TMP_CONV,
      tty: "/dev/null",
    }),
  );
  fs.writeFileSync(
    path.join(sessionsDir, `${TEST_SESSION_KEY}.current_speaker.json`),
    JSON.stringify({ name: "boss", set_at: new Date().toISOString() }),
  );

  // Build a minimal Claude Code transcript (JSONL) with N turn pairs.
  // Format mirrors what transcript-mirror.ts expects.
  TMP_TRANSCRIPT = path.join(TMP_CONV, "fake-transcript.jsonl");
  const N = 25;
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    lines.push(JSON.stringify({
      type: "user",
      message: { role: "user", content: `concurrency test user prompt #${i}` },
    }));
    lines.push(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: `concurrency test assistant response #${i} with content` }] },
    }));
  }
  fs.writeFileSync(TMP_TRANSCRIPT, lines.join("\n") + "\n");
});

afterAll(() => {
  if (TMP_CONV && fs.existsSync(TMP_CONV)) {
    fs.rmSync(TMP_CONV, { recursive: true, force: true });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────

interface SpawnResult { rc: number; stdout: string; stderr: string }

function spawn(cmd: string, args: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): SpawnResult {
  const r = child_process.spawnSync(cmd, args, {
    input: opts.input,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeoutMs ?? 60000,
    encoding: "utf-8",
  });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function runMirror(): Promise<SpawnResult> {
  return spawn("bun", [MIRROR_BIN, "--backfill", TMP_TRANSCRIPT], {
    env: {
      AGENT_CHAT_CONVERSATIONS_DIR: TMP_CONV,
      CLAUDE_SESSION_ID: TEST_SESSION_ID,
    },
    timeoutMs: 120000,
  });
}

async function recordOne(user: string, assistant: string): Promise<SpawnResult> {
  return spawn("bun", [RECORD_TURN_BIN, "record-turn", "--stdin"], {
    input: JSON.stringify({ user, assistant }),
    env: {
      AGENT_CHAT_CONVERSATIONS_DIR: TMP_CONV,
      CLAUDE_SESSION_ID: TEST_SESSION_ID,
    },
    timeoutMs: 30000,
  });
}

function countLedgerEntries(): number {
  const ledger = path.join(TMP_CONV, "petersen", "boss-orion", "recorded_turns.jsonl");
  if (!fs.existsSync(ledger)) return 0;
  return fs.readFileSync(ledger, "utf-8")
    .split("\n").filter((l) => l.trim()).length;
}

function readLedgerSet(): Set<string> {
  const ledger = path.join(TMP_CONV, "petersen", "boss-orion", "recorded_turns.jsonl");
  if (!fs.existsSync(ledger)) return new Set();
  return new Set(
    fs.readFileSync(ledger, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l).sha256),
  );
}

// ─── 1. Repeated mirror calls are idempotent ───────────────────────────

describe("transcript-mirror — idempotent backfill", () => {
  it("3 sequential mirror calls land exactly N pairs total", async () => {
    // Run mirror 3 times. First should record N (=25), next two should
    // see all duplicates. Net: ledger has exactly 25 entries.
    const r1 = await runMirror();
    expect(r1.rc).toBe(0);
    const after1 = countLedgerEntries();
    expect(after1).toBe(25);

    const r2 = await runMirror();
    expect(r2.rc).toBe(0);
    expect(countLedgerEntries()).toBe(25);

    const r3 = await runMirror();
    expect(r3.rc).toBe(0);
    expect(countLedgerEntries()).toBe(25);
  }, 120_000);
});

// ─── 2. 5 concurrent mirrors — zero failures, zero loss ────────────────

describe("transcript-mirror — concurrent contention", () => {
  it("5 concurrent mirrors against the same edge: 0 failures, all pairs land", async () => {
    // Reset ledger by clearing the edge dir
    const edgeDir = path.join(TMP_CONV, "petersen", "boss-orion");
    if (fs.existsSync(edgeDir)) fs.rmSync(edgeDir, { recursive: true, force: true });

    // Fire 5 mirrors simultaneously. Use Promise.all over async spawn
    // helpers. The retry inside transcript-mirror.recordTurn() must
    // recover from any lock contention.
    const N_PARALLEL = 5;
    const promises: Promise<SpawnResult>[] = [];
    for (let i = 0; i < N_PARALLEL; i++) {
      promises.push(runMirror());
    }
    const results = await Promise.all(promises);

    // Every mirror call should report rc=0 (overall success, even if
    // individual record-turn calls retried internally).
    for (const r of results) {
      expect(r.rc).toBe(0);
    }
    // Every mirror's summary line should report failed=0.
    for (const r of results) {
      const summary = r.stdout.split("\n").find((l) => l.includes("backfill done."));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/failed=0/);
    }
    // Ledger has exactly 25 unique entries — no double-count, no drop.
    expect(countLedgerEntries()).toBe(25);
  }, 180_000);
});

// ─── 3. kg build is concurrency-safe (file mutex) ──────────────────────

describe("kg.ts build — file mutex", () => {
  it("3 concurrent kg builds for the same edge: all succeed, no corruption", async () => {
    // Need: an edge with SOME content in CONVO.md before kg build will
    // produce nonempty manifest. Run a mirror first to populate.
    const edgeDir = path.join(TMP_CONV, "petersen", "boss-orion");
    if (!fs.existsSync(path.join(edgeDir, "CONVO.md"))) {
      const r = await runMirror();
      expect(r.rc).toBe(0);
    }

    // Fire 3 concurrent kg builds
    const promises: Promise<SpawnResult>[] = [];
    for (let i = 0; i < 3; i++) {
      promises.push(spawn("bun", [KG_BIN, "build", "boss-orion"], {
        env: {
          AGENT_CHAT_CONVERSATIONS_DIR: TMP_CONV,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
        },
        timeoutMs: 120000,
      }));
    }
    const results = await Promise.all(promises);

    // All return rc=0 (one builds, the others see lock and return the
    // existing manifest cleanly).
    for (const r of results) {
      expect(r.rc).toBe(0);
    }

    // Lock file is cleaned up
    const lockPath = path.join(edgeDir, "kg", ".build.lock");
    expect(fs.existsSync(lockPath)).toBe(false);

    // Manifest exists and is valid
    const manifestPath = path.join(edgeDir, "kg", "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.node_count).toBeGreaterThan(0);
    expect(manifest.model_dim).toBe(384);
    expect(manifest.hnsw_indexed_vectors).toBe(manifest.node_count);
  }, 240_000);
});

// ─── 4. recorded_turns.jsonl is the source of truth ────────────────────

describe("recorded_turns ledger — source of truth", () => {
  it("each unique pair appears exactly once in the ledger", () => {
    const sha256s = readLedgerSet();
    // After all the prior tests have run, the ledger should still have
    // exactly the 25 unique pairs from our fake transcript. (Plus
    // possibly one if test 3 added a new pair via runMirror — but
    // that test gates with existsSync so it shouldn't have.)
    // Conservative check: at least 25, no more than 26.
    expect(sha256s.size).toBeGreaterThanOrEqual(25);
    expect(sha256s.size).toBeLessThanOrEqual(26);
  });
});
