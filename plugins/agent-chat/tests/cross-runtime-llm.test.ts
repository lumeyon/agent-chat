// Live Claude+Codex cross-runtime smoke, gated.
//
// Default CI skips this test. Enable with:
//   RUN_CROSS_RUNTIME_TEST=1 bun test plugins/agent-chat/tests/cross-runtime-llm.test.ts
//
// Requires both `claude` and `codex` CLIs on PATH. The script itself skips
// with exit 0 when not explicitly enabled or when either CLI is unavailable.

import { test, expect, describe } from "bun:test";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL_ROOT } from "./helpers.ts";

const RUN = process.env.RUN_CROSS_RUNTIME_TEST === "1";
const describeIf = RUN ? describe : describe.skip;

describeIf("live cross-runtime agent-chat run (Claude + Codex)", () => {
  test("orion via Codex and lumeyon via Claude exchange turns on one edge", () => {
    const script = path.join(SKILL_ROOT, "scripts", "cross-runtime-integration-test.ts");
    const r = spawnSync(process.execPath, [script], {
      cwd: SKILL_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: 600_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `cross-runtime integration exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    expect(r.status).toBe(0);
  }, 620_000);
});

if (!RUN) {
  test("live cross-runtime test skipped - set RUN_CROSS_RUNTIME_TEST=1", () => {
    expect(true).toBe(true);
  });
}
