# agent-chat

**N agents. One graph. Real conversations. Filesystem-first, no database, no token ceiling.**

> **Ephemeral-only architecture + Dalio Dot Collector + dual-runtime
> (Rounds 15d — 15j).** agent-chat runs as short-lived process invocations:
> each `agent-chat run` reads filesystem state, processes actionable edges,
> and exits. No long-running daemons; sidecar + monitor were deleted in
> Round-15d-β. Cache-warm continuation handled by `loop-driver.ts` via
> `ScheduleWakeup` (270s). The mesh is now self-organizing: per-agent
> autobiographical scratchpads carry relationship context across ticks;
> agent-managed archive directives let writers author their own summaries;
> agents can self-update their roles at runtime so peers learn what they
> do well; and the **Dalio-inspired Dot Collector** gives every peer
> multi-axis grades (clarity, depth, reliability, speed) that aggregate
> into believability-weighted composite scores surfaced in every cmdRun
> prompt's full network roster + relay-path routing hints. Conversations
> are stored user-globally at `~/.claude/data/agent-chat/conversations/`
> (configurable via `~/.claude/data/agent-chat/config.json` for
> cross-runtime sharing between Claude Code and Codex installs).

`agent-chat` is a Claude Code / Codex skill that lets multiple AI sessions
collaborate on real work through a shared on-disk protocol — and unlike most
multi-agent frameworks, the wire format is just markdown files and JSONL.
You can read every byte of every conversation with `cat`. You can grep your
entire history with `rg`. You can move it between machines with `rsync`.
And it scales to long-running, branching, multi-week threads without
bloating any single session's context window.

