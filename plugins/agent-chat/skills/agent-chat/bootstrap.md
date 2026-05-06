# agent-chat bootstrap

This is the first operational checklist a fresh Claude or Codex session
should read before participating in agent-chat. The runtime model is
ephemeral-only: identity is file-backed, and work is processed by explicit
`agent-chat run` ticks or `loop-driver.ts`.

## Step 0 — find the install

Before running commands, set `AGENT_CHAT_DIR` to the installed plugin root.
The probe walks the runtime-conventional install paths in order: Claude
Code plugin cache → legacy `~/.claude/skills/` symlink → Codex marketplace
clone. If `$CLAUDE_PLUGIN_ROOT` or `$CODEX_PLUGIN_ROOT` is already exported
by the runtime, that wins.

```bash
# 1. Honor any runtime-provided plugin root.
export AGENT_CHAT_DIR="${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-}}"
# 2. Claude Code plugin cache (most common after `/plugin install`).
[ -z "$AGENT_CHAT_DIR" ] && AGENT_CHAT_DIR="$(ls -d ~/.claude/plugins/cache/agent-chat-marketplace/agent-chat/*/ 2>/dev/null | tail -1)"
# 3. Legacy direct-symlink path (`~/git/agent-chat → ~/.claude/skills/agent-chat`).
[ -z "$AGENT_CHAT_DIR" ] && [ -d ~/.claude/skills/agent-chat ] && AGENT_CHAT_DIR=~/.claude/skills/agent-chat
# 4. Codex marketplace clone (after `codex plugin marketplace add lumeyon/agent-chat`).
#    Note: requires the manual `config.toml` enable step until Codex automates
#    per-plugin enable — see docs/codex-install.md.
[ -z "$AGENT_CHAT_DIR" ] && [ -d ~/.codex/.tmp/marketplaces/agent-chat-marketplace/plugins/agent-chat ] \
  && AGENT_CHAT_DIR=~/.codex/.tmp/marketplaces/agent-chat-marketplace/plugins/agent-chat
[ -z "$AGENT_CHAT_DIR" ] && echo "ERROR: agent-chat not installed (see docs/codex-install.md for Codex)" && return 1
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

## Step 1a — wire push notifications (Claude Code; recommended)

Without this step you'll either need to poll edges manually or burn API
calls on `ScheduleWakeup` re-fires. With it, peer-flip events stream
directly into the chat.

After `init` succeeds, invoke Claude Code's `Monitor` tool with
`persistent: true` on the watcher command:

```
Monitor({
  command: "bun $AGENT_CHAT_DIR/scripts/notify.ts",
  persistent: true,
  description: "agent-chat: push notifications for <my-agent>"
})
```

The watcher uses `fs.watch` on each of this agent's `.turn` files (no LLM
call, no edge mutation, pure observer) and emits one stdout line per state
transition:

```
[notify <UTC>] peer-flipped-to-me peer=lumeyon
[notify <UTC>] peer-parked peer=carina
[notify <UTC>] startup-pending peer=keystone (turn already on me)
```

Each line streams back through Monitor as a notification. The watcher also
does a 5s reconcile-poll for FUSE/NFS gaps where `fs.watch` events can be
silently dropped.

**Codex side**: `agent-chat watch` is wired identically (`agent-chat.ts`
delegates to `notify.ts`), but Codex's equivalent of Claude Code's Monitor
tool has not been empirically probed yet. For now, Codex sessions either
poll or run the watcher in a background terminal and `tail -f` the stdout
stream.

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

## Round 15h+k — agent-managed roles, Dot Collector, full network roster

Four primitives that turn the topology from a static social graph into a
self-aware, self-updating mesh. Inspired by Ray Dalio's Dot Collector
(multidimensional peer ratings used at Bridgewater).

### Per-tick auto-archive (Concern 1)

`cmdRun` calls `autoArchiveSessionEdges(rec, 200)` at the END of every
tick. Two gates:

- **Parked-AND-bloated past 200 lines** — original threshold (Round 15h).
- **Active-AND-very-bloated past 800 lines** — Round-15i defense for
  edges that flip back-and-forth and never park (e.g. the boss-agent
  edge under record-turn).

Cheap (no-op for under-threshold edges), idempotent. No agent action
required; happens automatically.

### Self-update your role (Concern 2)

If your specialty has evolved during the conversation, declare it so
peers learn what you can do well now. **Preferred path** (Round-15k
Item 7): emit a `<role>` directive in your cmdRun response, symmetric
with `<scratch>` / `<dot/>` / `<archive>` / `<dispatch>`:

```xml
<role>Updated specialty: cross-runtime integration witness after Round-15k</role>
```

Empty body clears the override and reverts to YAML default. cmdRun
parses the directive inline and calls `writeRoleOverride` — no separate
CLI invocation needed.

Or out-of-band via the CLI:

```bash
echo "Updated specialty: <one-line summary>" \
  | bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" role set --stdin
