#!/usr/bin/env bun
// Install a user-level systemd service that runs the plugin-owned autowatch
// loop for one agent identity.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as child_process from "node:child_process";
import {
  CONVERSATIONS_DIR,
  SKILL_ROOT,
  edgesOf,
  isValidAgentName,
  loadTopology,
  type RuntimeName,
} from "./lib.ts";

type Args = {
  agent: string;
  topology: string;
  peers: string[];
  runtime: RuntimeName;
  intervalSec: number;
  retrySec: number;
  unitName: string;
  allowPresenceConflict: boolean;
  dryRun: boolean;
  noStart: boolean;
};

function usage(): string {
  return [
    "usage: install-autowatch-systemd.ts <agent> <topology> [--peer <peer>]",
    "                                      [--runtime claude|codex]",
    "                                      [--interval-sec N] [--retry-sec N]",
    "                                      [--unit <name.service>] [--allow-presence-conflict]",
    "                                      [--dry-run] [--no-start]",
  ].join("\n");
}

function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) die(`${label} must be a positive integer`);
  return n;
}

function parseRuntime(raw: string | undefined): RuntimeName {
  if (!raw) return "codex";
  if (raw === "claude" || raw === "codex") return raw;
  die(`unknown runtime "${raw}" — expected claude or codex`, 64);
}

function sanitizeUnitPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_.@-]/g, "_");
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const peers: string[] = [];
  let runtime: RuntimeName = "codex";
  let intervalSec = 2;
  let retrySec = 30;
  let dryRun = false;
  let noStart = false;
  let allowPresenceConflict = false;
  let unitName = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (a === "--peer") {
      const p = argv[++i];
      if (!p) die("--peer requires a value", 64);
      peers.push(p);
    } else if (a.startsWith("--peer=")) {
      peers.push(a.slice("--peer=".length));
    } else if (a === "--runtime") {
      runtime = parseRuntime(argv[++i]);
    } else if (a.startsWith("--runtime=")) {
      runtime = parseRuntime(a.slice("--runtime=".length));
    } else if (a === "--interval-sec") {
      intervalSec = parsePositiveInt(argv[++i], "--interval-sec");
    } else if (a.startsWith("--interval-sec=")) {
      intervalSec = parsePositiveInt(a.slice("--interval-sec=".length), "--interval-sec");
    } else if (a === "--retry-sec") {
      retrySec = parsePositiveInt(argv[++i], "--retry-sec");
    } else if (a.startsWith("--retry-sec=")) {
      retrySec = parsePositiveInt(a.slice("--retry-sec=".length), "--retry-sec");
    } else if (a === "--unit") {
      unitName = argv[++i] ?? "";
      if (!unitName) die("--unit requires a value", 64);
    } else if (a.startsWith("--unit=")) {
      unitName = a.slice("--unit=".length);
    } else if (a === "--allow-presence-conflict") {
      allowPresenceConflict = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-start") {
      noStart = true;
    } else if (a.startsWith("--")) {
      die(`unknown option ${a}\n${usage()}`, 64);
    } else {
      positional.push(a);
    }
  }

  const [agent, topology] = positional;
  if (!agent || !topology) die(usage(), 64);
  if (!isValidAgentName(agent)) die(`invalid agent name "${agent}"`, 64);
  for (const p of peers) {
    if (!isValidAgentName(p)) die(`invalid peer name "${p}"`, 64);
  }
  if (!unitName) {
    unitName = `agent-chat-${sanitizeUnitPart(agent)}-${sanitizeUnitPart(topology)}-autowatch.service`;
  }
  if (!unitName.endsWith(".service")) unitName += ".service";
  return {
    agent,
    topology,
    peers: [...new Set(peers)],
    runtime,
    intervalSec,
    retrySec,
    unitName,
    allowPresenceConflict,
    dryRun,
    noStart,
  };
}

function validate(args: Args): void {
  const topo = loadTopology(args.topology);
  if (!topo.agents.includes(args.agent)) {
    die(`agent "${args.agent}" is not declared in topology "${args.topology}"`, 64);
  }
  const neighborSet = new Set(edgesOf(topo, args.agent).map((e) => e.peer));
  const missing = args.peers.filter((p) => !neighborSet.has(p));
  if (missing.length > 0) {
    die(`peer(s) not adjacent to ${args.agent}@${args.topology}: ${missing.join(", ")}`, 64);
  }
}

function quoteUnitArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function envLine(key: string, value: string): string {
  return `Environment="${key}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildUnit(args: Args): string {
  const agentChat = path.join(SKILL_ROOT, "scripts/agent-chat.ts");
  const execArgs = [
    process.execPath,
    agentChat,
    "autowatch",
    args.agent,
    args.topology,
    "--runtime",
    args.runtime,
    "--interval-sec",
    String(args.intervalSec),
    "--retry-sec",
    String(args.retrySec),
  ];
  for (const peer of args.peers) execArgs.push("--peer", peer);
  if (args.allowPresenceConflict) execArgs.push("--allow-presence-conflict");

  const pathValue = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return [
    "# Generated by agent-chat autowatch-service. Edit the plugin command instead of hand-rolling loops.",
    "[Unit]",
    `Description=agent-chat autowatch for ${args.agent}@${args.topology}`,
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${quoteUnitArg(SKILL_ROOT)}`,
    envLine("AGENT_CHAT_CONVERSATIONS_DIR", CONVERSATIONS_DIR),
    envLine("AGENT_CHAT_RUNTIME", args.runtime),
    envLine("AGENT_NAME", args.agent),
    envLine("AGENT_TOPOLOGY", args.topology),
    envLine("PATH", pathValue),
    `ExecStart=${execArgs.map(quoteUnitArg).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function runSystemctl(args: string[]): void {
  const r = child_process.spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) die(`systemctl --user ${args.join(" ")} failed: ${r.error.message}`, 75);
  if (r.status !== 0) {
    die(
      `systemctl --user ${args.join(" ")} exited ${r.status}\n` +
      `${r.stderr || r.stdout}`,
      75,
    );
  }
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  validate(args);
  const unitDir = path.join(os.homedir(), ".config/systemd/user");
  const unitPath = path.join(unitDir, args.unitName);
  const unit = buildUnit(args);

  if (args.dryRun) {
    console.log(`unit_path=${unitPath}`);
    console.log(unit);
    return;
  }

  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unitPath, unit, { mode: 0o644 });
  runSystemctl(["daemon-reload"]);
  if (!args.noStart) runSystemctl(["enable", "--now", args.unitName]);
  console.log(`[agent-chat autowatch-service] installed ${unitPath}`);
  if (!args.noStart) {
    console.log(`[agent-chat autowatch-service] enabled and started ${args.unitName}`);
    console.log(`[agent-chat autowatch-service] logs: journalctl --user -u ${args.unitName} -f`);
  }
}

if (import.meta.main) {
  main();
}
