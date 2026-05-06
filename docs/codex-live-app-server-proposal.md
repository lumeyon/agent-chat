# Codex Live App-Server Proposal

**Status: SUPERSEDED 2026-05-06 by Round-15p — ephemeral-spawn pattern**
Original draft: 2026-05-06 (lumeyon)
Local probe: `codex-cli 0.128.0`
Phase A probe results: `docs/codex-app-server-phase-a-results.md`
Cross-runtime integration test: `005c6a7` Phase A 16/16 PASS

> **Why superseded.** Both empirical probes documented in
> `docs/codex-app-server-phase-a-results.md` PASSED — `fs/watch` survives
> rename-replace, `thread/resume` survives app-server restart. The
> proposal is technically viable. We are NOT building it anyway.
>
> The deciding moment was Round-15p's cross-runtime integration test
> (`commit 005c6a7`, `cross-runtime-integration-test.ts`) hitting 16/16
> green: orion-via-Codex and lumeyon-via-Claude exchanged turns on a
> shared CONVO.md edge with full token round-trip, clean lock release,
> and correct turn-flip semantics — using only the existing
> ephemeral-spawn pattern (`agent-chat run` + per-agent `runtime:` in
> `agents.<topology>.yaml` + the Round-15l runtime-selection wiring).
>
> Both architectures cover the live-collaboration use case. The
> ephemeral-spawn pattern is strictly simpler:
>
> | Concern | Ephemeral-spawn (chosen) | App-server (rejected) |
> |---|---|---|
> | Long-lived processes | Zero | One per live agent (the controller) |
> | JSON-RPC client | Not needed | Required, ~scripts/codex-app/client.ts |
> | Thread-id persistence | Not needed (each spawn rebuilds context from CONVO + scratchpad + lessons + roster) | Required, in presence record |
> | Failure modes | Bounded — each spawn fails or succeeds independently | App-server crash + reconnect logic, expectedTurnId timing race |
> | Cross-runtime parity | Already shipped (Round-15l) | Would require a separate runtime adapter |
>
> The mental model shift: **"Claude driver + ephemeral codex workers"**
> (the pattern ruflo uses) replaces "two long-running interactive
> terminals." Lower coordination cost, no zombie watchers, no per-turn
> user typing in two windows, no app-server lifecycle management.
>
> What we kept from the proposal work:
> - The empirical surface mapping (`codex exec` confirmed; bypass flags
>   verified; `fs/watch` and `thread/resume` characterized)
> - The architecture pressure-test (controller-owned-thread vs
>   adapter-first decomposition) — applicable to future work
> - The `docs/codex-app-server-phase-a-results.md` probe artifact —
>   permanent reference for future revisits
>
> What we dropped:
> - The JSON-RPC client implementation
> - The `codex app-server` controller process
> - `thread/start` / `turn/steer` / `thread/inject_items` orchestration
> - A new `codex-app` runtime adapter alongside `claude` and `codex`
>
> If a future requirement demands true persistent live-thread continuity
> across many turns (e.g. an IDE attaching mid-conversation, or a
> shared-context model that can't rebuild from CONVO+scratchpad+lessons),
> revisit this proposal. The probes and pressure-test are durable
> investments; the implementation surface is small enough to land in
> 1-2 commits when needed. Until then, ephemeral-spawn is the live
> mechanism.
>
> Original proposal text preserved below for context.

---

## Problem

`agent-chat` currently has two Codex execution shapes:

1. `scripts/runtimes/codex.ts` wraps `codex exec` for bounded, headless,
   one-shot work.
2. `scripts/autowatch.ts` can watch graph `.turn` files and launch
   `agent-chat run` when an edge hands the floor to a Codex agent.

That is enough for autonomous batch service mode, but it is not equivalent
to Claude Code's Monitor-style live session behavior. A service can create
a fresh Codex invocation as `lumeyon`; it cannot inject work into the
already-open Lumeyon Codex terminal session. That distinction is what caused
the presence-conflict guard: two processes writing as the same graph identity
produce a confusing audit trail.

## Verified Codex Surfaces

The installed Codex CLI exposes these relevant surfaces:

- `codex app-server` can run over `stdio://`, `unix://`, or `ws://`.
- `codex --remote <ws://...>` can connect a TUI client to a remote app
  server.
- `codex features list` reports `codex_hooks` as stable and enabled in this
  install.
- Generated app-server bindings include `fs/watch`, `fs/changed`,
  `thread/start`, `turn/start`, `turn/steer`, and `thread/inject_items`.

The app-server README describes the key requests this proposal depends on:

- `turn/start` adds user input to a thread and begins Codex generation.
- `turn/steer` adds user input to an already in-flight regular turn.
- `thread/inject_items` appends raw Responses API items to a loaded thread's
  model-visible history without starting a user turn.

OpenAI's app-server engineering writeup frames the app server as the
long-lived JSON-RPC process that hosts Codex core threads and lets clients
submit requests and receive streaming updates. That is the missing primitive
for a live agent-chat runtime.

## Viable Options

| Option | Shape | Strength | Weakness |
| --- | --- | --- | --- |
| Continue `codex exec` | `autowatch` launches fresh non-interactive Codex turns | Already implemented; good for systemd and CI | Not a live session; no injection into the current terminal |
| Run Lumeyon in `pi-agent` | Pi hosts a Codex model and uses Pi `steer()`/`followUp()` hooks | Clean live injection primitive today | Lumeyon becomes Pi-hosted, not native Codex CLI |
| Use Codex app-server | Watch graph files and call `turn/start` / `turn/steer` / `thread/inject_items` | Native Codex live-thread control, compatible with TUI as a client | Requires a JSON-RPC client and lifecycle management |

Recommendation: keep `codex exec` as the fallback runtime, and add Codex
app-server as the native live-session runtime.

Rejected option: tmux terminal injection. It can prove that file changes can
cause visible terminal input, but it is brittle, hard to test, easy to
misdirect, and bypasses Codex's thread/turn protocol. It should not be part of
the plugin architecture.

## Proposed Runtime Shape

Run Lumeyon as an app-server-backed Codex thread, with a long-lived
agent-chat controller preserving the app-server connection:

```text
codex app-server --listen unix:///run/user/$UID/agent-chat-lumeyon.sock
        ^
        | persistent app-server JSON-RPC
agent-chat codex-app-watch lumeyon petersen
        ^                         |
        | local controller RPC     | watches graph state
scripts/runtimes/codex-app.ts     v
        ^                  /data/lumeyon/agent-chat/conversations/petersen/*/
        |
cmdRun graph append/flip path
```

Control flow:

```text
/data/lumeyon/agent-chat/conversations/petersen/*/CONVO.md.turn
        |
        v
agent-chat codex-app-watch detects pending floor
        |
        v
agent-chat run <peer> --runtime codex-app
        |
        v
cmdRun composes prompt and calls scripts/runtimes/codex-app.ts dispatch()
        |
        v
dispatch() asks codex-app-watch to run/steer the persistent Codex thread
        |
        v
cmdRun receives assistant output, parses directives, appends CONVO.md, flips
```

An optional terminal UI can attach to the same server:

```bash
codex --remote ws://127.0.0.1:8765
```

The watcher is no longer pretending to be a second Lumeyon. It is the
controller for the Lumeyon Codex thread. `cmdRun` remains the only graph writer
for normal runtime turns.

This avoids the one-shot trap: if `codex-app.ts dispatch()` directly called
`thread/start` from each `agent-chat run` process, each turn would be a cold
thread. Instead, the controller owns the long-lived app-server connection and
`threadId`; the runtime adapter connects to that controller, submits work, and
returns assistant output to `cmdRun`.

## Protocol Mapping

1. Start or discover an app-server connection and controller.
   - Local service mode can use `unix://`.
   - Remote/IDE mode can use `ws://`.
   - The controller publishes its local endpoint in presence metadata.

2. Create or resume the Lumeyon thread.
   - Use `thread/start` for a new app-server-owned thread.
   - Persist `threadId` in controller state and agent-chat presence/session
     metadata.
   - Use `thread/resume` if a stored `threadId` exists.
   - Empirically verify whether `threadId` survives app-server restart. If it
     is per-process only, restart continuity must be rebuilt from graph memory
     plus scratch/archive context, not from `thread/resume`.

3. Watch graph files.
   - Prefer app-server `fs/watch` so the same connection owns filesystem
     observation and turn injection.
   - Probe whether app-server `fs/watch` fires for atomic `tmp` + `mv`
     replacement of `.turn`. If file watches miss replacement events, watch
     the edge directory and filter by basename, matching the `notify.ts` fix.
   - Optionally watch `.lock` for self-flip suppression parity with
     `notify.ts`.

4. On `fs/changed`, classify pending graph work.
   - Read `.turn`.
   - Ignore if the floor is not this agent.
   - Ignore if a lock is present.
   - Use the same self-authored transition classification only if the watcher
     observes transitions directly. Poll-only batch autowatch does not need
     the `fs.watch` inode fix.

5. Trigger the normal graph runtime path.
   - The controller invokes `agent-chat run <peer>` with
     `AGENT_CHAT_RUNTIME=codex-app`.
   - `cmdRun` composes the same prompt it already uses for Claude and
     `codex exec`.
   - `scripts/runtimes/codex-app.ts dispatch()` connects to the controller's
     local endpoint from presence metadata.

6. Deliver work to Codex.
   - If the Lumeyon thread is idle, call `turn/start` with the same prompt
     body `cmdRun` currently sends to runtime adapters.
   - If a regular turn is active, call `turn/steer` with `expectedTurnId`.
   - If context should be visible to the model without triggering a new turn,
     call `thread/inject_items`.

7. Collect the answer.
   - Subscribe to `item/*`, `agentMessage/delta`, and `turn/completed`
     notifications.
   - Extract the terminal assistant answer.
   - Return the assistant output to `cmdRun`.
   - Let existing `cmdRun` code apply the directive parser for `<scratch>`,
     `<archive>`, `<dispatch>`, `<dot />`, and `<role>`.
   - Let existing `cmdRun` append the section to `CONVO.md`, then flip/unlock
     through the turn protocol.

## Presence Model

The app-server watcher should change the meaning of a live Codex presence
record:

```json
{
  "agent": "lumeyon",
  "topology": "petersen",
  "runtime": "codex-app-server",
  "thread_id": "thr_...",
  "server": "unix:///run/user/1000/agent-chat-lumeyon.sock",
  "controller": "unix:///run/user/1000/agent-chat-lumeyon-controller.sock",
  "pid": 12345
}
```

In this mode, the app-server thread is the live Lumeyon session. The watcher
is a controller for that session, not a second writer. Existing autowatch
presence-conflict rules should continue to reject a separate `codex exec`
or Claude process claiming the same agent while this record is live.

## Hooks Role

Codex hooks are useful but should not be the main wakeup mechanism.

Use hooks for:

- session bootstrap checks,
- presence refresh,
- logging,
- optional prompt-context injection on `UserPromptSubmit`,
- safety gates around `PreToolUse` / `PostToolUse`.

Do not use hooks as the primary graph watcher. Hooks run inside Codex lifecycle
events; they do not naturally solve the idle external-file-change problem. The
app-server JSON-RPC path does.

## Implementation Plan

1. Add a small JSON-RPC client:
   - `scripts/codex-app/client.ts`
   - initialize handshake,
   - request/response correlation,
   - notification subscription,
   - stdio / Unix socket / WebSocket transport adapter.

2. Add empirical probes:
   - app-server `fs/watch` behavior under atomic `tmp` + `mv` replacement,
   - `thread/resume` behavior after app-server restart,
   - response event sequence needed to reconstruct terminal assistant output.

3. Add the controller:
   - `scripts/codex-app/watch.ts` or equivalent command module,
   - owns app-server connection and `threadId`,
   - exposes a small local controller RPC for `dispatch()` calls,
   - invokes `agent-chat run` when graph state becomes pending.

4. Add a live runtime adapter:
   - `scripts/runtimes/codex-app.ts`
   - `dispatch({ prompt })` connects to the controller endpoint in presence,
     asks it to start or steer the persistent app-server thread, and resolves
     with the terminal assistant output.

5. Add a watcher command:
   - `agent-chat codex-app-watch <agent> <topology> [--peer <peer>]`
   - app-server `fs/watch` based,
   - presence-aware,
   - no impersonation when a different live presence exists.

6. Extend runtime selection:
   - `runtime: codex-app` in `agents.<topology>.yaml`,
   - `AGENT_CHAT_RUNTIME=codex-app` override,
   - keep `codex` mapped to the existing `codex exec` adapter.

7. Add tests:
   - hermetic JSON-RPC fixture for request framing,
   - fake app-server for `thread/start`, `turn/start`, `turn/steer`,
     `thread/inject_items`, and `turn/completed`,
   - watcher test for `.turn` -> `turn/start`,
   - active-turn test for `.turn` -> `turn/steer`,
   - presence-conflict test proving `codex` batch autowatch and `codex-app`
     live controller cannot both own the same agent.

8. Add one manual smoke:
   - start `codex app-server --listen unix://...`,
   - start `agent-chat codex-app-watch lumeyon petersen --peer orion`,
   - flip Orion -> Lumeyon,
   - verify the Lumeyon app-server thread receives the work and writes back to
     the same `CONVO.md` edge.

## Pressure-Test Decisions

1. Should the app-server controller own `cmdRun` append/flip semantics?

   Decision: no. Keep graph writes in `cmdRun` for parity with Claude and
   `codex exec`. The app-server controller owns live thread continuity; the
   runtime adapter returns assistant output.

2. Should app-server `fs/watch` replace Node `fs.watch` everywhere for Codex
   live mode?

   Decision: yes for this runtime if the atomic-replace probe passes. If it
   misses `.turn` replacement events, use app-server directory watches and
   basename filtering.

3. Should this be installed as a systemd service or launched by the Codex
   plugin?

   Decision: systemd for headless mode, explicit foreground command for
   interactive development. Do not implicit-spawn background daemons from
   plugin install.

4. Should the current `autowatch` command learn `runtime: codex-app`, or
   should this be a separate command?

   Decision: separate command first. Merge only after the live semantics are
   proven.

5. Is `threadId` durable across app-server restart?

   Phase A result: yes for non-ephemeral app-server threads on
   `codex-cli 0.128.0`. The probe restarted the app-server process, resumed
   the saved thread id, and verified the previous assistant token was still
   model-visible on the follow-up turn. If a future Codex release changes that
   behavior, the restart fallback is to recreate the thread and inject graph
   memory from scratchpad, recent edge tails, and archives.

6. What is the correct `turn/start` / `turn/steer` control flow?

   Phase A result: send `turn/start`, wait for `turn/started`, then steer with
   that active `turn.id`. Awaiting `turn/start` before steering can be too
   late and produced `no active turn to steer` in the probe.

7. Is `fs/watch` safe on `.turn` file paths?

   Phase A result: file-path watches fired for two consecutive atomic
   `tmp` + `mv` replacements. Directory watches also fired, but included temp
   paths and duplicate events, so they require basename filtering and dedupe.

## References

- OpenAI engineering: [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- OpenAI Codex repo: [codex-rs/app-server/README.md](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- Local generated protocol probe: `codex app-server generate-ts --out /tmp/agent-chat-codex-app-protocol/ts`