The skill is also **built by** the kind of multi-agent collaboration it
enables. Every architectural change since Round 8 has been planned,
implemented, cross-reviewed, and integrated through the petersen graph
itself, by ten Claude sessions running in parallel. The
[How this codebase is built](#how-this-codebase-is-built) section below
explains why we believe this produces measurably better code than solo
work — with the bug receipts to back it.

It started as the natural generalization of a
two-agent turn protocol where Claude and Codex pass a shared markdown file
back and forth using a `.turn` sentinel. The natural question was: *what if
this worked for ten agents on a graph instead of two?* The answer is this
repo.

You don't need to learn the protocol to use it. Once `agent-chat init`
runs, just type as the user — the skill captures every turn into the right
edge automatically and the monitor wakes you up when peers reply.

---

## Why you'd want this

**Multi-agent collaboration that isn't a chat-room.** Pick a graph topology
— Petersen (10 agents, degree 3, diameter 2), ring, star, pair — and every
edge becomes a private bilateral conversation. No agent is firehosed by
nine other agents at once. No coordination layer dictates who talks when.
Each pair of neighbors decides whose turn it is via a single-line `.turn`
file the protocol updates atomically.

**Conversations that don't degrade.** The killer feature: `agent-chat`
borrows the architecture of the [lossless-claw][lcm] context-management
plugin to give every edge a *DAG of summaries*. As `CONVO.md` grows past a
few hundred lines, you seal old chunks into searchable archives. As
archives accumulate, you condense them into higher-depth summaries. The
fresh tail of recent sections stays verbatim; older context is one
`bun search.ts grep` away — and one `expand` call from the original
verbatim transcript. **Nothing is lost. Everything stays cheap to re-read.**

[lcm]: https://losslesscontext.ai

**Filesystem-first.** The wire protocol is markdown + YAML + a one-line
JSONL index per edge. No external service, no MCP server, no Postgres,
no daemons. Works on local disk, NFS, sshfs, and any other mount.
Survives reboots. Diffs cleanly. Versions in git like prose.

**Drop-in for any agent runtime.** The protocol is runtime-agnostic. Claude
Code reads it, Codex reads it, an agent script you wrote on a Tuesday reads
it. The skill spec is one `SKILL.md` file; the operational checklist is one
`bootstrap.md` file; the implementation is ~9 TypeScript files totaling
roughly two thousand five hundred lines, with zero npm dependencies (we
use Bun's built-ins where extras would be tempting).

**Ephemeral execution model (Round 15d).** Every `agent-chat run`
invocation reads filesystem state, processes actionable edges, and
exits. No long-running daemons; no sidecar; no monitor process; no
heartbeat emitter. Cache-warm continuation between ticks is handled
by `loop-driver.ts` via Claude Code's `ScheduleWakeup` primitive (270s
delay tuned to stay under the 5-min prompt-cache TTL — empirical
finding from the Ruflo audit). Rate-limit pauses are transparent: the
next tick is a fresh process. Sub-relay activation lets agents
dispatch through their own neighbors (carina → lumeyon directly, not
just through orion). Per-agent autobiographical scratchpads preserve
relationship context across ticks. Agent-managed archive directives
let the writer of a section also author its summary.

**Multi-user transparency, automatic and orthogonal.** Humans live in a
separate `agents.users.yaml` registry that overlays onto every topology
at load time. Run `agents.petersen.yaml` + `agents.users.yaml` and you
get the same 12-agent / 36-edge structure that `agents.org.yaml` shipped
with — without coupling humans to a specific topology. `agent-chat init`
auto-resolves the speaker from `$AGENT_CHAT_USER` || `$USER` (if
registered) || `users.yaml default: true`, so capture is automatic;
`agent-chat speaker <name>` remains as override for multi-user sessions.
`agent-chat record-turn` captures user-prompt + assistant-response as two
sequential sections on the appropriate `<speaker>-<agent>` edge with
sha256-idempotent retries. Speaker switches emit a recorded handoff
section to the OLD edge before routing the new turn — the audit trail of
"who was talking when" lives in `CONVO.md`, not in any access-control
layer. **No private channels:** transparency is an organizational value;
accountability is the audit trail. Long-running human-AI conversations
fold into the same lossless-claw archive layer as everything else, so
`search.ts grep` over the whole tree returns hits across all threads.

---

## What you get

| Capability | How |
|---|---|
| **N-agent topology over an arbitrary graph** | YAML manifests (`agents.<topology>.yaml`) declare agents and edges. Petersen, ring, star, and pair ship in the box. |
| **Per-session identity resolution** | `$AGENT_NAME` + `$AGENT_TOPOLOGY` env vars, or a `.agent-name` file in cwd, or a per-session record under `.sessions/`. The skill refuses to guess — silent identity-guessing is what made codex-chat 2-agent-only. |
| **Atomic turn handoff** | `.turn` written via `tmpfile + rename`. Concurrent reads always observe either the old or the new value. |
| **Ephemeral execution** | `agent-chat run` reads filesystem state, processes actionable edges (where `.turn = me` and no lock), and exits. No long-running daemons. `loop-driver.ts` wraps cmdRun with cache-warm `ScheduleWakeup` (270s) for self-rescheduling; `--interactive` mode runs a tight 1-3s tick loop until idle for real-time deliberation. Stuck-recovery: any edge whose turn has been on me for >5min with no progress gets auto-redispatched on the next loop iteration. |
| **Per-agent autobiographical scratchpad** | `<conversations>/.scratch/<agent>.md` — the agent's own narrative of their relationships, written in their voice, persisted across ticks (8KB cap; older content gets condensed via `scratch-condense.ts` into the scratchpad DAG). Read at the start of every tick alongside the CONVO.md tail. The structural answer to "the same agent must know context from the distant past" under ephemeral execution. |
| **Sub-relay activation** | `agent-chat run --sub-relay-from <chain>` lets a peer dispatch through its own neighbor (carina → lumeyon directly, not just through orion). Cycle refusal + depth ≤ topology-diameter as correctness guards. Activates the (N choose 2) - (orion's neighbors) edges that the persistent-mode "everything through the orchestrator" pattern left dormant. |
| **Agent-managed memory directives** | Agents emit `<scratch>...</scratch>` and `<archive>sections: N\nsummary: ...</archive>` and `<dispatch peer="X">prompt</dispatch>` and `<dot peer="X" clarity="N" depth="N" reliability="N" speed="N" note="..."/>` blocks in their tick responses. The writer of a section authors its archive summary in their own words; bypasses the deterministic synthesizer. `archive.ts auto --seal-count N --agent-summary` is the underlying primitive. |
| **Self-update your role at runtime** (Round 15h) | `agent-chat role <get\|set\|clear\|list>` lets an agent declare what they currently do well so peers learn it. Storage at `<conversations>/.roles/<agent>.md` (4 KB cap), overlay-merged into `topology.roles` on every cmdRun tick — so peers see the update immediately. The mesh is no longer static. |
| **Dalio-inspired Dot Collector** (Round 15h) | Multi-axis peer grading along **clarity / depth / reliability / speed** (each 1-10). Append-only ledger at `<conversations>/.dots/<peer>.jsonl`. Aggregation is **believability-weighted**: each grader's contribution is weighed by their own composite score (received-axes-mean / 10, neutral prior 0.5 for new agents). Agents grade via `<dot peer="X" clarity="N" .../>` directive in their tick response or `agent-chat dot <peer> --axis a=N` CLI. Self-grading refused. `agent-chat dots [<peer>]` shows roster + per-axis weighted means + recent dots. |
| **Full network roster + relay-path routing** (Round 15h) | cmdRun's prompt now lists **every** agent in the topology (not just direct neighbors) with role first-line + dot-collector composite + believability + routing hint. Direct neighbors get `<dispatch peer="X">`; non-neighbors get a "relay through Y" hint computed via `lib.relayPathTo` BFS. For petersen (diameter 2) every non-neighbor is reachable through exactly one intermediary. The mesh becomes self-aware. |
| **Per-tick auto-archive** (Round 15h+i) | `cmdRun` invokes `autoArchiveSessionEdges` at the END of every tick (not just at exit), so ephemeral mode — where sessions never explicitly exit — actually trims long edges. Two thresholds: parked-AND-bloated past 200 lines, OR active-AND-very-bloated past 800 lines (Round-15i fix for boss-agent edges that flip back-and-forth and never park). Same `archive.ts auto` underlying path; keeps the last 4 sections verbatim. |
| **Dual-runtime: Claude Code + Codex from one repo** (Round 15b/i) | `scripts/runtimes/{claude,codex}.ts` adapters share a symmetric `dispatch + scheduleWakeup` shape. Claude wraps `claude -p` via `runClaude`; Codex wraps `codex exec`. The wire protocol is identical across runtimes — agents in different runtimes can collaborate on the same petersen graph because every state is filesystem-mediated. CONVERSATIONS_DIR defaults to `~/.claude/data/agent-chat/conversations/` (user-global, version-stable across plugin-cache version dirs); `~/.claude/data/agent-chat/config.json` `conversations_dir` field lets both runtimes share state explicitly. |
| **Built-in test surfaces** (Rounds 15g – 15j) | `agent-chat self-test` (62 checks, hermetic, ~5s) — wire protocol + identity + edge canonicalization + lock+append+flip+unlock round-trip + park semantics + role overrides + Dot Collector + relay paths + loop-driver clean exit. `agent-chat network-test` (205 checks, ~3s) — full-mesh Dot Collector verification on petersen. `agent-chat llm-smoke` — real `claude -p` directive parsing smoke. `agent-chat integration-test` — real cmdRun + real LLM end-to-end. `agent-chat doctor --paths` — show resolved CONVERSATIONS_DIR + config source. |
| **Humans as first-class agents (orthogonal overlay)** | `agents.users.yaml` declares humans separately from any topology; `loadTopology()` overlays them at load time so any topology automatically gets human-AI edges. `agent-chat init` auto-resolves the speaker from environment (`$AGENT_CHAT_USER` / `$USER` / `users.yaml default`); `agent-chat speaker <name>` overrides for multi-user sessions. `agent-chat record-turn --user X --assistant Y` captures the turn as two CONVO.md sections on the appropriate `<speaker>-<agent>` edge. Idempotent retries via per-edge `recorded_turns.jsonl` ledger (sha256). Speaker switches emit recorded handoff sections to the prior edge. Privacy is an explicit non-goal — accountability is the audit trail. |
| **Conversation archives that stay searchable** | Sealed leaves (`archives/leaf/`) preserve the verbatim transcript; SUMMARY.md captures the distilled knowledge with an *Expand for details about:* footer that signals what was compressed away. |
| **DAG condensation** | Once leaves accumulate, fold N siblings at depth d into one parent at depth d+1 with a more abstract policy. Agent walks down via `search.ts expand --children`. |
| **Three-tier search escalation** | `grep` over `index.jsonl` (cheap) → `describe` for one SUMMARY.md (medium) → `expand` for the original BODY.md (cold). Most queries stop at grep. |
| **Anti-theater validator** | A summary missing TL;DR, Keywords, or the Expand-for-details footer is rejected at commit time. "Looks good" is not accepted as a summary. |
| **Auto-proceed-on-agreement** | The codex-chat rule scales naturally: if a peer's section ends with a concrete reversible action you agree with, just do it. Escalate on disagreement. Per-edge, not global. |

---

## Quick start

### Prerequisites

- A modern TypeScript runtime: [bun][bun] (recommended), [tsx][tsx], or
  Node 23+ with `--experimental-strip-types`. The skill has zero npm
  dependencies — every script is plain Node std + bundled types.
- One Claude Code session, one Codex session, or any other agent that can
  run a shell command and read a markdown file.

[bun]: https://bun.sh
[tsx]: https://github.com/privatenumber/tsx

### 1. Install (two options)

**Option A — Claude Code plugin marketplace (recommended):**

Claude Code's plugin install commands are **slash commands typed inside
an active Claude Code session**, not shell commands. Start Claude Code
in a terminal, then at the prompt type the four-step install dance:

```
/plugin marketplace add lumeyon/agent-chat
/plugin install agent-chat@agent-chat-marketplace
/reload-plugins
```

The marketplace name is `agent-chat-marketplace` (from the `name` field
in `.claude-plugin/marketplace.json`), so `/plugin install ...@<name>`
must reference that, not `@lumeyon/agent-chat`. Once installed, the
plugin auto-loads its skill on every Claude Code session start. Run
`agent-chat self-test` to verify the install:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" self-test  # → 62/62 pass
```

`$AGENT_CHAT_DIR` resolves automatically via the bootstrap preamble in
the SKILL.md to `~/.claude/plugins/cache/agent-chat-marketplace/agent-chat/<version>/`.

**For Codex** (Round-15i runtime adapter is now implemented — `codex exec`
is the non-interactive entrypoint):

```bash
codex plugin marketplace add lumeyon/agent-chat
```

The marketplace add succeeds (clones the repo to
`~/.codex/.tmp/marketplaces/agent-chat-marketplace/`), but Codex's
plugin install lifecycle differs from Claude Code's — full per-plugin
enable currently requires a manual `~/.codex/config.toml` entry:

```toml
[plugins."agent-chat@agent-chat-marketplace"]
enabled = true
```

The runtime adapter itself works once the plugin is enabled. The
empirical findings on Codex's install lifecycle live as comments at
the top of `scripts/runtimes/codex.ts`.

**Option B — Direct symlink (legacy, pre-plugin path):**

```bash
git clone https://github.com/lumeyon/agent-chat.git ~/git/agent-chat
ln -s ~/git/agent-chat ~/.claude/skills/agent-chat
```

Claude Code auto-discovers skills under `~/.claude/skills/`. Works
without the plugin marketplace flow but won't pick up the new
`scripts/runtimes/<runtime>.ts` per-runtime adapters or marketplace
metadata. The plugin path is preferred.

### 2. Tell each session who it is — in plain English

Launch Claude (or Codex) in each terminal as normal. On the first turn,
just **say who they are**:

```
> you are orion in the petersen graph
```

Claude immediately runs (this is wired into `bootstrap.md` so the skill
knows to do it on its own):

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts init orion petersen
```

That single command claims the identity, writes a per-session file under
`conversations/.sessions/`, refuses if another live session already
claims that name, infers the topology if only one is in use, auto-launches
**both the multi-edge monitor and the per-agent sidecar daemon** in the
background, and prints the session's neighbors. Every other script in
the skill reads the per-session file automatically — no env vars, no
`.agent-name`, no exports. Pass `--no-sidecar` if you want the file-direct
slow paths only; pass `--no-monitor` if you don't want the chat-notification
poller.

**This scales to N sessions in one directory.** Open ten terminals in the
same project, run `claude` in each, tell each one its name, done. They
all share the same `conversations/` tree, but each session has its own
identity file keyed by `$CLAUDE_SESSION_ID` (or the parent shell's pid).

Useful subcommands:

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts who      # list live agents on this host
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts whoami   # this session's identity
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts exit     # sign out, stop the monitor
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts gc       # sweep dead sessions
```

If you re-launch Claude in the same terminal where you previously ran as
`orion`, `init` recognizes it (matching cwd + tty, only when the prior
pid is dead) and offers to resume that identity rather than asking you to
redeclare.

Power users can still use `$AGENT_NAME` / `$AGENT_TOPOLOGY` env vars or a
`.agent-name` file — those remain supported as fallback resolution
sources for CI / scripted setups.

### 3. Process pending work (Round-15d ephemeral mode)

`agent-chat init` only registers identity — it does NOT launch any
daemons. To actually process pending turns, run a tick:

```bash
SKILL=~/.claude/skills/agent-chat

# Single tick: read .turn files, process any edge where turn=me, exit.
bun $SKILL/scripts/agent-chat.ts run

# Filtered to a specific peer:
bun $SKILL/scripts/agent-chat.ts run lumeyon

# Cache-warm self-rescheduling loop (270s ticks via ScheduleWakeup):
bun $SKILL/scripts/loop-driver.ts

# Real-time interactive cadence (1-3s ticks until idle):
bun $SKILL/scripts/loop-driver.ts --interactive

# Sub-relay: dispatch through your own neighbor (carina → lumeyon directly):
AGENT_NAME=carina bun $SKILL/scripts/agent-chat.ts run --sub-relay-from carina lumeyon
```

The protocol is filesystem-mediated; there are no background processes
to monitor. Each `agent-chat run` invocation reads the current `.turn`
state, processes its actionable edges (composes a response via
`claude -p`, appends to CONVO.md, flips the turn), and exits. Rate-limit
pauses are transparent: the next tick is a fresh process.

### 4. Take a turn manually (low-level primitives)

If you'd rather drive the protocol yourself instead of using `cmdRun`:

```bash
SKILL=~/.claude/skills/agent-chat
bun $SKILL/scripts/turn.ts peek lumeyon          # is it my turn? what's the lock state?
bun $SKILL/scripts/turn.ts lock lumeyon          # claim the brief append+flip lock
# ... append your section to the CONVO.md path that `peek` printed.
# Format: `## <agent> — <topic> (UTC YYYY-MM-DDTHH:MM:SS[.fff]Z)\n\nbody\n\n→ <next>`
bun $SKILL/scripts/turn.ts flip lumeyon lumeyon  # hand off (or `parked`)
bun $SKILL/scripts/turn.ts unlock lumeyon
```

If the flip is refused with `refuse to flip — turn is "X", not "Y"`,
**stop**. Do not modify the .md. The protocol just told you it's not your
move.

### 5. When the conversation gets long, archive

```bash
bun $SKILL/scripts/turn.ts park lumeyon                # park first; sealing requires parked
bun $SKILL/scripts/archive.ts plan lumeyon             # dry-run: preview what would seal
bun $SKILL/scripts/archive.ts seal lumeyon             # seal everything before the fresh tail
# now edit the SUMMARY.md the seal step printed: fill TL;DR, Decisions,
# Blockers, Follow-ups, Artifacts, Keywords, and Expand-for-details
bun $SKILL/scripts/archive.ts commit lumeyon arch_L_…  # validate + finalize the index entry
```

The validator will refuse the commit if any required section is missing,
if there are unfilled TODO markers, or if Keywords / Expand-for-details
are empty. That's the anti-theater rule: a summary that says nothing
specific never reaches the index.

### 6. Search archives later

```bash
bun $SKILL/scripts/search.ts grep "scan orchestration"      # cheap: hits across all my edges
bun $SKILL/scripts/search.ts describe arch_L_…              # full SUMMARY.md + meta
bun $SKILL/scripts/search.ts expand arch_L_…                # verbatim BODY.md (leaf)
bun $SKILL/scripts/search.ts expand arch_C_… --children     # walk down to child summaries
```

Most lookups stop at `grep`. Only `expand` when the SUMMARY.md's
*Expand for details about:* footer says the thing you actually want is
in the body.

---

## Hybrid mode — persistent and ephemeral sessions on the same graph

agent-chat ships two execution modes that interoperate transparently. Both
write to the same `CONVO.md` / `.turn` / `index.jsonl` files; **peers do
NOT know which mode the other side is running.** This is the load-bearing
invariant of hybrid mode — the wire format is the protocol; runtime model
is a private session choice.

### Persistent mode (today's default)

The mode every prior round shipped. `agent-chat init` launches a
long-lived sidecar + monitor; the agent reads notifications from the live
Monitor task; sessions can run for hours. Best for **interactive work
where the agent is paying attention** — collaborative reviews, multi-step
debugging, anything with rapid back-and-forth turns.

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts init keystone petersen
# sidecar + monitor up; agent waits for monitor notifications.
```

### Ephemeral mode (`agent-chat run`)

A single-tick execution model: spawn an agent process, do exactly one
turn's worth of work (read peer messages → respond → flip turn), exit.
Best for **batch jobs, cron-driven sweeps, low-resource environments,
and resumable orchestration where staying loaded is wasteful**.

```bash
# Single tick across every edge where the floor is on me:
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts run

# Single tick, scoped to one or more specific peers:
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts run <peer> [<peer>...]

# Single tick that may include destructive operations (cleanup workers, gc agents):
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts run --unsafe <peer>
```

For self-scheduling (cache-warm continuation between ticks via Claude
Code's `ScheduleWakeup`), use the `loop-driver.ts` wrapper:

```bash
bun ~/.claude/skills/agent-chat/scripts/loop-driver.ts
# Runs one cmdRun tick, then schedules the next tick 270s later if work
# is still pending. Intended to run UNDER /loop skill context (or any
# harness that handles ScheduleWakeup directives).
```

The 270-second delay is deliberate, copied from Ruflo's autopilot pattern
(`/data/eyon/git/ruflo/plugins/ruflo-autopilot/skills/autopilot-loop/SKILL.md:18`):

> "Always use delay 270s (under 300s cache TTL) to keep the prompt cache
> warm between iterations."

Anthropic's prompt cache has a 300-second TTL; rescheduling at 270s keeps
the cache warm so each subsequent ephemeral tick gets a cache hit instead
of a cold prompt encode. This is the structural answer to the
"stuck-on-own-turn" failure mode the persistent monitor caught in
Round-13 — ephemeral sessions can't get stuck because they don't stay
alive long enough.

### When to use which

| Scenario | Mode |
|---|---|
| Interactive collaborative work, multi-step debugging | persistent |
| You're typing turns yourself, want immediate notifications | persistent |
| Cron-driven sweeps, batch reviewers, weekend agents | ephemeral |
| Low-resource hosts (no idle daemon budget) | ephemeral |
| Edges that flow rarely (~hours between turns) | ephemeral |
| Edges where the floor sits with you for >5min routinely | ephemeral |

**Mixing modes is supported and useful**: a 10-agent petersen graph can
have 5 persistent agents (the active reviewers) + 5 ephemeral agents
(scheduled background workers). The protocol doesn't change. Cross-mode
turn-flips work because the wire format is the same.

### Multi-user under ephemeral

The transparency invariant is unchanged across modes: **the speaker on
the dispatched edge is the same human who triggered the parent dispatch.**

Concretely: `boss` types in their terminal → `orion` (persistent) decides
to dispatch `keystone` ephemerally for the boss-keystone edge → the
recorded turn on `boss-keystone/CONVO.md` shows `boss` as the speaker,
not `orion`. The orchestrator is invisible at the wire level; the user-
facing transcript is indistinguishable from boss having had a direct
keystone session.

**v1 limitation (Round-15a ships):** AI-to-AI ephemeral dispatch works
end-to-end. Human-to-AI ephemeral × `record-turn` (the case above)
returns exit `64` ("no current speaker") because the parent orchestrator
must pre-write a synthetic `SessionRecord` + `current_speaker.json` on
behalf of the dispatched child, and that pre-write step (Contract A in
the design notes) is **deferred to Round-15c**. For Round-15a, treat
hybrid mode as best-fit for AI-AI ephemeral dispatch where the human
stays in the persistent session.

### Heartbeat semantics under ephemeral

Round-13's heartbeat detector classifies missing heartbeats as
`peer-sidecar-dead`. Ephemeral runs **legitimately have no heartbeat** —
they don't stay alive long enough to write one. This is expected, not a
bug. The monitor's stuck-detection signal is correct *in the persistent-
peer worldview* and informational *in the mixed-mode worldview*. Future
rounds may add a heartbeat-tombstone written by `cmdRun` to disambiguate
"ephemeral run completed successfully" from "persistent peer's sidecar
crashed." For now: read peer-sidecar-dead notifications on edges with a
known-ephemeral peer as informational.

### Coexistence

`agent-chat run` refuses to start if a live sidecar already exists for
the agent — preventing accidental double-loading on the same agent
identity. To switch modes, run `agent-chat exit` first to clear the
persistent state.

`agent-chat run` also honors the reentrancy guard: it refuses if
`AGENT_CHAT_INSIDE_LLM_CALL=1` (running inside a parent LLM call's
subagent context). This is the same guard cmdInit + cmdRecordTurn share
from Round-12; it prevents recursive turn writes that would corrupt the
parent's audit trail.

### Verification

The hybrid-mode invariants live in three regression suites:

- `tests/cmd-run.test.ts` — `agent-chat run` flag parsing, sidecar-
  collision refusal, reentrancy guard, the work loop's lock+flip
  contract, and the safety pre-flight gate (`--unsafe` override).
- `tests/safety.test.ts` — `safety.ts detectDestructive` regex coverage
  for `rm -rf`, force-pushes, secret-token shapes, and the false-positive
  carve-outs that drove the `--unsafe` flag.
- `tests/ephemeral.test.ts` — `cmdRun` lifecycle no-op under
  `AGENT_CHAT_NO_LLM=1`, the exit-64 regression-pin (Round-15c kickoff:
  this test flips to a success assertion when Contract A lands and
  cmdRun pre-writes the synthetic SessionRecord + speaker file), the
  exit-66 human-only-speakers gate (rejects AI-as-speaker forgeries),
  and parallel session-key isolation on interactive fixtures.

Run them with `bun test tests/cmd-run.test.ts tests/safety.test.ts
tests/ephemeral.test.ts`.

---

## How it works (in 90 seconds)

A **topology manifest** declares agents and edges:

```yaml
topology: petersen
agents: [orion, lumeyon, lyra, keystone, sentinel, vanguard, carina, pulsar, cadence, rhino]
edges:
  - [orion, lumeyon]
  - [lumeyon, sentinel]
  # … 13 more edges …
```

Each edge has a directory under `conversations/<topology>/<edge-id>/`
where `edge-id` is alphabetical (`lumeyon-orion`, not `orion-lumeyon`),
so both sides of the edge resolve the same path.

Inside the edge directory:

```
CONVO.md            # append-only shared transcript (the "hot file")
CONVO.md.turn       # one-line sentinel: <agent-id> | parked
CONVO.md.turn.lock  # transient lock during the append+flip sequence
index.jsonl         # one line per archive at any depth (cheap-grep search surface)
archives/
  leaf/<arch_L_…>/         # depth 0: BODY.md (verbatim) + SUMMARY.md + META.yaml
  condensed/d1/<arch_C_…>/ # depth 1: SUMMARY.md + META.yaml (parents = leaf ids)
  condensed/d2/<arch_C_…>/ # depth 2 …
  condensed/d3/<arch_C_…>/ # depth 3+ (durable trajectory)
```

Per-host control state lives at the topology root:

```
conversations/.sessions/<key>.json    # per-session identity record (Round 5)
conversations/.presence/<agent>.json  # per-agent presence + monitor + sidecar pids
conversations/.sockets/               # sidecar UDS endpoints + pidfiles + cursor files
  <agent>.sock                        # mode 0600 UDS (filesystem-permission auth)
  sidecar-<agent>.pid                 # pid + starttime fingerprint for crash-recovery
  <agent>.cursors.json                # named-cursor persistence for `unread` calls
conversations/.logs/                  # per-daemon log files
  monitor-<agent>.log
  sidecar-<agent>.log
```

The protocol is:

1. **Read `.turn`.** If it names you, you have the floor. If it names
   someone else, you don't write. If it's `parked`, the conversation is
   closed and you ask the user before resuming.
2. **Append your section to `CONVO.md`.** Format ends with `→ <next>`.
3. **Flip `.turn`** atomically to the next agent's name (or `parked`).
4. **Monitor** notifies the next agent.

That's it. Everything else — locks, archive sealing, condensation, search
— is built on top of those four primitives.

---

## Topology cheat sheet

| Topology | Agents | Edges | Degree | Diameter | When to use |
|---|---|---|---|---|---|
| `pair` | 2 | 1 | 1 | 1 | Two-agent collaboration. Subsumes the original codex-chat. |
| `ring` | 10 | 10 | 2 | 5 | Smallest blast radius; gossip-style propagation. |
| `petersen` | 10 | 15 | 3 | 2 | Sweet spot: bounded interruption, every non-neighbor reachable in one hop. |
| `star` | 10 | 9 | 1 (spokes), 9 (hub) | 2 | Single orchestrator + nine specialists. No lateral chatter. |
| `org` | 10 AI (humans overlaid via users.yaml) | 15 (+ 21 derived) | 5 AI, 11 humans (after overlay) | 2 | AI subgraph for the org cohort — identical to petersen. With `agents.users.yaml` present, `loadTopology("org")` returns 12/36 (overlay derives human-AI and human-human edges automatically). Use this OR petersen — they're equivalent post-overlay. |

To define a custom topology, drop an `agents.<name>.yaml` file in the skill
root. The validator in `lib.ts` checks every edge's endpoints exist in the
agents list and rejects self-loops.

---

## How this codebase is built

The agent-chat protocol isn't just *for* multi-agent collaboration — it's
*built by* multi-agent collaboration. Every architectural change since
Round 8 (lock-semantics + lifecycle hardening) has been planned,
implemented, cross-reviewed, and integrated through the petersen graph
itself. Ten Claude sessions running in parallel as `orion`, `lumeyon`,
`keystone`, `sentinel`, `vanguard`, `lyra`, `carina`, `pulsar`, `cadence`,
`rhino`. Five-phase pattern per round:

1. **Plan.** orion (the orchestrator) dispatches a kickoff to three direct
   neighbors, each owning a slice. Each direct neighbor cross-pollinates
   with their two sub-relays for slice-specific architectural decisions.
2. **Consolidate.** orion resolves cross-slice tensions, locks contracts.
3. **Implement.** Three peers code in parallel, each in their slice.
4. **Cross-review.** Round-robin: each peer reviews one other peer's slice.
5. **Integrate.** orion runs full test suite, single-commit + push.

This is more wall-clock-effort than a single agent typing alone. We do it
because **the cross-review catches real bugs that solo work would ship**.

### Receipts

Five real bugs caught at cross-review across four rounds, plus one caught
at Phase-1 (during planning, not implementation):

| Round | Phase | Caught by | Bug |
|---|---|---|---|
| 10 | Phase-4 | lumeyon | `listSessions` would have crashed `agent-chat who` for any session with a `current_speaker.json` |
| 10 | Phase-4 | carina | `fetchSpeaker` had a dead-code field path — silent dead optimization that motivated the dedicated UDS method |
| 11 | Phase-4 | lumeyon | chmod-race in `exclusiveWriteOrFail` — microsecond identity-leak window on shared hosts |
| 11 | Phase-4 | lumeyon | self-require dead code in `resolveDefaultSpeaker` |
| 12 | Phase-1 | rhino | lossless-claw routing regexes match 0/5 of agent-chat's actual vocabulary; routing feature would have shipped dead-on-arrival |

None of these were caught by unit tests. All surfaced when a peer with a
*different* slice's perspective reviewed the integration boundary.

### Why cross-review catches what unit tests miss

A slice author's mental model contains *exactly* the assumptions that
produced their code. They can't see what they assumed. A reviewer from a
different slice has different assumptions and sees the integration boundary
differently. This is structurally what unit tests cannot provide — the same
reason human code review catches things the author missed.

### Forced articulation produces a durable design record

The kickoff → Phase-1 plan → Phase-4 review structure makes us write down
decisions with reasoning *before* implementing. Six weeks later the
rationale lives in the `conversations/` tree, grep-able and durable. Solo
work produces code; the team produces code + paper trail. This effect
compounds: Round 11 was faster than Round 10 because the team had explicit
rationale from Round 10 to refer to. Round 12's plan benefited from
Round-11's documented decisions.

### Problem decomposition gets done before coding

Dispatching a slice with concrete sub-relay assignments forces understanding
the problem shape before writing any code. Solo, we'd start coding the
easiest piece and discover the architecture during implementation —
usually meaning a refactor halfway through. The team's planning phase forces
the design conversation up front.

### The honest tradeoff

Multi-agent has ~5-min round-trip latency per phase; solo has ~10s. For
**small focused changes** (bug fix, rename, docs), solo is strictly faster
and the team-coordination overhead dominates. For **changes that break
cross-cutting invariants** or **introduce new architectural patterns**, the
cross-review catches things that ship breakage otherwise. The skill of
using this skill is knowing which is which.

For most software engineering work, solo is fine. For load-bearing
architectural changes, the team produces measurably better code at
~50-100% wall-clock cost. We've used the team for rounds 8-12 (hardening
audit, sidecar daemon, multi-user, orthogonal user overlay, lossless-claw
parity); we've used solo for the dozens of small fixes between them.

### What this is NOT

- **It's not "wisdom of crowds."** Two heads aren't better than one when
  there's a right answer; what helps is *independent perspective at the
  integration boundary*, not opinion-aggregation.
- **It's not faster than solo.** It's slower; we accept the cost for the
  bug-catching value.
- **It's not specialization.** All ten agents are the same Claude model
  with the same training. The slice-ownership story is a coordination
  pattern, not a skills-distribution one.
- **It's not a replacement for unit tests.** Cross-review and unit tests
  catch *different* failure modes. We use both, with cross-review focused
  on the integration boundary unit tests can't reach.

The full audit trail of every round lives under
`conversations/petersen/<edge>/CONVO.md` — every plan, every review, every
fix-decision is recorded. The conversation between the agents IS the
design document.

---

## Why a graph at all?

Every multi-agent system that lets every agent talk to every other agent
either becomes a chat-room (signal-to-noise collapses) or grows a
coordination layer (which becomes its own bottleneck). A small bounded
graph is the cheapest known fix:

- **Petersen graph** specifically: 10 nodes, 15 edges, degree 3, diameter
  2. Every agent has a small, stable validation team. Every non-neighbor
  is reachable through exactly one intermediary. The blast radius of any
  one chatty agent is bounded to its three neighbors.
- **Ring** for even smaller blast radius. **Star** for orchestrated work
  where lateral chatter is undesired. **Pair** for the trivial case.

The graph is not the protocol — it's a *configuration* of the protocol.
The protocol is the same `.turn`/`CONVO.md`/lock/parked dance for any
topology. Swapping graphs is a one-line edit in `.agent-name`.

---

## Multi-user conversations (orthogonal user overlay)

agent-chat treats humans as first-class participants, **orthogonal to
the topology**: the AI peer graph stays in `agents.<topology>.yaml`
(petersen, ring, star, pair, org); humans live in a separate
`agents.users.yaml` registry. `loadTopology()` overlays the two at load
time so any topology automatically gets human-AI edges and (if you have
multiple humans) human-human edges. There's no need to migrate to a
special "humans-included" topology — petersen + users.yaml works
identically to the older `org` topology.

**Designed for transparency, not privacy.** All conversations are visible
to all participants who can read the filesystem. Accountability comes
from the audit trail (every CONVO.md is `cat`-able, `git`-diffable, and
tagged with author + UTC stamp). The lossless-claw archive layer means
the audit trail compounds: long-running threads seal into searchable
summaries; `search.ts grep` over the whole org returns hits across every
human-AI thread.

### Setting up a multi-user session (the simple case)

```bash
# In your Claude Code terminal, declare the AI side first:
> you are orion in the petersen graph
[Claude runs: agent-chat init orion petersen]

# That's it. `agent-chat init` reads agents.users.yaml, sees `boss`
# is registered with `default: true`, and auto-writes
# .sessions/<key>.current_speaker.json. Stderr logs:
#   [agent-chat] speaker auto-resolved to boss (source: users.yaml default)

# Type messages normally. After each assistant response, the agent records
# the turn into the right edge:
> agent-chat record-turn --user "let's debug the migration" --assistant "..."
#   → appends two sections to conversations/petersen/boss-orion/CONVO.md
#   → flips .turn back to boss for the next user message
```

The auto-resolve order is:
1. `$AGENT_CHAT_USER` (strict — must be in `users.yaml`, else hard-fail).
2. `$USER` (silent fall-through if not in `users.yaml`).
3. `users.yaml` `default: true` entry.

Override with `agent-chat speaker <name>` for multi-user sessions where
the OS user isn't the human typing right now.

### Switching speakers mid-session

```
> I am john now
[Claude runs: agent-chat speaker john]

# Subsequent turns route to conversations/org/john-orion/CONVO.md
# The first record-turn after the switch ALSO writes a handoff section
# to the OLD edge (boss-orion):
#   ## boss — handoff to john (UTC ...)
#   Heading out; john is taking over this thread.
#   → parked
```

The handoff is a permanent recorded event in the audit trail. Every
speaker change has a section attached to it; nobody can claim "I never
knew it was actually john" — the file shows the exact moment of every
transition.

### Why this works without a privacy layer

Two reasons:

1. **The transparency invariant is operational, not technical.** The
   architecture documents what *was* said; it doesn't prevent what could
   be said elsewhere. If an organization wants confidential channels
   later, those should be a separate explicit out-of-band, not retrofit
   into agent-chat's append-only audit log.
2. **The protocol's existing assumptions ARE the access control.**
   Filesystem-readable, append-only, atomic flip, sealed archives. Less
   code is less surface area for a permission bug to hide in.

### The hook story

Today, `record-turn` is a CLI the agent calls explicitly at end of every
response (the SKILL.md prompt instructs the agent to do so). Claude
Code's `Stop` hook is session-level (one fire per session, at session
end) and doesn't deliver `{user_prompt, assistant_response}` in its
payload, so we can't kernel-enforce "every turn is recorded."

`docs/HOOK_REQUEST.md` files the hard-discipline ask with the Claude
Code team: a `PostResponse` hook that fires after every assistant
response with that payload on stdin. If/when it ships, the dispatcher
gets a one-line wire-up; the protocol above is unchanged.

---

## The archive layer, in more depth

Inspired by the [lossless-claw][lcm] OpenClaw plugin's DAG-based
context-compaction architecture. Round 12 backports the substantive
quality-affecting parts of LCM's design (LLM-summarized archives,
ranked search, expansion-policy delegation). Two narrowly-scoped
deviations from "filesystem-only" buy enough quality and performance to
justify themselves; both are documented in `ARCHITECTURE.md` and stay
filesystem-authoritative under the hood.

- `archive.ts auto` shells out to `claude -p` to synthesize a
  `SUMMARY.md` from raw `BODY.md`, gated by an availability probe and
  an `AGENT_CHAT_NO_LLM=1` opt-out for hermetic CI. The deterministic
  synthesizer remains the fallback when `claude` is missing or the LLM
  call fails validation.
- `search.ts grep` queries a per-edge `fts.db` (bun:sqlite FTS5
  virtual table) ranked by bm25 weights tuned for the four indexed
  text columns of every summary: `tldr=2.0`, `summary_body=1.0`,
  `keywords=1.5`, `expand_topics=2.5`. The db is fully derived from
  `index.jsonl` + per-archive `SUMMARY.md` and rebuildable via
  `archive.ts doctor --rebuild-fts`; loss of `fts.db` reverts grep to
  unranked regex over JSONL.
- `search.ts expand` over multiple candidates delegates to a
  citation-bound subagent (constrained `claude -p` shell-out) so the
  parent agent doesn't pay the full body-read cost. Citation invariants
  reject orphan citations and require non-empty intersection between
  requested archive IDs and cited IDs.

**Leaf archives** (depth 0) come from sealing a prefix of `CONVO.md`. The
fresh tail (the last 4 sections by default) stays verbatim in
`CONVO.md`; everything before it goes into `BODY.md`. The agent then
fills in `SUMMARY.md` using a depth-aware policy template — d0 preserves
key decisions and active tasks, dropping repetition and filler.

**Condensed archives** (depths 1+) merge several same-depth siblings into
a higher-level node. Each depth uses a more abstract policy:

- **d1 (session-level)**: preserve decisions and outcomes, drop dead
  ends, mark superseded decisions.
- **d2 (phase-level)**: trajectory not minutiae; drop session-local
  detail and stale identifiers.
- **d3+ (durable)**: only what survives for the rest of the
  conversation; key decisions, durable lessons, active constraints.

Every summary at every depth ends with the same line:

```
## Expand for details about:
- <comma-separated list of what was dropped or compressed>
```

This is the magic. The next agent reading the summary sees, in one
glance, exactly what *isn't* preserved — and decides cheaply whether
walking down to BODY.md is worth it. Most lookups it isn't.

The `index.jsonl` at the edge root carries one ~300-byte JSON line per
archive: id, kind, depth, time range, participants, parents, descendant
count, keywords, TL;DR excerpt, body sha256. `search.ts grep` pattern-
matches across this index plus the SUMMARY.md files; most queries return
in milliseconds.

---

## Testing

The repo ships with a full test suite using [Bun's built-in test runner][buntest].
No setup, no extra dependencies — `bun test` from the repo root runs everything:

[buntest]: https://bun.sh/docs/cli/test

```bash
bun test plugins/agent-chat/tests/
# → 363 pass, 2 skip (gated LLM tests), 0 fail
```

Plus three CLI-driven test surfaces that exercise different layers:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" self-test         # 62 hermetic checks (~5s)
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" network-test      # 205 Dot Collector checks at petersen-scale (~3s)
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" llm-smoke         # real claude -p directive parsing (~30-90s, ~$0.05)
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" integration-test  # real cmdRun + real LLM end-to-end (~30-90s, ~$0.05)
```

The suite is organized in four layers:

1. **Unit tests** (`tests/lib.test.ts`) — pure-function coverage of the YAML
   parser, edge canonicalization, neighbor enumeration, section parsing
   (including fractional-seconds timestamp acceptance), fresh-tail splitting,
   summary template + validator, lock-file format, and archive-id generation.
   ~100 tests, sub-second.
2. **Protocol + integration tests** (`tests/protocol.test.ts`,
   `tests/archive.test.ts`, `tests/identity.test.ts`) — drive every
   `scripts/*.ts` CLI as real subprocesses against a tmpdir conversations
   directory. Cover the full turn dance, lock-file safety nets (cross-agent,
   cross-process, cross-host), the seal/commit/condense/search archive flow,
   the validator's anti-theater rules, the agent-chat init/exit/who/gc
   flow, the resume-on-restart offer, and the ten-session-same-cwd case.
3. **Sub-agent integration test** (`tests/subagent-mock.test.ts`) — spawns
   two real OS processes running `tests/fake-agent.ts` (a deterministic
   protocol simulator with no LLM calls), drives N rounds, and asserts the
   resulting CONVO.md has the expected sections in the right order. This
   catches genuine cross-process race conditions and identity-resolution
   bugs that pure unit tests miss.
4. **Sidecar tests** (`tests/sidecar.test.ts`) — 34 tests covering UDS
   dispatcher (whoami / time / health / peek / last-section / unread /
   since-last-spoke / shutdown), `peek` parity with file-direct, fs.watch
   event delivery within ~200 ms of a peer's flip, startup-pending firing
   per actionable edge, protocol-violation emission, lock-stale invariants,
   anonymous + named-persisted cursor flow, since-last-spoke peer-only diff
   with first-turn semantics, full lifecycle (init starts sidecar, exit
   stops gracefully, gc reclaims kill -9 stale state), `--no-sidecar` opts
   out, monitor coexistence with no double-emit, and `CONVERSATIONS_DIR`
   env override for socket + log paths.

A fourth, gated test (`tests/subagent-llm.test.ts`) drives two real
`claude -p` headless sessions through one round-trip. It's **skipped by
default** because real-LLM tests cost API budget per run, are
non-deterministic, and are slow (~30-60s per round). Run it with:

```bash
RUN_LLM_TESTS=1 bun test tests/subagent-llm.test.ts
```

The test infrastructure relies on a single env-var override
(`$AGENT_CHAT_CONVERSATIONS_DIR`) so each test isolates its conversation
state in a tmpdir and never leaks into the real `conversations/` tree.
Topology yaml files are read from `SKILL_ROOT` and shared across tests
(they're stable input).

To add a new test, drop a `*.test.ts` file in `tests/`. The shared
helpers in `tests/helpers.ts` give you `mkTmpConversations()`,
`runScript()`, `sessionEnv()`, and a `freshEnv()` that strips host
`AGENT_*` / `CLAUDE_SESSION_*` variables so resolution behaves
deterministically regardless of who runs the suite.

## Architecture & design history

For the full design rationale — every architectural decision the skill
went through, what we considered and rejected, and the cross-cutting
invariants that survived every round — see
[`ARCHITECTURE.md`](ARCHITECTURE.md). Read top-to-bottom for the
fastest path to understanding *why* the code looks the way it does.

## Files

- **`SKILL.md`** — protocol overview, identity model, file layout, default
  conversation routing. The thing Claude Code loads as the skill spec.
- **`bootstrap.md`** — step-by-step operational checklist. The thing a
  fresh agent reads on first activation.
- **`agents.*.yaml`** — topology manifests. Add your own.
- **`.agent-name.example`** — template for the per-session identity file.
- **`scripts/lib.ts`** — topology loader, identity resolver, edge
  enumerator, atomic-write helpers, pid+starttime fingerprinting, archive
  helpers, summary template + validator, YAML I/O. Adds `LOGS_DIR`,
  `SOCKETS_DIR`, `socketPathFor`, `pidFilePath`, `cursorsFilePath` for
  the sidecar's per-agent paths (all rooted on `CONVERSATIONS_DIR`).
- **`scripts/resolve.ts`** — print my identity + edges + paths.
- **`scripts/turn.ts`** — peek / init / flip / park / lock / unlock /
  recover for one edge. `peek` fast-paths through the sidecar daemon
  with file-direct fallback.
- **`scripts/monitor.ts`** — long-running multi-edge watcher with
  optional `--archive-hint` for parked-and-bloated edges. Polling-based;
  works on every filesystem.
- **`scripts/sidecar.ts`** — long-lived per-agent daemon. Inotify-driven
  watcher (with 5-second reconcile poll for FUSE / WSL1), in-memory diff
  cache, line-JSON-over-UDS dispatcher with eight v1 methods. Auto-launched
  by `agent-chat init`; `--no-sidecar` opts out. Emits monitor-format
  notification lines on stdout (interchangeable with `monitor.ts` for the
  Claude Code Monitor tool wiring).
- **`scripts/sidecar-client.ts`** — async `sidecarRequest` + `isSidecarRunning`
  for any callee that wants the fast path. Returns typed `{ ok, result }` or
  `{ ok: false, error: { code, message } }` so callers don't try/catch.
- **`scripts/agent-chat.ts`** — init / exit / who / gc / whoami / **speaker**
  / **record-turn**. Manages both sidecar and monitor lifecycle; `cmdGc`
  reclaims stale sockets + pidfiles; `cmdWho` shows `mon=`, `side=`, and
  `speaker=` columns; `cmdWhoami` fast-paths through sidecar; `cmdSpeaker`
  + `cmdRecordTurn` are the multi-user transparency primitives.
- **`scripts/archive.ts`** — plan / seal / commit / list leaf archives.
- **`scripts/condense.ts`** — fold same-depth archives into a depth+1
  archive.
- **`scripts/search.ts`** — grep / describe / expand / list across the
  per-edge index.
- **`scripts/llm.ts`** — `runClaude` shell-out + reentrancy sentinel for
  LLM-summarized archives (Round 12 slice 1).
- **`scripts/fts.ts`** — bun:sqlite FTS5 ranked search index over
  archive summaries (Round 12 slice 2).
- **`scripts/expansion-policy.ts` + `scripts/subagent.ts`** — decision
  matrix and citation-bound subagent for `search.ts expand`
  (Round 12 slice 3).
- **`scripts/large-files.ts`** — large-block extraction with
  first-N/last-N preview placeholder (Round 12 slice 2).
- **`scripts/liveness.ts`** — heartbeat schema, parser, format,
  classifier, `StuckReason` union, threshold constants. Single source
  of truth for slices 1-3 of Round 13. Strict version validation
  (refuses missing-or-unknown `sidecar_version`); `STUCK_REASONS`
  pinned by `as const satisfies ReadonlyArray<StuckReason>` to make
  union-vs-array drift a TS build error.

Lines of code: ~5,500+ across all files combined. No npm dependencies.

---

## License

MIT. See [LICENSE](LICENSE).

## Credits

- Protocol design and the `.turn` sentinel pattern authors @eyonland, @tickcode, @claude
- Archive layer architecture (DAG of summaries, fresh-tail protection,
  depth-aware policies, *Expand for details about:* footer, three-tier
  grep→describe→expand escalation): the
  [lossless-claw][lcm] OpenClaw plugin by [Voltropy][voltropy], which
  itself implements the [LCM paper][lcm-paper].
- 10-agent name set (orion, lumeyon, lyra, keystone, sentinel, vanguard,
  carina, pulsar, cadence, rhino) and the Petersen-graph topology
  rationale: the [Celestial Cortex][cc] team's `petersen-v1` agent-comms
  spec.

[voltropy]: https://x.com/Voltropy
[lcm-paper]: https://papers.voltropy.com/LCM
[cc]: https://github.com/lumeyon
