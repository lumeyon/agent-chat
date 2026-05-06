#!/usr/bin/env bun
// scripts/codex-app-phase-a.ts — empirical Codex app-server Phase A smoke.
//
// This is intentionally a real CLI probe, not a unit test. It answers the
// app-server questions that shape the codex-app runtime design:
//   - Does fs/watch observe atomic tmp+rename writes to a watched file?
//   - Does directory watching observe the same rewrite?
//   - What notifications are needed to reconstruct assistant output?
//   - Can a thread be resumed after the app-server process restarts?

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Json = any;

type Pending = {
  resolve: (value: Json) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textInput(text: string): Json {
  return { type: "text", text, text_elements: [] };
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

class AppServer {
  private child: child_process.ChildProcessWithoutNullStreams;
  private seq = 1;
  private buf = "";
  private pending = new Map<number, Pending>();
  readonly notifications: Json[] = [];
  readonly stderr: string[] = [];

  private constructor(child: child_process.ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    child.on("exit", (code, signal) => {
      const err = new Error(`codex app-server exited code=${code} signal=${signal}`);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
        this.pending.delete(id);
      }
    });
  }

  static async start(): Promise<AppServer> {
    const child = child_process.spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const server = new AppServer(child);
    await server.initialize();
    return server;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) return;
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        this.notifications.push({ method: "__parse_error__", params: { line } });
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: Json): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`${msg.error.message ?? "JSON-RPC error"} ${JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    this.notifications.push(msg);
  }

  async initialize(): Promise<Json> {
    const result = await this.request("initialize", {
      clientInfo: { name: "agent-chat-phase-a", title: "Agent Chat Phase A", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    }, 15_000);
    this.notify("initialized");
    return result;
  }

  request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    const id = this.seq++;
    const msg = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method: string, params?: Json): void {
    const msg = params === undefined ? { method } : { method, params };
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async waitFor(predicate: (msg: Json) => boolean, timeoutMs: number): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      for (; seen < this.notifications.length; seen++) {
        const msg = this.notifications[seen];
        if (predicate(msg)) return msg;
      }
      await sleep(50);
    }
    throw new Error(`timeout waiting for notification after ${timeoutMs}ms`);
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.child.killed) this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function notificationMethods(server: AppServer, threadId?: string): string[] {
  return server.notifications
    .filter((msg) => {
      if (!threadId) return true;
      const p = msg.params;
      return p?.threadId === threadId || p?.thread?.id === threadId;
    })
    .map((msg) => msg.method);
}

function assistantText(server: AppServer, threadId: string, turnId: string): string {
  const completed = server.notifications
    .filter((msg) => msg.method === "item/completed")
    .filter((msg) => msg.params?.threadId === threadId && msg.params?.turnId === turnId)
    .map((msg) => msg.params?.item)
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("");
  if (completed.trim()) return completed.trim();

  return server.notifications
    .filter((msg) => msg.method === "item/agentMessage/delta")
    .filter((msg) => msg.params?.threadId === threadId && msg.params?.turnId === turnId)
    .map((msg) => msg.params?.delta ?? "")
    .join("")
    .trim();
}

function diagnosticEvents(server: AppServer, threadId: string, turnId?: string): Json {
  const matchesThread = (msg: Json) => {
    const p = msg.params;
    if (p?.threadId === threadId || p?.thread?.id === threadId) return true;
    return false;
  };
  const matchesTurn = (msg: Json) => {
    if (!turnId) return true;
    return msg.params?.turnId === turnId || msg.params?.turn?.id === turnId;
  };
  return {
    errors: server.notifications
      .filter((msg) => msg.method === "error" && matchesThread(msg) && matchesTurn(msg))
      .map((msg) => msg.params),
    itemCompletedTypes: server.notifications
      .filter((msg) => msg.method === "item/completed" && matchesThread(msg) && matchesTurn(msg))
      .map((msg) => msg.params?.item?.type ?? null),
    turnCompleted: server.notifications
      .filter((msg) => msg.method === "turn/completed" && matchesThread(msg) && matchesTurn(msg))
      .map((msg) => msg.params?.turn),
  };
}

async function probeFsWatch(server: AppServer): Promise<Json> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-codex-app-watch-"));
  const turn = path.join(dir, "CONVO.md.turn");
  fs.writeFileSync(turn, "orion");

  const before = server.notifications.length;
  const fileWatch = await server.request("fs/watch", { watchId: "phase-a-file", path: turn });
  const dirWatch = await server.request("fs/watch", { watchId: "phase-a-dir", path: dir });

  const replacements = ["lumeyon", "orion"];
  for (const [i, value] of replacements.entries()) {
    const tmp = path.join(dir, `CONVO.md.turn.tmp.${process.pid}.${i}`);
    fs.writeFileSync(tmp, value);
    fs.renameSync(tmp, turn);
    await sleep(500);
  }
  await sleep(500);

  const fsEvents = server.notifications
    .slice(before)
    .filter((msg) => msg.method === "fs/changed")
    .map((msg) => msg.params);

  await server.request("fs/unwatch", { watchId: "phase-a-file" }).catch(() => null);
  await server.request("fs/unwatch", { watchId: "phase-a-dir" }).catch(() => null);

  return {
    tempDir: dir,
    target: turn,
    fileWatchPath: fileWatch.path,
    dirWatchPath: dirWatch.path,
    replacements: replacements.length,
    fileWatchEventCount: fsEvents.filter((ev) => ev.watchId === "phase-a-file").length,
    dirWatchEventCount: fsEvents.filter((ev) => ev.watchId === "phase-a-dir").length,
    fileWatchFired: fsEvents.filter((ev) => ev.watchId === "phase-a-file").length >= replacements.length,
    dirWatchFired: fsEvents.filter((ev) => ev.watchId === "phase-a-dir").length >= replacements.length,
    events: fsEvents,
  };
}

async function startSteeredTurn(server: AppServer, threadId: string): Promise<Json> {
  const turnStartPromise = server.request("turn/start", {
    threadId,
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    effort: "low",
    input: [textInput(
      "This is a protocol smoke. Before your final answer, run `sleep 2` with the shell tool. " +
      "You may receive same-turn steering while that is happening. If no steering arrives, reply NO_STEER.",
    )],
  }, 180_000);
  const started = await server.waitFor(
    (msg) => msg.method === "turn/started" && msg.params?.threadId === threadId,
    30_000,
  );
  const turnId = started.params.turn.id;

  let steer: Json = null;
  let steerError: string | null = null;
  try {
    steer = await server.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [textInput("Now reply exactly PHASE_A_STEER_OK and nothing else.")],
    }, 10_000);
  } catch (err) {
    steerError = sanitizeError(err);
  }

  await server.waitFor(
    (msg) => msg.method === "turn/completed" &&
      msg.params?.threadId === threadId &&
      msg.params?.turn?.id === turnId,
    180_000,
  );
  const turnStart = await turnStartPromise.catch((err) => ({ error: sanitizeError(err) }));

  const output = assistantText(server, threadId, turnId);
  return {
    turnId,
    turnStart,
    steerAccepted: steer != null,
    steer,
    steerError,
    output,
    outputContainsSteerToken: output.includes("PHASE_A_STEER_OK"),
    diagnostics: diagnosticEvents(server, threadId, turnId),
  };
}

async function probeThreadResume(): Promise<Json> {
  const first = await AppServer.start();
  let threadId = "";
  let firstTurn: Json = null;
  let startResult: Json = null;
  try {
    startResult = await first.request("thread/start", {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      baseInstructions: "You are a terse protocol probe. Follow exact-token instructions.",
      ephemeral: false,
      sessionStartSource: "startup",
    }, 30_000);
    threadId = startResult.thread.id;
    firstTurn = await startSteeredTurn(first, threadId);
  } finally {
    await first.stop();
  }

  const second = await AppServer.start();
  try {
    const resumeResult = await second.request("thread/resume", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      excludeTurns: false,
    }, 30_000);

    const followStart = await second.request("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "low",
      input: [textInput(
        "What exact token did you output in your immediately previous assistant message? " +
        "Reply with only that token.",
      )],
    }, 30_000);
    const followTurnId = followStart.turn.id;
    await second.waitFor(
      (msg) => msg.method === "turn/completed" &&
        msg.params?.threadId === threadId &&
        msg.params?.turn?.id === followTurnId,
      180_000,
    );
    const followOutput = assistantText(second, threadId, followTurnId);
    const followOutputMatchesPriorOutput = Boolean(firstTurn?.output?.trim()) &&
      followOutput.trim() === firstTurn.output.trim();

    return {
      threadId,
      startPath: startResult.thread.path,
      firstTurn,
      firstServerThreadEvents: notificationMethods(first, threadId),
      resumeSucceeded: true,
      resumeTurnCount: Array.isArray(resumeResult.thread?.turns) ? resumeResult.thread.turns.length : null,
      resumeThreadPath: resumeResult.thread?.path ?? null,
      followTurnId,
      followOutput,
      followOutputMatchesPriorOutput,
      followOutputContainsPriorToken: followOutput.includes("PHASE_A_STEER_OK"),
      secondServerThreadEvents: notificationMethods(second, threadId),
    };
  } finally {
    await second.stop();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const codexVersion = child_process.spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
  const fsServer = await AppServer.start();
  let fsWatch: Json;
  try {
    fsWatch = await probeFsWatch(fsServer);
  } finally {
    await fsServer.stop();
  }

  const threadResume = await probeThreadResume();
  const result = {
    startedAt,
    completedAt: new Date().toISOString(),
    cwd: process.cwd(),
    codexVersion,
    fsWatch,
    threadResume,
    pass: {
      fileWatchAtomicReplace: fsWatch.fileWatchFired,
      directoryWatchAtomicReplace: fsWatch.dirWatchFired,
      turnSteer: threadResume.firstTurn?.steerAccepted === true &&
        threadResume.firstTurn?.outputContainsSteerToken === true,
      threadResumeAfterRestart: threadResume.resumeSucceeded === true &&
        threadResume.followOutputMatchesPriorOutput === true,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`codex-app-phase-a failed: ${sanitizeError(err)}`);
  process.exit(1);
});
