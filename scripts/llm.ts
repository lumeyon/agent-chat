// llm.ts — shared LLM-shell-out primitive for slice 1 (archive/condense
// summarization) and slice 3 (expansion subagent). Round 12 deviation from
// the original "no LLM in scripts" rule: documented in ARCHITECTURE.md as
// gated, opt-out-able, never load-bearing for correctness.
//
// Design (Round 12 Phase 2 consolidated):
//   - claude binary probed at module load via `claude --version` (2s timeout).
//     Handles non-executable, directory, stale-binary cases beyond bare
//     PATH-walk. Probe failure → CLAUDE_AVAILABLE=false; one stderr warning.
//   - runClaude() spawns the binary with the LLM prompt on stdin, captures
//     stdout (256KB cap), stderr (64KB cap), with SIGTERM+5s+SIGKILL on
//     timeout (default 60s).
//   - Child env scrubbed of agent-chat identity vars ($AGENT_NAME,
//     $AGENT_TOPOLOGY, $AGENT_CHAT_USER) so the LLM doesn't accidentally
//     inherit a session identity it shouldn't claim. AGENT_CHAT_INSIDE_LLM_CALL=1
//     is set so any descendant that loads the agent-chat skill refuses to
//     init/lock/record-turn (reentrancy guard — pulsar Round 12 P1 load-bearing).
//   - reason discriminator returned in the result shape so callers can grep
//     without stderr substring matching (pulsar Round 12 P1 add).
//   - In-process semaphore caps concurrent LLM calls at 2 (cadence Round 12 P1
//     add — cost / rate-limit defense). Configurable via AGENT_CHAT_LLM_CAP.
//   - isLlmEnabled() implements the Round 12 precedence chain:
//     `--llm` > `--no-llm` > `AGENT_CHAT_NO_LLM` > probe.
//     Both `--llm` AND `--no-llm` simultaneously is a config error (caller dies).

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Probe at module load. We resolve `claude` once and cache the absolute path.
// If user upgrades claude mid-session and the binary moves, helper still calls
// the old path → ENOENT → fallback. Predictable; documented.
// ---------------------------------------------------------------------------

export type ClaudeProbeResult = {
  available: boolean;
  path: string | null;
  version: string | null;
  reason: string;  // "ok" | "not-on-PATH" | "not-executable" | "version-failed" | "timeout" | "spawn-error"
};

function resolveClaudePath(): string | null {
  // AGENT_CHAT_CLAUDE_BIN env override (Round 12 Phase 2 consolidation —
  // helps tests + custom installs). Mirrors AGENT_CHAT_CONVERSATIONS_DIR.
  // If set, used STRICTLY: a missing/non-executable path returns null (no
  // PATH-walk fallback). Tests rely on this strictness to mock unavailability
  // without leaking into the real PATH.
  const override = process.env.AGENT_CHAT_CLAUDE_BIN;
  if (override && override.trim()) {
    const p = path.resolve(override.trim());
    if (fs.existsSync(p)) return p;
    return null;
  }
  const PATH = process.env.PATH || "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "claude");
    try {
      const st = fs.statSync(p);
      if (st.isFile() || st.isSymbolicLink()) return p;
    } catch { /* not in this dir */ }
  }
  return null;
}

