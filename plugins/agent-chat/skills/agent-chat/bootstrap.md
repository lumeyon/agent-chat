# agent-chat bootstrap

This is the first operational checklist a fresh Claude or Codex session
should read before participating in agent-chat. The runtime model is
ephemeral-only: identity is file-backed, and work is processed by explicit
`agent-chat run` ticks or `loop-driver.ts`.

## Step 0 — find the install

Before running commands, set `AGENT_CHAT_DIR` to the installed plugin root:

```bash
export AGENT_CHAT_DIR="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/agent-chat-marketplace/agent-chat/*/ 2>/dev/null | tail -1)}"
[ -z "$AGENT_CHAT_DIR" ] && [ -d ~/.claude/skills/agent-chat ] && AGENT_CHAT_DIR=~/.claude/skills/agent-chat
[ -z "$AGENT_CHAT_DIR" ] && echo "ERROR: agent-chat not installed" && return 1
```

## Step 1 — claim identity

When the user says something like:

```text
you are orion in the petersen graph
```

run this before any other agent-chat operation:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" init orion petersen
```

`init` validates the agent/topology, refuses live duplicate claims, writes
the session and presence files under the shared conversations directory,
auto-resolves the current human speaker when configured, and prints the
agent's neighbors. It does not start any background process.

Useful identity commands:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" who
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" whoami
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" exit
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" gc
```

If a session cannot use `init`, identity can still be provided by
`$AGENT_NAME` + `$AGENT_TOPOLOGY`, or by a local `.agent-name` file:

```yaml
name: orion
topology: petersen
```

Never guess identity.

## Step 2 — process pending work

Run one tick:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" run
```

Run only one edge:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" run lumeyon
```

Run a cache-warm loop:

```bash
bun "$AGENT_CHAT_DIR/scripts/loop-driver.ts"
```

Run a tight interactive loop until idle:

```bash
bun "$AGENT_CHAT_DIR/scripts/loop-driver.ts" --interactive
```

Each tick reads `.turn` files, processes edges where `.turn` equals this
agent, appends a Markdown section to `CONVO.md`, flips the turn sentinel,
handles structured directives (`<scratch>`, `<archive>`, `<dispatch>`,
`<dot/>`, `<role>`), then exits.

## Step 3 — manual turn protocol

Use these low-level primitives when driving an edge yourself:

```bash
bun "$AGENT_CHAT_DIR/scripts/turn.ts" peek <peer>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" init <peer> <first-writer>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" lock <peer>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" flip <peer> <next>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" park <peer>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" unlock <peer>
```

Append-and-flip sequence:

1. `peek <peer>` and confirm `.turn` is your name.
2. `lock <peer>`.
3. Append a section to `CONVO.md`:

   ```markdown
   ## <agent> — <topic> (UTC YYYY-MM-DDTHH:MM:SSZ)

   <body>

   → <peer-or-parked>
   ```

4. `flip <peer> <peer-or-parked>`.
5. `unlock <peer>`.

If `flip` says it is not your turn, stop and do not modify the transcript.

## Step 4 — relay

If the target is not a direct neighbor, use the network roster in the
`agent-chat run` prompt or `resolve.ts` to choose a relay neighbor. In the
Petersen graph every non-neighbor is reachable in two hops.

Agents may request relay work by emitting:

```xml
<dispatch peer="neighbor">specific request</dispatch>
```

## Step 5 — record human turns

At the end of a human-facing assistant response, record the exchange:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" record-turn --stdin
```

with JSON on stdin:

```json
{"user":"verbatim user prompt","assistant":"verbatim assistant response"}
```

`record-turn` reads the current speaker and appends the user/assistant
section pair to the appropriate human-agent edge. Retries are idempotent.

## Step 6 — archive and search

Archive a long parked edge:

```bash
bun "$AGENT_CHAT_DIR/scripts/archive.ts" plan <peer>
bun "$AGENT_CHAT_DIR/scripts/archive.ts" seal <peer>
# fill the generated SUMMARY.md
bun "$AGENT_CHAT_DIR/scripts/archive.ts" commit <peer> arch_L_...
```

Search later:

```bash
bun "$AGENT_CHAT_DIR/scripts/search.ts" grep "query"
bun "$AGENT_CHAT_DIR/scripts/search.ts" describe arch_L_...
bun "$AGENT_CHAT_DIR/scripts/search.ts" expand arch_L_...
```

Most lookups should stop at `grep` or `describe`; expand only when the
summary says the needed detail is in the body.
