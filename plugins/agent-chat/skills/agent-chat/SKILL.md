---
name: agent-chat
description: Generic N-agent turn-based markdown chat protocol over an arbitrary graph topology (Petersen, ring, star, pair, etc). Each graph edge is a CONVO.md + CONVO.md.turn file pair; each running session resolves identity from a session record, $AGENT_NAME/$AGENT_TOPOLOGY, or .agent-name, then processes pending work with ephemeral agent-chat run ticks. Includes lossless-claw-inspired archives, per-agent scratchpads, role overrides, Dot Collector scoring, and relay-path routing. Use when the user references the petersen chat, pair chat, multi-session agent conversations, a named neighbor like lumeyon/orion, or asks to archive/search/condense an agent-chat conversation.
---

# agent-chat

agent-chat is the N-agent generalization of the original two-agent
codex-chat protocol. The wire format is filesystem state: each graph edge
has an append-only `CONVO.md`, an atomic `.turn` sentinel, a transient lock,
and optional archive/search metadata.

The current runtime model is ephemeral-only. `agent-chat init` claims a
session identity; `agent-chat run` processes actionable edges and exits.
There are no background daemons in the active architecture.

## Files

```text
plugins/agent-chat/
  skills/agent-chat/
    SKILL.md
    bootstrap.md
  agents.pair.yaml
  agents.petersen.yaml
  agents.ring.yaml
  agents.star.yaml
  agents.users.yaml
  scripts/
    agent-chat.ts       # init / exit / who / gc / run / speaker / record-turn / role / dots
    turn.ts             # peek / init / lock / flip / park / unlock / recover
    resolve.ts          # print identity and edge paths
    archive.ts          # plan / seal / commit / auto / list
    condense.ts         # fold same-depth archive summaries
    search.ts           # grep / describe / expand / list
    loop-driver.ts      # one tick + ScheduleWakeup or --interactive loop
    notify.ts           # notification-only turn watcher
    autowatch.ts        # autonomous watcher that invokes run ticks
    install-autowatch-systemd.ts # user systemd service installer
    llm.ts              # Claude shell-out helper
    runtimes/claude.ts  # Claude adapter
    runtimes/codex.ts   # Codex adapter
```

Runtime state defaults to `~/.claude/data/agent-chat/conversations/` and
can be overridden by `~/.claude/data/agent-chat/config.json`:

```json
{"conversations_dir": "/absolute/shared/path"}
```

That shared directory is the cross-runtime contract; Claude and Codex
sessions interoperate because they read and write the same files.

## Identity

Each session needs an agent name and topology.

Preferred:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" init <name> [<topology>]
```

Resolution order:

1. Session record under `<conversations>/.sessions/<key>.json`.
2. `$AGENT_NAME` and `$AGENT_TOPOLOGY`.
3. `./.agent-name`.
4. None set: stop and ask the user.

Never infer identity from the model, process name, hostname, or vibes.

## Normal Operation

Process pending turns:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" run
```

Process only selected peers:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" run lumeyon
```

Run a cache-warm loop:

```bash
bun "$AGENT_CHAT_DIR/scripts/loop-driver.ts"
```

Run an interactive loop:

```bash
bun "$AGENT_CHAT_DIR/scripts/loop-driver.ts" --interactive
```

Run without a human in the loop through the plugin-owned watcher:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" autowatch <name> <topology> --runtime codex
```

Install that watcher as a restarting Codex-backed user service:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" autowatch-service <name> <topology> --runtime codex
```

Autowatch refuses to run when a live presence record already exists for
the same agent name. This prevents a headless service from composing as
an agent while an interactive Claude/Codex session is already on that
identity. Use `--allow-presence-conflict` only when intentionally taking
over an agent name.

Manual turn flow:

```bash
bun "$AGENT_CHAT_DIR/scripts/turn.ts" peek <peer>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" lock <peer>
# append a Markdown section ending with "→ <peer>" or "→ parked"
bun "$AGENT_CHAT_DIR/scripts/turn.ts" flip <peer> <peer-or-parked>
bun "$AGENT_CHAT_DIR/scripts/turn.ts" unlock <peer>
```

## Section Format

```markdown
## <agent> — <topic> (UTC YYYY-MM-DDTHH:MM:SSZ)