function probeClaudeOnce(): ClaudeProbeResult {
  const p = resolveClaudePath();
  if (!p) return { available: false, path: null, version: null, reason: "not-on-PATH" };
  try {
    const r = child_process.spawnSync(p, ["--version"], {
      timeout: 2000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) {
      return { available: false, path: p, version: null, reason: "spawn-error" };
    }
    if ((r as any).signal === "SIGTERM" || (r.status == null && !r.error)) {
      return { available: false, path: p, version: null, reason: "timeout" };
    }
    if (r.status !== 0) {
      return { available: false, path: p, version: null, reason: "version-failed" };
    }
    const version = (r.stdout || "").trim().slice(0, 200);
    return { available: true, path: p, version, reason: "ok" };
  } catch {
    return { available: false, path: p, version: null, reason: "spawn-error" };
  }
}

let probed: ClaudeProbeResult | null = null;
function ensureProbed(): ClaudeProbeResult {
  if (probed) return probed;
  probed = probeClaudeOnce();
  if (!probed.available && process.env.AGENT_CHAT_NO_LLM !== "1") {
    // Single warning per process; tests can suppress by setting AGENT_CHAT_NO_LLM=1.
    console.error(`[agent-chat] claude binary unavailable (${probed.reason}); LLM summarizer disabled, using deterministic synthesizer.`);
  }
  return probed;
}

export function getClaudeProbe(): ClaudeProbeResult {
  return ensureProbed();
}

// Test-only hook: reset the cached probe so a fresh module-load can re-detect.
// Production code never calls this. Tests use it to swap AGENT_CHAT_CLAUDE_BIN.
export function resetClaudeProbeForTests(): void {
  probed = null;
}

// ---------------------------------------------------------------------------
// In-process semaphore (cadence's add — concurrent LLM cap).
// Default 2; AGENT_CHAT_LLM_CAP env override (decimal int, min 1).
// ---------------------------------------------------------------------------

function defaultCap(): number {
  const raw = process.env.AGENT_CHAT_LLM_CAP;
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 2;
  return n;
}

let semInFlight = 0;
const semWaiters: Array<() => void> = [];
let semCap: number | null = null;

function acquireSlot(): Promise<void> {
  if (semCap == null) semCap = defaultCap();
  if (semInFlight < semCap) {
    semInFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    semWaiters.push(() => {
      semInFlight++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  semInFlight = Math.max(0, semInFlight - 1);
  const next = semWaiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// runClaude — primary entry point. Exact shape per Phase 2 contract.
// ---------------------------------------------------------------------------

export type RunClaudeReason =
  | "ok"
  | "not-found"
  | "timeout"
  | "exit"
  | "killed"
  | "spawn-error"
  | "reentrancy"
  | "stdout-cap-exceeded"
  | "stderr-cap-exceeded";

export type RunClaudeResult = {
  stdout: string | null;  // null on any failure
  stderr: string;
  code: number | null;
  reason: RunClaudeReason;
};

export type RunClaudeOpts = {
  args?: string[];        // forwarded to claude after `-p --output-format=text`
  prompt: string;         // piped to stdin
  timeoutMs?: number;     // default 60000
};

const STDOUT_CAP = 256 * 1024;
const STDERR_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const SIGTERM_GRACE_MS = 5_000;

export async function runClaude(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  // Reentrancy guard — refuse to recurse into the LLM if we're already inside
  // an LLM call. Without this, an LLM-summoned descendant that calls
  // archive.ts auto would spawn another claude, which would spawn another...
  if (process.env.AGENT_CHAT_INSIDE_LLM_CALL === "1") {
    return { stdout: null, stderr: "", code: null, reason: "reentrancy" };
  }
  // Honor AGENT_CHAT_NO_LLM=1 so callers can run hermetically. Reuses the
  // "not-found" discriminator; cmdRun + archive.auto already treat it as
  // skip-this-LLM-call, no separate handler needed.
  if (process.env.AGENT_CHAT_NO_LLM === "1") {
    return { stdout: null, stderr: "AGENT_CHAT_NO_LLM=1", code: null, reason: "not-found" };
  }
  const probe = ensureProbed();
  if (!probe.available || !probe.path) {
    return { stdout: null, stderr: probe.reason, code: null, reason: "not-found" };
  }

  await acquireSlot();
  try {
    return await runClaudeUnsynchronized(probe.path, opts);
  } finally {
    releaseSlot();
  }
}

function scrubChildEnv(): NodeJS.ProcessEnv {
  // Remove agent-chat identity vars so the LLM doesn't claim a session.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_NAME;
  delete env.AGENT_TOPOLOGY;
  delete env.AGENT_CHAT_USER;
  // Reentrancy guard sentinel — descendants see it and refuse init/lock/record-turn.
  env.AGENT_CHAT_INSIDE_LLM_CALL = "1";
  return env;
}

function runClaudeUnsynchronized(claudePath: string, opts: RunClaudeOpts): Promise<RunClaudeResult> {
  return new Promise<RunClaudeResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = ["-p", "--output-format=text", ...(opts.args ?? [])];
    let child: child_process.ChildProcessWithoutNullStreams;
    try {
      child = child_process.spawn(claudePath, args, {
        env: scrubChildEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({ stdout: null, stderr: String(err?.message ?? err), code: null, reason: "spawn-error" });
      return;
    }

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    let stdoutCapExceeded = false;
    let stderrCapExceeded = false;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    };
    const finish = (r: RunClaudeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (stdoutCapExceeded) return;
      if (stdoutBuf.length + chunk.length > STDOUT_CAP) {
        stdoutCapExceeded = true;
        try { child.kill("SIGTERM"); } catch {}
        finish({ stdout: null, stderr: stderrBuf.slice(0, STDERR_CAP), code: null, reason: "stdout-cap-exceeded" });
        return;
      }
      stdoutBuf += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrCapExceeded) return;
      if (stderrBuf.length + chunk.length > STDERR_CAP) {
        stderrCapExceeded = true;
        try { child.kill("SIGTERM"); } catch {}
        finish({ stdout: null, stderr: stderrBuf.slice(0, STDERR_CAP), code: null, reason: "stderr-cap-exceeded" });
        return;
      }
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      finish({ stdout: null, stderr: String(err.message), code: null, reason: "spawn-error" });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      if (signal) {
        finish({ stdout: null, stderr: stderrBuf.slice(0, STDERR_CAP), code: null, reason: "killed" });
        return;
      }
      if (code === 0) {
        finish({ stdout: stdoutBuf, stderr: stderrBuf.slice(0, STDERR_CAP), code: 0, reason: "ok" });
        return;
      }
      finish({ stdout: null, stderr: stderrBuf.slice(0, STDERR_CAP), code: code ?? null, reason: "exit" });
    });

    // Pipe prompt to stdin then close it so claude doesn't block waiting for more input.
    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch (err: any) {
      // Stdin write race (child died early). Let the exit/error handler resolve.
    }

    // Hard timeout: SIGTERM, 5s grace, then SIGKILL.
    killTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      graceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, SIGTERM_GRACE_MS);
      // Resolve as timeout immediately; the child will be reaped asynchronously.
      finish({ stdout: null, stderr: stderrBuf.slice(0, STDERR_CAP), code: null, reason: "timeout" });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// isLlmEnabled — precedence chain consolidator.
//   `--llm`               > overrides everything
//   `--no-llm`            > disables
//   `AGENT_CHAT_NO_LLM=1` > disables
//   probe                 > falls back if claude unavailable
// Both `--llm` and `--no-llm` simultaneously → caller MUST refuse with config
// error (we return enabled:false + reason='conflict' so caller can detect).
// ---------------------------------------------------------------------------

export type IsLlmEnabledOpts = {
  noLlmFlag?: boolean;  // CLI --no-llm passed
  llmFlag?: boolean;    // CLI --llm passed
};

export type IsLlmEnabledResult = {
  enabled: boolean;
  reason: "llm-flag" | "no-llm-flag" | "env-disabled" | "probe-failed" | "default-on" | "conflict";
};

export function isLlmEnabled(opts: IsLlmEnabledOpts = {}): IsLlmEnabledResult {
  if (opts.llmFlag && opts.noLlmFlag) {
    return { enabled: false, reason: "conflict" };
  }
  if (opts.llmFlag) {
    // Override even AGENT_CHAT_NO_LLM=1; explicit user opt-in.
    const probe = ensureProbed();
    if (!probe.available) return { enabled: false, reason: "probe-failed" };
    return { enabled: true, reason: "llm-flag" };
  }
  if (opts.noLlmFlag) {
    return { enabled: false, reason: "no-llm-flag" };
  }
  if (process.env.AGENT_CHAT_NO_LLM === "1") {
    return { enabled: false, reason: "env-disabled" };
  }
  const probe = ensureProbed();
  if (!probe.available) return { enabled: false, reason: "probe-failed" };
  return { enabled: true, reason: "default-on" };
}