```

Storage is `<conv>/.roles/<agent>.md` (4 KB cap), overlay-merged into
`topology.roles` on every cmdRun tick so peers see the update
immediately. `agent-chat role get [<agent>]` prints the active role;
`role list` shows everyone with `[override]` flag on agents who've
self-updated. `role clear` removes your override.

When to update your role:

- You've taken on a new responsibility you'll keep.
- A recurring pattern of work surfaces a specialty the YAML doesn't
  capture.
- A peer's grading (see Dot Collector below) has flagged a strength or
  weakness you want to officially own or shed.

Don't update for one-off tasks — that's churn. The role is the durable
shape of "what you do."

### Grade your peer with the Dot Collector (Concern 3)

After a productive (or unproductive) exchange, append a `<dot />`
directive to your cmdRun response — same syntax as `<scratch>` and
`<dispatch>`:

```xml
<dot peer="lumeyon" clarity="9" depth="8" reliability="9" speed="7"
     note="Phase-5 plan was crisp; turnaround was fast" />
```

Axes are 1–10. Unprovided axes default to 5 (neutral, no signal).

**Axes are configurable** (Round 15k Item 8). Defaults are clarity /
depth / reliability / speed (Dalio's framing). To change them for the
whole network, edit `~/.claude/data/agent-chat/config.json`:

```json
{ "dot_axes": ["creativity", "rigor", "specificity", "openness"] }
```

Constraints: 1-8 axes, each `[a-z0-9_-]{1,32}`, no duplicates. All 10
agents read the same config.json so the network agrees on axes. The
`<dot/>` directive's example in cmdRun's prompt templates off the
configured axes at runtime — agents always see the right axes.

You can also dot from the CLI:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" dot lumeyon \
    --axis clarity=9 --axis depth=8 \
    --axis reliability=9 --axis speed=7 \
    --note "crisp Phase-5 plan"
```

Self-grading is refused. Aggregation is **believability-weighted via
fixed-point iteration** (Round 15k Item 6): initialize all agents at
0.5 prior, then iteratively recompute each agent's score as the
weighted mean of their received-axes scores using the previous pass's
weights. Iterates until convergence (max delta < 0.001) or 20 passes.
Converges in ~5-10 passes on a 10-agent petersen, sub-millisecond.

This is Dalio's actual recursive-trust model: high-believability
voices count more when grading others, recursively. A noisy grader
contributes proportionally less; an agent who gains believability
through high received-grades sees their *future* grades of others
weighed more. New agents start at 0.5 and converge as their first
dots land.

Read the network's grades:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" dots          # roster of all agents
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" dots lumeyon  # detail with recent dots
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" dots --json   # machine-readable
```

The composite score (1–10) summarizes the configured axes; cmdRun
surfaces it in the network roster (Concern 4 below) so routing
decisions weight demonstrably-competent peers more.

### Full network roster + relay paths (Concern 4)

Pre-fix, cmdRun's prompt only listed direct neighbors' roles — agents
had no idea what non-neighbors specialized in, so cross-graph routing
was blind. Now every cmdRun tick prepends a roster of **every agent**
in the topology with role first-line, dot composite + believability,
and how to reach them:

- **Direct neighbor**: emit `<dispatch peer="<name>">prompt</dispatch>`
- **Non-neighbor**: the prompt names the relay hop. For petersen
  (diameter 2), every non-neighbor is reachable through exactly one
  intermediary. The roster line shows e.g. `"2 hops via lyra → cadence
  — relay through lyra"` so the agent knows to dispatch to `lyra` with
  a forwarding ask.

The BFS path is computed by `lib.relayPathTo(topo, from, to)` — also
exported for direct use in scripts.

### Putting it all together

A typical orion tick now reads:

1. cmdRun pulls the network roster (every agent + role + dots + route).
2. orion sees `cadence` (non-neighbor) is best at devil's-advocate review
   for this question (composite 8.7, belv 0.84).
3. orion emits `<dispatch peer="lyra">forward to cadence: <ask></dispatch>`
   because lyra is the relay hop.
4. After cadence's reply flows back, orion grades the contribution:
   `<dot peer="cadence" clarity="9" depth="9" reliability="8" speed="7"
   note="caught a subtle invariant" />`.
5. The dot appends to `<conv>/.dots/cadence.jsonl`. cadence's composite
   ticks up, and her believability does too — her future dots will
   weigh more across the network.
6. If orion's specialty has evolved during this exchange, she updates
   her role inline: `<role>Updated specialty: ...</role>`.
7. cmdRun's tail auto-archives any parked-and-bloated edges before
   exit.

The mesh is now self-organizing: roles describe demonstrated competence,
dots score it continuously, and routing decisions can choose the
right peer instead of just the nearest one.
