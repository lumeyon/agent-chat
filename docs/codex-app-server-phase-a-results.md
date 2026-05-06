# Codex App-Server Phase A Probe Results

Date: 2026-05-06
Command: `bun plugins/agent-chat/scripts/codex-app-phase-a.ts`
Codex CLI: `codex-cli 0.128.0`
Repository cwd: `/data/eyon/git/agent-chat`

## Summary

Phase A passed against the real local Codex app-server.

| Probe | Result | Design consequence |
| --- | --- | --- |
| `fs/watch` on a `.turn` file across two atomic `tmp` + `mv` rewrites | PASS | The app-server file watch did not show Bun's stale-inode behavior in this environment. File-path watches are viable for `.turn` sentinels. |
| `fs/watch` on the edge directory for the same rewrites | PASS | Directory watches also work, but emit temp-file paths and duplicate events. Keep basename filtering if using directory watches. |
| `turn/start` + same-turn `turn/steer` | PASS | The controller must steer from the `turn/started` notification, not after awaiting the `turn/start` RPC. |
| `thread/resume` after app-server process restart | PASS | Non-ephemeral thread history survived app-server restart and remained model-visible on a follow-up turn. |

## Important Wire Findings

`turn/start` returns a `TurnStartResponse`, but for controller timing it should
be treated as long-lived. In the successful probe, `turn/steer` worked only
after sending `turn/start`, waiting for the `turn/started` notification, and
using that `turn.id` immediately:

```text
turn/start request sent
turn/started notification received
turn/steer request accepted with expectedTurnId
assistant output: PHASE_A_STEER_OK
turn/completed notification received
```

Awaiting `turn/start` before steering is the wrong control flow. An earlier
probe attempt did that and received `no active turn to steer`.

Also, `effort: "minimal"` is not safe with the default app-server tool set in
this installation. The server returned:

```text
The following tools cannot be used with reasoning.effort 'minimal': image_gen, web_search.
```

The passing probe used `effort: "low"`.

## Filesystem Probe

The script watched both the target file and its containing directory, then
performed two consecutive atomic rewrites:

```text
write CONVO.md.turn.tmp.<pid>.0 -> rename over CONVO.md.turn
write CONVO.md.turn.tmp.<pid>.1 -> rename over CONVO.md.turn
```

Observed result:

```json
{
  "replacements": 2,
  "fileWatchEventCount": 2,
  "dirWatchEventCount": 4,
  "fileWatchFired": true,
  "dirWatchFired": true
}
```

The file watch emitted only the canonical `.turn` path. The directory watch
emitted the `.turn` path plus temp-file paths, sometimes with duplicate-looking
events. The controller should dedupe and re-read `.turn` after a short delay if
it uses directory watching.

## Live Turn Probe

The probe started a non-ephemeral app-server thread, sent a turn, then steered
the active turn after `turn/started`:

```json
{
  "steerAccepted": true,
  "output": "PHASE_A_STEER_OK",
  "itemCompletedTypes": [
    "userMessage",
    "userMessage",
    "commandExecution",
    "agentMessage"
  ]
}
```

The useful assistant-output reconstruction surfaces are:

- `item/agentMessage/delta` for streaming text,
- `item/completed` with `item.type == "agentMessage"` for final text,
- `turn/completed` for terminal status.

## Restart Resume Probe

The probe stopped the first app-server process, started a fresh app-server
process, resumed the saved thread id, and asked what token the previous
assistant message emitted.

Observed result:

```json
{
  "resumeSucceeded": true,
  "resumeTurnCount": 1,
  "followOutput": "PHASE_A_STEER_OK",
  "followOutputMatchesPriorOutput": true
}
```

This proves restart continuity for persisted, non-ephemeral app-server threads
on this installation. The thread was persisted at:

```text
/home/eyon/.codex/sessions/2026/05/05/rollout-2026-05-05T22-48-54-019dfb67-2599-7903-886a-c8eb437f2b24.jsonl
```

## Next Implementation Shape

The app-server controller should:

1. Start or connect to a persistent app-server.
2. Start or resume one non-ephemeral thread per graph agent identity.
3. Watch `.turn` paths with app-server `fs/watch`.
4. On pending work, call `agent-chat run <peer>` with `AGENT_CHAT_RUNTIME=codex-app`.
5. Have `scripts/runtimes/codex-app.ts dispatch()` submit prompts to the controller.
6. The controller sends `turn/start`, waits for `turn/started`, optionally accepts later steering via `turn/steer`, reconstructs assistant text from `item/agentMessage/delta` or final `item/completed`, and returns text to `cmdRun`.
7. `cmdRun` remains the only normal graph writer and directive parser.
