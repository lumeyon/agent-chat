---
name: agent-chat
description: Generic N-agent turn-based markdown chat protocol over an arbitrary graph topology (Petersen, ring, star, pair, etc). Each graph edge is a CONVO.md + CONVO.md.turn file pair; each running session reads its identity from $AGENT_NAME/$AGENT_TOPOLOGY or a `.agent-name` file in cwd, finds its edges, and runs the same lock/flip/park/monitor protocol as codex-chat — but generalized so any number of Claude or Codex sessions can collaborate on a defined graph. Includes a lossless-claw-inspired archive layer (DAG of summary nodes, fresh-tail protection, grep→describe→expand) so long conversations stay cheap to re-read while keeping every word recoverable. Use when the user references "the petersen chat", "the pair chat", a multi-session conversation, an agent-to-agent thread under `~/.claude/skills/agent-chat/conversations/`, asks to send/respond to a named neighbor like "send this to lumeyon" / "what did orion say", or asks to archive / search / condense a long conversation.
---

# agent-chat — generic graph-based agent chat

This skill is the N-agent generalization of `codex-chat`. Where codex-chat
hardcoded two names (`claude` and `codex`) and one shared markdown file,
agent-chat reads a topology manifest, derives the per-session identity at
runtime, and exposes the same `.turn`/lock/park/Monitor protocol on every
edge of an arbitrary graph.

The two-agent codex-chat case is now the degenerate case of this skill:
load `agents.pair.yaml`, the topology has one edge, and the protocol is
identical.

## What lives where

```
~/.claude/skills/agent-chat/
  SKILL.md                     # this file
  bootstrap.md                 # the boot-up checklist a session reads on first activation
  .agent-name.example          # template for the per-session identity file
  agents.pair.yaml             # 2-agent: orion + lumeyon
  agents.petersen.yaml         # 10-agent Petersen graph (15 edges, degree 3, diameter 2)
  agents.ring.yaml             # 10-agent ring (degree 2, diameter 5)
  agents.star.yaml             # 10-agent star centered on orion
  scripts/
    lib.ts                     # topology loader, identity resolver, edge enumerator, atomic .turn write,
                               #   archive helpers (DAG, summary template/validator, index.jsonl I/O)
    resolve.ts                 # CLI: print my identity, my edges, and their conversation paths
    turn.ts                    # CLI: peek / init / flip / park / lock / unlock for one edge
                               #   peek fast-paths through the sidecar daemon when available
    monitor.ts                 # CLI: long-running multi-edge watcher; one stdout line per actionable transition;
                               #   optional `--archive-hint` for parked-and-bloated edges
    sidecar.ts                 # CLI: long-lived per-agent daemon. Inotify-driven watcher, in-memory diff
                               #   cache, UDS at .sockets/<agent>.sock for structured queries (whoami, time,
                               #   peek, last-section, unread, since-last-spoke, health). Auto-launched by
                               #   `agent-chat init`; `--no-sidecar` opts out.
    sidecar-client.ts          # client library: sidecarRequest(agent, method, params); used by other CLIs
                               #   to fast-path read-only ops with file-direct fallback when the sidecar isn't running
    archive.ts                 # CLI: plan / seal / commit / list — leaf archives (depth 0)
    condense.ts                # CLI: plan / seal / commit — fold same-depth archives into depth+1 summaries
    search.ts                  # CLI: grep / describe / expand / list — LCM-style escalation over the index
    liveness.ts                # heartbeat schema + parser/format + classifier + StuckReason union (Round 13)
    llm.ts                     # `claude -p` shell-out + reentrancy sentinel for archive auto (Round 12)
    fts.ts                     # bun:sqlite FTS5 ranked archive search (Round 12)
    expansion-policy.ts        # decision matrix gating direct-grep / summaries-only / expand (Round 12)
    subagent.ts                # citation-bound `claude -p` subagent for `search.ts expand` (Round 12)
  conversations/<topology>/<edge-id>/
    CONVO.md                   # append-only shared transcript for one edge (the "hot file")
    CONVO.md.turn              # single-line sentinel: <agent-id> | parked
    CONVO.md.turn.lock         # transient append+flip lock (file presence is the signal)
    index.jsonl                # one line per archive at any depth — cheap-grep search surface
    archives/
      leaf/<arch_L_...>/       # depth-0 archives: BODY.md (verbatim) + SUMMARY.md + META.yaml
      condensed/d1/<arch_C_...>/  # depth-1: SUMMARY.md + META.yaml (parents = leaf ids)
      condensed/d2/<arch_C_...>/  # depth-2 ... and so on through d3+
  conversations/.sockets/      # per-agent UDS + pidfiles + cursors (mode 0600)
    <agent>.sock               # sidecar UDS endpoint
    sidecar-<agent>.pid        # pidfile (pid + starttime) for crash-recovery
    <agent>.cursors.json       # named-cursor persistence for `unread` calls
  conversations/.logs/         # per-agent log files (rooted on CONVERSATIONS_DIR)
  conversations/.heartbeats/   # per-agent liveness sentinels (Round 13)
    <agent>.heartbeat          # one line: ts host pid starttime sidecar_version (atomic write)
    monitor-<agent>.log
    sidecar-<agent>.log
```

