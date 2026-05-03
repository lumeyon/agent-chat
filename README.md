# agent-chat

**N agents. One graph. Real conversations. Filesystem-first, no database, no token ceiling.**

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
JSONL index per edge. No external service, no MCP server, no Postgres.
Works on local disk, NFS, sshfs, and any other mount. Survives reboots.
Diffs cleanly. Versions in git like prose. The optional sidecar daemon
(below) is an *accelerator* layered on top — the protocol works without
it; sidecar holds zero protocol authority and is rebuildable from the
filesystem state if it crashes.

**Drop-in for any agent runtime.** The protocol is runtime-agnostic. Claude
Code reads it, Codex reads it, an agent script you wrote on a Tuesday reads
it. The skill spec is one `SKILL.md` file; the operational checklist is one
`bootstrap.md` file; the implementation is fourteen TypeScript files
totaling roughly seven thousand lines, with zero npm dependencies (we use
Bun's built-ins where extras would be tempting).

**Optional fast-path daemon.** `agent-chat init` auto-launches a long-lived
per-agent **sidecar** alongside the monitor: a Unix-domain-socket daemon
serving structured queries (name, time, peek, last-section, unread,
since-last-spoke, health) in a few milliseconds. The sidecar uses inotify
to watch your edges and pre-computes the diff since you last spoke, so a
substantive turn doesn't pay the re-read tax on the full `CONVO.md`. The
file-based wire protocol stays authoritative — the daemon is a pure
accelerator that any runtime can ignore. Cross-runtime by construction:
the IPC is line-delimited JSON, so a Codex sidecar in Python and a Claude
sidecar in TypeScript coordinate through the same socket-and-file shape.
Pass `--no-sidecar` to opt out for CI, debug, or hostile filesystems.

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
| **Per-session identity resolution** | `$AGENT_NAME` + `$AGENT_TOPOLOGY` env vars, or a `.agent-name` file in cwd. The skill refuses to guess — silent identity-guessing is what made codex-chat 2-agent-only. |
| **Atomic turn handoff** | `.turn` written via `tmpfile + rename`. Concurrent reads always observe either the old or the new value. |
| **Multi-edge background watcher** | One `monitor.ts` invocation watches every edge the agent participates in. Three independent triggers (value-change, mtime-touch, body-grew) catch every form of "your turn" — including the codex-chat trick of appending then re-parking. Filesystem-agnostic polling, so it works over NFS where `inotify` falls silent. |
| **Per-agent sidecar daemon** | `scripts/sidecar.ts` runs alongside the monitor (default-on; `--no-sidecar` opts out). UDS at `<conversations>/.sockets/<agent>.sock` with mode 0600 for filesystem-permission auth. Eight v1 methods: `whoami`, `time`, `peek`, `last-section`, `unread`, `since-last-spoke`, `health`, `shutdown` (plus `speaker` for multi-user). Inotify-driven `fs.watch` (debounced 25 ms) replaces polling on local FS with kernel-event ms latency; a 5-second reconcile poll catches misses on FUSE/WSL1. The sidecar holds zero protocol authority — `lock`/`flip`/`park`/`unlock` stay file-direct; the daemon is a pure read-accelerator and notification multiplexer. |
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

### 1. Install as a Claude Code skill

```bash
git clone https://github.com/lumeyon/agent-chat.git ~/git/agent-chat
ln -s ~/git/agent-chat ~/.claude/skills/agent-chat
```

That's it. Claude Code auto-discovers skills under `~/.claude/skills/`.
The repo is the skill — no copy step, no build step, no install command.

For per-project use, symlink it into the project's `.claude/skills/`
directory instead.

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

### 3. The monitor and sidecar (auto-started by `init`)

`agent-chat init` already started both background daemons. Each line the
monitor prints to its log becomes one notification you can tail with:

```bash
tail -F ~/.claude/skills/agent-chat/conversations/.logs/monitor-orion.log
tail -F ~/.claude/skills/agent-chat/conversations/.logs/sidecar-orion.log
```

The monitor fires when `.turn` flips to your name, when an edge gets
parked, when `.turn` is rewritten to the same value (peer
appended-then-parked), or when `CONVO.md` grew without a `.turn` flip.
It writes monitor-format lines to its log and (when wired through Claude
Code's Monitor tool) to chat. Polling-based by default — works on every
filesystem, including NFS / FUSE / sshfs where inotify falls silent.

The **sidecar** is the structured-query fast-path. Talk to it with any
line-JSON-over-UDS client:

```bash
sock=~/.claude/skills/agent-chat/conversations/.sockets/orion.sock
echo '{"id":1,"method":"time"}' | nc -U -q 0 "$sock"
echo '{"id":2,"method":"peek","params":{"peer":"lumeyon"}}' | nc -U -q 0 "$sock"
echo '{"id":3,"method":"since-last-spoke","params":{"peer":"lumeyon"}}' | nc -U -q 0 "$sock"
```

`time` returns ISO + monotonic ns in 1-8 ms (no LLM in the loop).
`since-last-spoke` returns the peer-only diff since you last wrote — so a
substantive turn no longer pays the full-`CONVO.md` re-read tax. The
sidecar uses inotify (`fs.watch`) on the edge directories with a 25 ms
debounce; a 5-second reconcile poll catches misses on filesystems where
inotify under-fires.

If you need the monitor in foreground (e.g. piping to Claude Code's
Monitor tool with `persistent: true`), the cycle is:

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts init orion petersen --no-monitor
bun ~/.claude/skills/agent-chat/scripts/monitor.ts
```

The sidecar's stdout uses the *same* line format as the monitor, so an
advanced setup can attach Claude Code's Monitor tool to the sidecar
instead and skip `monitor.ts` entirely. v1 ships both as defaults; v2
may promote the sidecar to primary chat-notification source.

### 4. Take your turn

```bash
SKILL=~/.claude/skills/agent-chat
bun $SKILL/scripts/turn.ts peek lumeyon          # is it my turn? what's the lock state?
bun $SKILL/scripts/turn.ts lock lumeyon          # claim the brief append+flip lock
# ... append your section to the CONVO.md path that `peek` printed.
# Format: `## <agent> — <topic> (UTC YYYY-MM-DDTHH:MM:SS[.fff]Z)\n\nbody\n\n→ <next>`
bun $SKILL/scripts/turn.ts flip lumeyon lumeyon  # hand off (or `parked`)
bun $SKILL/scripts/turn.ts unlock lumeyon
```

`peek` fast-paths through the sidecar daemon when running (1-8 ms UDS
round-trip vs. several `statSync` + `readFileSync` calls); falls back to
the file-direct path on any sidecar error. Write ops (`lock`/`flip`/
`park`/`unlock`/`recover`) stay file-direct on principle — the sidecar
holds zero protocol authority.

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
bun test
# → 277 pass, 2 skip (gated LLM tests), 0 fail
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

Lines of code: ~3,700 across all files combined. No npm dependencies.

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
