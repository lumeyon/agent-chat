# agent-chat

**N agents. One graph. Real conversations. No daemon, no database, no token ceiling.**

`agent-chat` is a Claude Code / Codex skill that lets multiple AI sessions
collaborate on real work through a shared on-disk protocol — and unlike most
multi-agent frameworks, it's just markdown files and a few hundred lines of
TypeScript. You can read every byte of every conversation with `cat`. You
can grep your entire history with `rg`. You can move it between machines
with `rsync`. And it scales to long-running, branching, multi-week threads
without bloating any single session's context window.

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

**Filesystem-only.** No SQLite, no Postgres, no daemon, no MCP server, no
external service. The entire substrate is markdown + YAML + a one-line
JSONL index per edge. Works on local disk, NFS, sshfs, and any other
mount. Survives reboots. Diffs cleanly. Versions in git like prose.

**Drop-in for any agent runtime.** The protocol is runtime-agnostic. Claude
Code reads it, Codex reads it, an agent script you wrote on a Tuesday reads
it. The skill spec is one `SKILL.md` file; the operational checklist is one
`bootstrap.md` file; the implementation is six TypeScript files totaling
less than two thousand lines.

---

## What you get

| Capability | How |
|---|---|
| **N-agent topology over an arbitrary graph** | YAML manifests (`agents.<topology>.yaml`) declare agents and edges. Petersen, ring, star, and pair ship in the box. |
| **Per-session identity resolution** | `$AGENT_NAME` + `$AGENT_TOPOLOGY` env vars, or a `.agent-name` file in cwd. The skill refuses to guess — silent identity-guessing is what made codex-chat 2-agent-only. |
| **Atomic turn handoff** | `.turn` written via `tmpfile + rename`. Concurrent reads always observe either the old or the new value. |
| **Multi-edge background watcher** | One `monitor.ts` invocation watches every edge the agent participates in. Three independent triggers (value-change, mtime-touch, body-grew) catch every form of "your turn" — including the codex-chat trick of appending then re-parking. Filesystem-agnostic polling, so it works over NFS where `inotify` falls silent. |
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
the multi-edge monitor in the background, and prints the session's
neighbors. Every other script in the skill reads the per-session file
automatically — no env vars, no `.agent-name`, no exports.

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

### 3. The monitor (auto-started by `init`)

`agent-chat init` already started the multi-edge monitor in the
background. Each line it prints to its log becomes one notification you
can tail with:

```bash
tail -F ~/.claude/skills/agent-chat/conversations/.logs/monitor-orion.log
```

The monitor only fires when `.turn` flips to your name, when an edge gets
parked, when `.turn` is rewritten to the same value (peer
appended-then-parked), or when `CONVO.md` grew without a `.turn` flip.

If you need to run it in foreground (e.g. piping to Claude Code's Monitor
tool with `persistent: true`):

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts init orion petersen --no-monitor
bun ~/.claude/skills/agent-chat/scripts/monitor.ts
```

### 4. Take your turn

```bash
SKILL=~/.claude/skills/agent-chat
bun $SKILL/scripts/turn.ts peek lumeyon          # is it my turn? what's the lock state?
bun $SKILL/scripts/turn.ts lock lumeyon          # claim the brief append+flip lock
# ... append your section to the CONVO.md path that `peek` printed.
# Format: `## <agent> — <topic> (UTC ...)\n\nbody\n\n→ <next>`
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

To define a custom topology, drop an `agents.<name>.yaml` file in the skill
root. The validator in `lib.ts` checks every edge's endpoints exist in the
agents list and rejects self-loops.

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

## The archive layer, in more depth

Inspired by the [lossless-claw][lcm] OpenClaw plugin's DAG-based
context-compaction architecture. The skill borrows the design ideas
without inheriting the SQLite/daemon dependencies — everything is
filesystem-only.

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
# → 84 pass, 1 skip (gated LLM test), 0 fail
```

The suite is organized in three layers:

1. **Unit tests** (`tests/lib.test.ts`) — pure-function coverage of the YAML
   parser, edge canonicalization, neighbor enumeration, section parsing,
   fresh-tail splitting, summary template + validator, lock-file format,
   and archive-id generation. ~30 tests, sub-second.
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
  enumerator, archive helpers, summary template + validator, YAML I/O.
- **`scripts/resolve.ts`** — print my identity + edges + paths.
- **`scripts/turn.ts`** — peek / init / flip / park / lock / unlock for
  one edge.
- **`scripts/monitor.ts`** — long-running multi-edge watcher with
  optional `--archive-hint` for parked-and-bloated edges.
- **`scripts/archive.ts`** — plan / seal / commit / list leaf archives.
- **`scripts/condense.ts`** — fold same-depth archives into a depth+1
  archive.
- **`scripts/search.ts`** — grep / describe / expand / list across the
  per-edge index.

Lines of code: ~1,850 across all files combined. No npm dependencies.

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