All script paths are resolved relative to the skill root (`SKILL_ROOT` in
`lib.ts` is computed from `import.meta.url`), so the whole `agent-chat/`
folder can be moved into any project's `.claude/skills/` and keep working.

## Identity resolution

Every session must answer two questions before doing anything else:

1. **What is my agent name?** Must be one of the agents declared in the
   chosen topology's yaml.
2. **Which topology am I in?** Must match one of the `agents.<topology>.yaml`
   files in the skill root.

Resolution order (first match wins):

1. **Per-session record** under `conversations/.sessions/<key>.json` where
   `<key>` is `$CLAUDE_SESSION_ID` if set, otherwise the parent shell's pid.
   Written by `agent-chat init` — this is the **preferred path** because
   it scales cleanly to N sessions sharing one cwd.
2. `$AGENT_NAME` and `$AGENT_TOPOLOGY` env vars (both required together).
3. `./.agent-name` in the current working directory:
   ```yaml
   name: orion
   topology: petersen
   ```
4. **None set → stop and ask the user.** Do not guess.

The skill explicitly does *not* infer identity from running-process
heuristics or model-name guessing — those gave us the codex-chat 2-agent
ceiling we are trying to break.

### Many sessions sharing one cwd (preferred path)

Run each session normally and have it run, on its first turn, when the
user states its identity:

```bash
bun scripts/agent-chat.ts init <name> [<topology>]
```

That writes a per-session identity file keyed by `$CLAUDE_SESSION_ID` (or
the parent shell's pid as a fallback). Resolution source #1 finds it
first, so every script in the skill picks up the right identity for that
session without env vars or `.agent-name`. Ten sessions in one cwd just
work — each one ran its own `init`, each one has its own session record.

`agent-chat init` also:

- refuses if another live session already claims that agent name
  (presence file + pid-alive check);
- offers to **resume** the prior identity if the user is restarting in the
  same terminal (matched by cwd + tty, only when the prior pid is dead);
- infers the topology when only one is in use elsewhere on this host;
- auto-launches the multi-edge monitor in the background.

`agent-chat exit` signs the session out (stops the monitor, removes the
session and presence files). `agent-chat gc` sweeps anything stale.
`agent-chat who` lists live and stale sessions on the host.

Env vars and `.agent-name` still work as fallbacks for power users / CI
setups, but the per-session file is the right answer for interactive use
and the only mechanism that's clean at N=10.

Lock files embed `<agent>@<host>:<pid>` so a session can only release the
locks it holds. Two sessions accidentally configured with the same agent
name will still be caught: `unlock` refuses if the recorded `pid` is not
the current process and the holder is still alive.

## Edge identity — alphabetical, deterministic

For an edge between agents `A` and `B`, the edge id is `min(A,B)-max(A,B)`.
This means orion talking to lumeyon and lumeyon talking to orion both
resolve to `conversations/<topology>/lumeyon-orion/`. The scripts compute
this canonicalization for you; never hand-build edge paths in shell.

## When to use this skill

Trigger phrases:

- "send this to <agent-name>" / "respond to <agent-name>"
- "what did <agent-name> say?"
- "is it my turn on the <agent-name> edge?"
- "park the conversation with <agent-name>"
- "what's happening on the petersen graph?"
- any reference to a `CONVO.md` under `~/.claude/skills/agent-chat/conversations/`

## Operations

The full operational protocol — `peek` / `init` / `take` / `flip` / `park` /
`lock` / `unlock`, plus the Monitor wiring — is documented in
[`bootstrap.md`](bootstrap.md). That file is the single source of truth for
what a session actually does step-by-step. Keep this `SKILL.md` for
*shape and convention*; keep `bootstrap.md` for *how to run the protocol*.

A two-line summary of the happy path:

1. **Peek** → confirm `.turn` is your name. **Lock** the edge. **Append**
   your section to `CONVO.md` ending with `→ <peer-or-parked>`. **Flip**
   the turn file. **Unlock**.
2. **Monitor** runs in a separate persistent shell and notifies you the
   instant a peer flips a `.turn` to your name or parks.

### Sidecar fast path (default-on)

`agent-chat init` auto-launches a per-agent **sidecar daemon** alongside the
monitor. The sidecar is a long-lived process that:

- Watches all of this agent's edges via inotify-style `fs.watch` (no
  polling) and emits the same notification format `monitor.ts` does.
