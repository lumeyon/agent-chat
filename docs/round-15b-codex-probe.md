# Round 15b — Codex empirical-probe followups

**Status:** queued. Round-15b shipped the dual-manifest skeleton + runtime-adapter scaffolds. Full Codex behavior is gated on the empirical work listed below.

## Open questions

The Codex side of the plugin pivot can't be finished by reading docs alone — `developers.openai.com/codex/plugins` and `.../build` are silent on multiple primitives that agent-chat depends on. The questions below need a live `codex` binary to answer.

### 1. Is `codex exec <prompt>` the real non-interactive entrypoint?

Round-13 + Round-14 work assumed `codex exec` based on the documented manifest format being parallel to Claude Code's. Verify by running:

```bash
codex --help
codex exec --help     # OR: codex run --help
```

Find the equivalent of `claude -p <prompt>` — single-shot, exits when done, reads from stdin if prompt is omitted. Update `scripts/runtimes/codex.ts:dispatch` once the real entrypoint is known.

### 2. Does Codex inherit `CLAUDE_SESSION_ID` (or its equivalent)?

Round-15c Contract A relies on the parent dispatcher pre-writing a synthetic SessionRecord under a known key, then exporting `CLAUDE_SESSION_ID=<key>` so the spawned `claude -p` child resolves identity correctly. The Codex equivalent is unknown:

- Does Codex respect `CLAUDE_SESSION_ID`? (Unlikely — different vendor.)
- Does Codex have its own session-id env var? (`CODEX_SESSION_ID`?)
- Does Codex pass through arbitrary env vars to spawned subprocesses without filtering them?

Probe by:

```bash
# Run codex with a custom env var; observe whether it's visible in
# subprocess context (e.g. via Bash tool reflecting back).
CODEX_SESSION_ID=test123 codex exec "echo $CODEX_SESSION_ID"
```

If Codex doesn't honor an inherited session-key var, the adapter has to invent its own propagation channel (a temp file the dispatcher writes + the child reads at startup).

### 3. Codex hook event taxonomy

The docs say `hooks/hooks.json` is supported but don't enumerate event names. Round 14 keystone's slice 3 + rhino's sub-relay catalog produced a 3-column table (Ruflo event → Claude Code documented → file:line receipt) but the Codex column was undocumented.

Empirical protocol (rhino's design, queued at Round 14):

1. Write a `hooks/hooks.json` registering hooks for every plausible event name:

   ```json
   {
     "events": {
       "PreToolUse": [{ "type": "command", "command": "echo PreToolUse $TOOL_NAME >> /tmp/codex-hook-trace.log" }],
       "PostToolUse": [{ "type": "command", "command": "echo PostToolUse $TOOL_NAME >> /tmp/codex-hook-trace.log" }],
       "PreCommand": [{ "type": "command", "command": "echo PreCommand >> /tmp/codex-hook-trace.log" }],
       "PostCommand": [{ "type": "command", "command": "echo PostCommand >> /tmp/codex-hook-trace.log" }],
       "PreEdit": [{ "type": "command", "command": "echo PreEdit >> /tmp/codex-hook-trace.log" }],
       "PostEdit": [{ "type": "command", "command": "echo PostEdit >> /tmp/codex-hook-trace.log" }],
       "PreSubmit": [{ "type": "command", "command": "echo PreSubmit >> /tmp/codex-hook-trace.log" }],
       "PreSession": [{ "type": "command", "command": "echo PreSession >> /tmp/codex-hook-trace.log" }],
       "PostSession": [{ "type": "command", "command": "echo PostSession >> /tmp/codex-hook-trace.log" }],
       "PrePrompt": [{ "type": "command", "command": "echo PrePrompt >> /tmp/codex-hook-trace.log" }],
       "PostPrompt": [{ "type": "command", "command": "echo PostPrompt >> /tmp/codex-hook-trace.log" }],
       "Stop": [{ "type": "command", "command": "echo Stop >> /tmp/codex-hook-trace.log" }],
       "UserPromptSubmit": [{ "type": "command", "command": "echo UserPromptSubmit >> /tmp/codex-hook-trace.log" }],
       "SessionStart": [{ "type": "command", "command": "echo SessionStart >> /tmp/codex-hook-trace.log" }],
       "PermissionRequest": [{ "type": "command", "command": "echo PermissionRequest >> /tmp/codex-hook-trace.log" }]
     }
   }
   ```

2. Install the hooks against the codex plugin loader (`codex plugin install ./test-plugin` or similar).

3. Run a representative codex session that exercises tool calls, file edits, prompt submission, and session end:

   ```bash
   codex exec "list files in /tmp, then create /tmp/test.txt with content 'hello', then exit"
   ```

4. Read `/tmp/codex-hook-trace.log`. The events that fire ARE the real Codex surface. Document in this file.

### 4. Wakeup mechanism choice

Codex docs document NO `ScheduleWakeup` / `CronCreate` analog. Three viable paths:

- **(a) External cron** — runtime-agnostic; most invasive setup. User adds `crontab -e` entries that fire `codex exec` periodically. agent-chat ships a `cron-template.txt` for users to copy.
- **(b) MCP push notification** — if Codex exposes a notification mechanism. Probe the docs / API surface.
- **(c) Long-living Claude session orchestrator** — couples cross-runtime work to a Claude process being alive somewhere. The Claude orchestrator dispatches Codex children via `codex exec`. Probably the right pragma for v1 since Claude already has ScheduleWakeup.

Decide once questions 1-3 are answered.

## Updates after probe

When this work happens, append findings to this doc and:

- Update `scripts/runtimes/codex.ts` to remove the throws + wire the real primitives.
- Update `.codex-plugin/plugin.json` if hook event names need explicit declaration.
- Add `tests/runtimes-codex.test.ts` exercising the dispatch + wakeup paths.
- Update `README.md` Hybrid mode section to drop the "Codex side gated on empirical work" caveat.

## Round-15b commit boundary

The Round-15b commit (this skeleton) ships:

- `.claude-plugin/plugin.json` — Claude-side manifest, fully populated.
- `.codex-plugin/plugin.json` — Codex-side manifest, fully populated, with a description that flags the hook taxonomy probe as outstanding.
- `marketplace.json` — single-plugin marketplace shape so install URL pattern matches Ruflo's (`claude code plugin marketplace add lumeyon/agent-chat`).
- `scripts/runtimes/claude.ts` — full implementation (wraps existing primitives).
- `scripts/runtimes/codex.ts` — skeleton with throws-on-call.
- `docs/round-15b-codex-probe.md` — this file.

The full Codex behavioral implementation is a separate future commit gated on the probe.
