// sidecar-client.ts — tiny client library for the agent-chat sidecar.
//
// Every script that wants the fast path (whoami, peek, etc.) imports this and
// calls `sidecarRequest(agent, method, params)`. If the local sidecar isn't
// running or the call fails, the function returns a typed error response —
// callers fall back to the file-direct slow path (the existing protocol).
//
// Wire format: line-delimited JSON over Unix domain socket. One request per
// line, one response per line. Connection close after each request is fine —
// we open + send + read-one-line + close. Cross-runtime: anything with a UDS
// client and JSON can talk to the daemon without importing this file.

import * as fs from "node:fs";
import * as net from "node:net";
import { socketPathFor } from "./lib.ts";

export type SidecarOk<T = any> = { ok: true; result: T };
export type SidecarErr = { ok: false; error: { code: string; message: string } };
export type SidecarResponse<T = any> = SidecarOk<T> | SidecarErr;

const DEFAULT_TIMEOUT_MS = 1500;

// Async presence probe — used by callers to decide whether to take the fast
// path. Returns true if a live process is listening on the agent's socket.
// The socket file alone is not authoritative (could be stale after kill -9);
// we connect-then-disconnect to confirm.
export async function isSidecarRunning(agent: string, timeoutMs = 200): Promise<boolean> {
  const p = socketPathFor(agent);
  if (!fs.existsSync(p)) return false;
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(alive);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("error", () => finish(false));
    sock.once("connect", () => finish(true));
    try { sock.connect(p); } catch { finish(false); }
  });
}

// The RPC entry point. Returns a typed response shape so callers don't have
// to try/catch — the error path is data, not an exception.
export function sidecarRequest<T = any>(
  agent: string,
  method: string,
  params: any = {},
  opts: { timeoutMs?: number } = {},
): Promise<SidecarResponse<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketPath = socketPathFor(agent);

  return new Promise<SidecarResponse<T>>((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve({ ok: false, error: { code: "E_NO_SIDECAR", message: `no sidecar socket at ${socketPath}` } });
      return;
    }
    const sock = new net.Socket();
    let buf = "";
    let settled = false;
    const finish = (r: SidecarResponse<T>) => {
      if (settled) return;
      settled = true;
      try { sock.end(); } catch {}
      try { sock.destroy(); } catch {}
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({
      ok: false, error: { code: "E_TIMEOUT", message: `sidecar request timed out after ${timeoutMs}ms` },
    }));
    sock.on("error", (err) => finish({
      ok: false,
      error: {
        code: (err as any).code === "ECONNREFUSED" ? "E_NO_SIDECAR" : "E_CONNECT",
        message: (err as Error).message,
      },
    }));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const parsed = JSON.parse(line);
        finish(parsed as SidecarResponse<T>);
      } catch (err) {
        finish({
          ok: false,
          error: { code: "E_BAD_RESPONSE", message: `unparseable response: ${(err as Error).message}` },
        });
      }
    });
    sock.on("close", () => finish({
      ok: false,
      error: { code: "E_CLOSED", message: "socket closed before response" },
    }));
    sock.connect(socketPath, () => {
      const id = Math.floor(Math.random() * 1e12);
      const req = JSON.stringify({ id, method, params }) + "\n";
      sock.write(req);
    });
  });
}
