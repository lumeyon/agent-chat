# Claude Code feature request — `PostResponse` hook

This document describes a Claude Code feature that, if shipped, would let
`agent-chat record-turn` (slice 3) run automatically at the end of every
assistant response without the agent calling the CLI itself. The current
v1 path is agent-driven (the skill prompt instructs the agent to invoke
`agent-chat record-turn` at the end of every response); the hook-driven
path below is the v2 ergonomic upgrade.

## Why the existing `Stop` hook isn't enough

Claude Code's `Stop` hook fires at session termination and delivers only
metadata (`session_id`, `transcript_path`, `cwd`, `hook_event_name`). Two
constraints make it unsuitable for per-turn recording:

1. **Session-level, not turn-level.** `Stop` doesn't fire after each
   assistant response — only when the session ends. The agent-chat
   protocol records *each turn* on its own `<speaker>-<agent>` edge with
   a lock+append+flip cycle; per-turn timing is load-bearing.
2. **No payload.** The hook receives the path to the transcript JSONL,
   not the user prompt and assistant response text. Parsing the JSONL
   on every turn would require diffing-by-line between calls, which is
   fragile (interleaved tool-use entries, different transcript formats
   per Claude Code version) and has nothing to do with what the hook
   would actually deliver if it were turn-aware.

## Proposed `PostResponse` hook

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PostResponse": [
      {
        "type": "command",
        "command": "bun /home/$USER/.claude/skills/agent-chat/scripts/agent-chat.ts record-turn --stdin"
      }
    ]
  }
}
```

### Event timing

Fires after each assistant response completes its turn — the same place
Stop fires for full session end, but per-turn instead.

### Stdin payload (line-JSON, one object)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/directory",
  "hook_event_name": "PostResponse",
  "user_prompt": "the user's most recent prompt as plain text",
  "assistant_response": "the assistant's full response as plain text"
}
```

`record-turn`'s `--stdin` mode already accepts `{user, assistant}` keys;
the hook's `user_prompt` / `assistant_response` mapping is a 5-line
adapter.

### Constraints we'd want from the hook

- **Non-blocking.** The hook should not delay the next user turn. Record
  asynchronously; the user keeps typing.
- **Best-effort retry.** If the hook crashes or returns non-zero, Claude
  Code retries on the next turn. The idempotency ledger
  (`recorded_turns.jsonl`) ensures double-write safety.
- **Timeout.** A 5-second budget is generous; agent-chat's normal
  lock+append+flip path is sub-200ms even under contention.
- **Failure surfaces, doesn't block.** If the hook command fails, Claude
  Code should log to stderr but not refuse to continue the conversation.
  The transparency invariant of agent-chat is best-effort: a missing
  ledger entry is a recoverable signal, not a fatal error.

### Why we'd benefit

- **No per-response burden on the agent.** The skill prompt no longer
  needs "remember to call record-turn at end of every response" — the
  hook handles it transparently.
- **Recovery from agent-side bugs.** If the agent forgets to invoke
  record-turn (the soft-discipline failure mode of the v1 path), the
  conversation has gaps. With a PostResponse hook, the harness drives
  recording, not the agent.
- **Cross-runtime parity.** Codex sessions, plain shell, etc. can mirror
  the same pattern via their own per-turn hooks; agent-chat's wire
  format (CONVO.md + `.turn` + ledger) stays runtime-agnostic.

## v1 fallback

Until `PostResponse` ships, the agent itself runs:

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts record-turn \
  --user "<user prompt>" \
  --assistant "<assistant response>"
```

at the end of each response. The skill prompt instructs the agent to do
this; gaps in `recorded_turns.jsonl` are observable post-hoc by any peer
agent grepping the ledger.
