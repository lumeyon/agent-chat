// codex-install-hooks.test.ts — user-global Codex Stop hook installer.

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_CONVERSATIONS_DIR, SKILL_ROOT } from "../scripts/lib.ts";

const AGENT_CHAT = path.join(SKILL_ROOT, "scripts", "agent-chat.ts");

function runInstall(home: string, args: string[] = []) {
  const env: Record<string, string> = { ...(process.env as any), HOME: home };
  delete env.AGENT_CHAT_CONVERSATIONS_DIR;
  const r = spawnSync("bun", [AGENT_CHAT, "install-codex-hooks", ...args], {
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`install-codex-hooks exited ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  }
  return r;
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function agentHookCount(hooksJson: any): number {
  return (hooksJson.hooks?.Stop ?? []).filter((entry: any) =>
    (entry.hooks ?? []).some((h: any) => typeof h.command === "string" && h.command.includes("codex-stop-hook.ts"))
  ).length;
}

describe("install-codex-hooks", () => {
  test("writes ~/.codex/config.toml and ~/.codex/hooks.json against the global conversation root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-install-"));
    try {
      const codexDir = path.join(tmp, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, "config.toml"), [
        'model = "gpt-5.5"',
        "",
        "[features]",
        "plugin_hooks = false",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "printf existing" }] }],
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "printf other" }] }],
        },
      }, null, 2));

      runInstall(tmp);

      const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
      expect(config).toContain("codex_hooks = true");
      expect(config).toContain("plugin_hooks = false");
      expect(config).toContain('[plugins."agent-chat@agent-chat-marketplace"]');
      expect(config).toContain("enabled = true");

      const hooks = readJson(path.join(codexDir, "hooks.json"));
      expect(hooks.hooks.PostToolUse).toHaveLength(1);
      expect(hooks.hooks.Stop).toHaveLength(2);
      expect(agentHookCount(hooks)).toBe(1);
      const agentHook = hooks.hooks.Stop.find((entry: any) =>
        (entry.hooks ?? []).some((h: any) => String(h.command).includes("codex-stop-hook.ts"))
      ).hooks[0];
      expect(agentHook.command).toContain(`AGENT_CHAT_CONVERSATIONS_DIR='${DEFAULT_CONVERSATIONS_DIR}'`);
      expect(agentHook.command).toContain(path.join(SKILL_ROOT, "scripts", "codex-stop-hook.ts"));
      expect(agentHook.timeout).toBe(180);
      expect(agentHook.statusMessage).toBe("Recording agent-chat turn");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("is idempotent and uninstall removes only the agent-chat hook", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-install-idem-"));
    try {
      runInstall(tmp);
      runInstall(tmp);
      const config = fs.readFileSync(path.join(tmp, ".codex", "config.toml"), "utf8");
      expect(config.match(/\[plugins\."agent-chat@agent-chat-marketplace"\]/g)?.length).toBe(1);
      const hooksPath = path.join(tmp, ".codex", "hooks.json");
      let hooks = readJson(hooksPath);
      expect(agentHookCount(hooks)).toBe(1);

      runInstall(tmp, ["--uninstall"]);
      hooks = readJson(hooksPath);
      expect(agentHookCount(hooks)).toBe(0);
      expect(hooks.hooks?.Stop).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