- Holds a parsed-section cache so cheap structured queries (name, time,
  current floor-holder, last section, unread sections since a cursor)
  return in a few milliseconds without re-reading CONVO.md.
- Listens on a Unix domain socket at
  `<CONVERSATIONS_DIR>/.sockets/<agent>.sock` (mode 0600, owner-only).
- Speaks **line-delimited JSON** so cross-runtime clients (Codex, Python,
  curl-style tooling) can call methods the same way Claude Code can.

Methods (v1): `whoami`, `time`, `peek`, `last-section`, `unread`,
`since-last-spoke`, `health`, `shutdown`. The protocol stays file-first:
the sidecar only reads the wire-state files; `lock`/`flip`/`park`/`unlock`
remain file-direct so the protocol authority never moves into the daemon.

Pass `--no-sidecar` to `agent-chat init` to disable it (existing flows
work unchanged through the file-direct slow paths).

## Multi-user conversations (`record-turn`)

Humans are registered orthogonally in `agents.users.yaml` and overlaid
onto any AI topology (petersen, ring, star, pair, org) at `loadTopology`
time. The user's identity is auto-resolved by `agent-chat init` from
`$AGENT_CHAT_USER` → `$USER` (if in users.yaml) → users.yaml `default:
true` entry. Explicit `agent-chat speaker <name>` overrides the default.

### Discipline rule (mandatory until `PostResponse` hook ships)

**At the END of every assistant response, the agent MUST run:**

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts record-turn \
  --user "<verbatim user prompt>" \
  --assistant "<verbatim assistant response>"
```

(Or `record-turn --stdin` with JSON `{user, assistant}` for >4KB
payloads — flag args have argv length limits on most shells.)

This is the **only** mechanism that puts the conversation into the
audit trail in v1. Claude Code's `Stop` hook is session-level only;
forgetting record-turn means the turn never lands in CONVO.md and
peer agents grepping `recorded_turns.jsonl` for activity gaps will
notice. See `docs/HOOK_REQUEST.md` for the v2 ergonomic upgrade ask
(a `PostResponse` hook driven by Claude Code itself).

The CLI is idempotent under retry — a second invocation with the
same `(speaker, user, assistant)` triple is a silent no-op. Safe to
call inside hook-retry harnesses or to recover from a partial write.

### To record a Claude Code turn

The agent runs (typically once per response, automatically):

```bash
bun scripts/agent-chat.ts record-turn --user "<text>" --assistant "<text>"
# or, for large payloads:
bun scripts/agent-chat.ts record-turn --stdin   # reads JSON {user, assistant}
```

Reads `current_speaker` (set by `agent-chat speaker <name>`, slice 2)
from session state, computes the alphabetical edge id, and appends a
section pair under the standard lock+append+flip cycle. Idempotent
under retry via per-edge `recorded_turns.jsonl` ledger keyed by
`sha256(speaker + user + assistant)` — repeated calls with the same
payload are silent no-ops.

### Speaker switches and audit trail

When `current_speaker` changes between calls, `record-turn` first emits a
handoff section to the OLD speaker's edge before routing the new turn:

```markdown
## boss — handoff to john (UTC ...)
Heading out; john is taking over this thread.
→ parked
```

The old edge's `.turn` flips to `parked`. The new edge then receives the
user+assistant section pair as normal. The handoff is the audit trail of
who-was-typing-when; the speaker file is live state, the CONVO.md history
is durable.

### v1 hook story

Claude Code's `Stop` hook fires only at session end and delivers no per-
turn payload. Until a `PostResponse` hook ships (see
`docs/HOOK_REQUEST.md`), the agent calls `record-turn` itself at the end
of every response. Agents that forget to call it leave gaps in
`recorded_turns.jsonl` — observable post-hoc by any peer agent.

### Exit codes

`record-turn` uses distinct codes so CLI consumers can discriminate:
`64` = no current speaker, `65` = unknown speaker, `66` = no edge between
speaker and agent (or AI-to-AI misroute), `70` = bad args, `71`/`72` =
lock blocked.

## Section format inside CONVO.md

Identical to codex-chat for cross-compatibility:

```markdown
---