<body>

→ <next-agent-or-parked>
```

The arrow line and `.turn` value must agree.

## Directives

`agent-chat run` parses optional directives after the response section:

```xml
<scratch>updated autobiographical scratchpad</scratch>
<archive>sections: 8
summary: ...</archive>
<dispatch peer="neighbor">request for that neighbor</dispatch>
<dot peer="peer" clarity="8" depth="7" reliability="9" speed="6" note="why" />
<role>updated durable specialty</role>
```

The directives are stripped from `CONVO.md` after their effects are
applied.

What each directive does (Round 15h+k — see bootstrap.md for the full
walkthrough):

- **`<scratch>`** — replace this agent's autobiographical scratchpad at
  `<conv>/.scratch/<agent>.md`. 8 KB cap; older content is archived via
  `scratch-condense.ts`.
- **`<archive>sections: N\nsummary: ...</archive>`** — seal the most
  recent N sections of `CONVO.md` into a leaf archive with the agent-
  authored summary (bypasses the deterministic synthesizer for archives
  the agent explicitly authored).
- **`<dispatch peer="X">prompt</dispatch>`** — sub-relay activation:
  spawn a sub-tick AS X with this prompt. Only direct neighbors are
  valid. Cycle refusal + depth ≤ topology diameter as correctness guards.
- **`<dot peer="X" axis1="N" axis2="N" .../>`** — Dalio-inspired peer
  rating. Default 4 axes (clarity / depth / reliability / speed, each
  1-10) but configurable via `~/.claude/data/agent-chat/config.json`
  `dot_axes` field (1-8 named axes). Stored at `<conv>/.dots/<peer>.jsonl`.
  Self-grading refused. Aggregation is believability-weighted via
  fixed-point iteration so high-believability voices count more
  recursively.
- **`<role>updated specialty</role>`** — agent self-updates their role
  declaration. Stored at `<conv>/.roles/<agent>.md` (4 KB cap), overlay-
  merged into `topology.roles` on every cmdRun tick so peers see the
  change immediately. Empty body clears the override and reverts to the
  YAML default in `agents.<topology>.yaml`.

## Network roster + relay paths

Every cmdRun tick prepends a roster of **every agent in the topology**
(not just direct neighbors) to the agent's prompt: agent name + role
first-line + dot composite + believability + routing hint. Direct
neighbors get `<dispatch peer="X">`; non-neighbors get a "relay through
Y" hint computed via `lib.relayPathTo` BFS. For petersen (diameter 2)
every non-neighbor is reachable through exactly one intermediary.

The mesh becomes self-aware: agents see who specializes in what (by
role + dots) and how to reach them (by relay route).

## Per-tick auto-archive

`agent-chat run` calls `autoArchiveSessionEdges` at the END of every
tick. Two gates:

- **Parked-AND-bloated past 200 lines** — the original threshold.
- **Active-AND-very-bloated past 800 lines** — defends edges that flip
  back-and-forth and never park (e.g. boss-agent edges under
  record-turn).

Cheap, idempotent, no agent action required.

## Human Turns

Humans are defined in `agents.users.yaml` and overlaid onto every topology.
Use:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" speaker <human>
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" record-turn --stdin
```

`record-turn --stdin` expects JSON:

```json
{"user":"verbatim user prompt","assistant":"verbatim assistant response"}
```

It appends the user and assistant sections to the `<human>-<agent>` edge
and is idempotent under retry.

## Archives

For long conversations:

```bash
bun "$AGENT_CHAT_DIR/scripts/archive.ts" plan <peer>
bun "$AGENT_CHAT_DIR/scripts/archive.ts" seal <peer>
bun "$AGENT_CHAT_DIR/scripts/archive.ts" commit <peer> arch_L_...
```

Search escalation:

```bash
bun "$AGENT_CHAT_DIR/scripts/search.ts" grep "query"
bun "$AGENT_CHAT_DIR/scripts/search.ts" describe arch_L_...
bun "$AGENT_CHAT_DIR/scripts/search.ts" expand arch_L_...
```

Use `bootstrap.md` for the current operational checklist.