## <agent> — <one-line topic> (UTC YYYY-MM-DDTHH:MM:SSZ)

<body>

→ <next-agent-or-parked>
```

The trailing `→` line is redundant with `.turn` on purpose — it makes the
CONVO.md self-describing when grepped without the sentinel file.

## Locking, atomicity, and parked semantics

Same as codex-chat:

- `.turn` writes are atomic via `tmpfile + rename` (handled by `turn.ts`).
- `.turn.lock` presence means an append+flip is in progress; readers and
  the monitor must skip until it clears.
- `parked` means **neither side has the floor** — never auto-resume; ask
  the user before flipping `parked` back to a name.
- Stale lock recovery requires explicit user confirmation.

## Auto-proceed-on-agreement

The same auto-proceed rule from codex-chat applies on every edge: if a
peer's section ends with a concrete proposed action that you substantively
agree with, the action is reversible/non-destructive, and you have the
resources to do it, just execute it and record the agreement in your reply
section. Escalate to the user on disagreement, on destructive actions, or
on resource gaps.

This rule scales to N agents because each edge is an independent two-party
conversation — auto-proceed is decided per-edge, not globally.

## Relay (non-neighbor routing)

When the topology does not give you a direct edge to your target:

1. `bun scripts/resolve.ts` — list your neighbors.
2. Pick the neighbor most likely to know the target.
3. Open or continue an edge with that neighbor and ask them to forward.
4. The intermediary appends a relay turn on its edge with the target,
   summarizing the ask without changing intent.

For Petersen, every non-neighbor is reachable through exactly one
intermediary (graph diameter = 2). For ring, expect up to 5 hops. For
star, every non-orion pair must go through orion.

## Common pitfalls

- **Forgetting to flip `.turn` after appending.** The peer's monitor never
  fires; the edge silently stalls. Always end with `flip` (or `park`).
- **Editing prior sections written by a peer.** Append-only. Mutating
  somebody else's section is a protocol violation.
- **Two sessions claiming the same agent name.** The skill cannot detect
  this — the user serializes invocations. Treat the lock file as
  best-effort, not a mutex.
- **Auto-resuming a parked edge.** Never silently flip `parked` back to
  your name. Ask the user.
- **Hand-building edge paths.** Always derive via `lib.ts`; alphabetical
  canonicalization is the only thing keeping both sides on the same file.

## Archive layer (LCM-inspired, filesystem-only)

Long conversations would otherwise bloat `CONVO.md` until every turn
re-reads pages of older context that's not relevant. The archive layer
borrows the design that makes the [lossless-claw](https://losslesscontext.ai)
plugin able to keep arbitrarily long context windows cheap:

1. **DAG of summary nodes.** Old `CONVO.md` chunks get sealed into
   *leaf* archives (depth 0). Once enough leaves accumulate on an edge,
   they get folded into *condensed* archives at depth 1, and so on. Each
   depth uses a more abstract policy — d0 preserves details, d1 is
   session-level, d2 is phase-level, d3+ is durable trajectory.
2. **Fresh tail protection.** The last K sections (default 4) of
   `CONVO.md` are *never* archived. They stay verbatim so the next turn
   has continuous recent context.
3. **`Expand for details about:` footer.** Every summary ends with
   exactly that line, listing what was dropped or compressed. This is
   the cheap signal that lets the next agent decide whether walking down
   to `BODY.md` is worth it.
4. **Two-step seal/commit.** `archive.ts seal` freezes the body and
   writes a SUMMARY.md *stub*. The agent fills the stub in conversation
   context. `archive.ts commit` validates the summary against a strict
   schema (every required section present, no leftover TODOs, non-empty
   Keywords, non-empty Expand-for-details) before appending the index
   entry. A failing validator is the same anti-theater rule that
   petersen-v1 enforces for review receipts.
5. **Three-tier search.** `grep` over `index.jsonl` + summaries (cheap)
   → `describe` for a single SUMMARY.md (medium) → `expand` for the raw
   BODY.md or the children of a condensed node (cold). Most lookups stop
   at grep.

The full archive workflow — when to seal, what the SUMMARY.md template
looks like, how to walk leaf→condensed parents, how the validator
behaves — lives in [`bootstrap.md`](bootstrap.md). Every script under
`scripts/` is `bun scripts/<name>.ts --help`-able and self-describing.

## Default conversation paths

If the user references "the pair chat" or "the petersen chat" without
naming a file, default to the matching topology under
`conversations/<topology>/`. The user's session identity (from
`.agent-name` or env) selects which edges within that topology the
session can touch.
