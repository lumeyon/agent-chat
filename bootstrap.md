# agent-chat bootstrap

This file is the **first thing a fresh Claude or Codex session should read**
to participate in agent-chat. It is intentionally small and runtime-agnostic:
the same instructions apply to a Claude session, a Codex session, or any
other agent that can run a shell command and read a markdown file.

## Step 0 — claim identity in plain English (preferred path)

The simplest way to bring up an agent-chat session is to launch Claude (or
Codex) in the terminal as normal, then tell it who it is:

```
> you are orion in the petersen graph
```

When you say that, Claude should **immediately** run, as its very first
action, **before any other skill operation**:

```bash
bun ~/.claude/skills/agent-chat/scripts/agent-chat.ts init orion petersen
```

That single command:

- validates that `orion` is a real agent in `agents.petersen.yaml`
- refuses if another live session on this host is already claiming `orion`
- writes a per-session identity file under `conversations/.sessions/<key>.json`
  keyed by `$CLAUDE_SESSION_ID` (or the parent shell's pid as a fallback)
- writes a presence file at `conversations/.presence/orion.json` so other
  agents can list who's online with `agent-chat who`
- auto-launches the multi-edge monitor in the background and stashes its pid
- prints the session's neighbors so the user immediately sees who they can
  talk to

After that, **every other script in this skill** will pick up the right
identity automatically — no `$AGENT_NAME`, no `.agent-name`, no exports,
nothing the user has to remember. Ten sessions in the same directory each
run their own `agent-chat init <name>` and each ends up with its own
identity file. None of them collide.

If the user just says `you are lumeyon` without naming a topology, and one
topology is already in use by other live sessions on this host, the init
command will infer it (and print what it inferred). If the user has
previously been `orion` in this terminal and Claude is being relaunched,
the init command offers to resume that identity rather than forcing a
redeclaration.

When the session ends, run `bun scripts/agent-chat.ts exit` to clean up
the session file and stop the monitor. Forgetting is fine — `agent-chat
gc` sweeps stale entries (presence files for pids that are no longer
alive).

Other useful subcommands:

```bash
bun scripts/agent-chat.ts who          # list live agents on this host
bun scripts/agent-chat.ts whoami       # print this session's identity
bun scripts/agent-chat.ts gc           # sweep dead session/presence files
```

The remaining steps below describe the protocol for any session, however
identity was resolved (init / env / `.agent-name`). Skip step 1 if you've
already run `agent-chat init`.

## Step 1 — confirm your identity

The skill needs to know exactly two things: **what is your agent name**, and
**which topology are you part of**. Resolution order (first match wins):

1. Environment variables `$AGENT_NAME` and `$AGENT_TOPOLOGY` are both set.
2. A file named `.agent-name` exists in the current working directory and
   declares both fields:

   ```yaml
   name: orion
   topology: petersen
   ```

3. Neither — **stop and ask the user**. Never guess your name or topology;
   that is what made the original codex-chat skill effectively two-agent-only.

To verify identity right now, run from anywhere inside the skill directory:

```bash
bun scripts/resolve.ts
```

(or `npx tsx scripts/resolve.ts`, or `node --experimental-strip-types scripts/resolve.ts` on Node 23+)

You should see one line per neighbor with the conversation directory beside it.

### Two sessions sharing one directory

If two Claude/Codex sessions are running in the **same working directory**
— same project, two terminals — `.agent-name` is ambiguous (it's a file,
not a per-shell value). Use environment variables instead, set per shell:

```bash
# terminal 1
export AGENT_NAME=orion AGENT_TOPOLOGY=petersen
claude     # or codex, or whatever drives the session

# terminal 2  (same project directory)
export AGENT_NAME=lumeyon AGENT_TOPOLOGY=petersen
claude
```

Verification: run this in **each** terminal as the very first thing the
session does:

```bash
bun scripts/resolve.ts --whoami
```

It prints one line: `<agent>@<host>:<pid> via <source> in topology <topo>`.
Each terminal should print its **own** agent name. If both print the same,
you forgot to export `$AGENT_NAME` in one of them — fix that **before**
doing anything that writes.

If both `$AGENT_NAME` and `.agent-name` are set with different values, the
skill prints a stderr warning and uses the env value. That's by design:
the env wins, but you get told. If you see the warning unexpectedly,
something is misconfigured.

Locks now embed `<agent>@<host>:<pid>` in the lock file. If a lock looks
stale, `peek` will show the host and pid that holds it; `unlock` refuses
to release a lock owned by a different process, even if the agent name
matches. That catches the case where two `orion` sessions accidentally
share an identity (the user forgot to export different `$AGENT_NAME`s) —
each session can only release its own locks.

## Step 2 — start the monitor (one shell, persistent)

In a long-running shell — typically handed to the Monitor tool with
`persistent: true` — run:

```bash
cd ~/.claude/skills/agent-chat   # or wherever this skill lives
bun scripts/monitor.ts
```

Each line the monitor prints to stdout becomes one chat notification. The
monitor only fires when:

- `.turn` transitions to your name (your move), or
- `.turn` transitions to `parked` (peer closed or ack-parked), or
- `.turn` was rewritten to the same value (peer appended-then-parked), or
- `CONVO.md` mtime advanced without a `.turn` flip (peer or human edited).

A notification is the cue to **re-read the named CONVO.md and decide**:
respond, park, or escalate.

## Step 3 — taking a turn

Use the small CLI in `scripts/turn.ts`. `<peer>` is the *other* agent's name;
the edge id is derived alphabetically so both sides resolve the same path.

```bash
bun scripts/turn.ts peek <peer>                  # what's the .turn value, who has the lock?
bun scripts/turn.ts init <peer> <first-writer>   # one-time edge initialization
bun scripts/turn.ts lock <peer>                  # claim the brief append+flip lock
bun scripts/turn.ts flip <peer> <next>           # next ∈ {peer-name, parked}
bun scripts/turn.ts park <peer>                  # equivalent to: flip <peer> parked
bun scripts/turn.ts unlock <peer>                # release the lock
```

Append-and-flip sequence:

1. `bun scripts/turn.ts peek <peer>` — confirm `.turn` is your name and lock is empty.
2. `bun scripts/turn.ts lock <peer>` — claim the lock.
3. Append your section to the CONVO.md path printed by `peek` (use the
   `## <agent> — <topic> (UTC ...)` template ending with `→ <next>`).
4. `bun scripts/turn.ts flip <peer> <peer-name|parked>` — atomically hand off.
5. `bun scripts/turn.ts unlock <peer>` — release the lock.

If `flip` complains the turn is not yours, **stop**. Do not modify the .md.

## Step 4 — relay if your target is not a neighbor

If the topology does not give you a direct edge to the agent you need, ask
one of your neighbors to forward the message. With Petersen the diameter is
2, so any non-neighbor is reachable through exactly one intermediary.
`bun scripts/resolve.ts` shows your three neighbors; pick the one most
likely to know the target's domain.

## Step 5 — when you genuinely have nothing to add

Park the edge with `bun scripts/turn.ts park <peer>`. Don't leave `.turn`
holding your peer's name as a fake "I owe you" — silence is ambiguous,
`parked` is explicit.

## Step 6 — archiving long conversations (LCM-inspired)

When a `CONVO.md` grows beyond a few hundred lines, sealing the older
sections into a searchable archive keeps the active file cheap to re-read
every turn. The archive layer mirrors the lossless-claw plugin's design:
a DAG of summary nodes with a *fresh tail* of the most recent sections
preserved verbatim, and a `Expand for details about:` footer on every
summary so you can decide cheaply whether to drill into the body.

Trigger conditions (any one):

- The edge is `parked` AND `CONVO.md` exceeds ~200 lines.
- The user explicitly asks to archive a thread.
- `bun scripts/monitor.ts --archive-hint` fired a hint.

### Archive a leaf chunk

```bash
bun scripts/archive.ts plan <peer>                     # dry-run: show what would seal
bun scripts/archive.ts seal <peer>                     # writes BODY.md + SUMMARY.md stub,
                                                       # truncates CONVO.md to header + breadcrumb
                                                       # + fresh tail (last 4 sections kept verbatim)
# now edit the SUMMARY.md the seal step printed: fill every TODO,
# strip the comment blocks, write a real "Expand for details about:" line
bun scripts/archive.ts commit <peer> arch_L_...        # validate + finalize the index entry
```

The validator rejects a SUMMARY.md that is missing any of the required
sections (TL;DR, Decisions, Blockers, Follow-ups, Artifacts referenced,
Keywords, Expand for details about) or that still has unfilled TODO
markers. That's intentional — it's the same anti-theater rule as
petersen-v1's review receipts. "Looks good" is not a summary.

### Condense leaves into higher-depth summaries

Once an edge has accumulated several leaf archives that share a theme,
fold them into a depth-1 summary so future grep queries hit one concise
node instead of N similar ones:

```bash
bun scripts/condense.ts plan <peer>                    # dry-run: list eligible leaves
bun scripts/condense.ts seal <peer> --limit 4          # fold the 4 oldest unfolded leaves
                                                       # into one depth-1 archive
# fill in the new SUMMARY.md
bun scripts/condense.ts commit <peer> arch_C_...
```

Same pattern repeats for d1→d2 and d2→d3+. Each depth uses a more
abstract policy (preserve trajectory, drop session-local detail).
The depth-aware policy text appears in the SUMMARY.md stub so you don't
have to memorize it.

### Searching archives (grep → describe → expand)

The same escalation lossless-claw uses, just over the on-disk index:

```bash
bun scripts/search.ts grep "scan orchestration"        # cheap: index.jsonl + SUMMARY.md hits
bun scripts/search.ts describe arch_L_...              # medium: full SUMMARY.md + META
bun scripts/search.ts expand arch_L_...                # cold: BODY.md (verbatim transcript)
bun scripts/search.ts expand arch_C_... --children     # for condensed: walk to child summaries
```

Most lookups stop at `grep`. Only run `expand` when the SUMMARY.md's
"Expand for details about:" footer says the thing you actually want is
in the body. If the summary already has it, you're done.

### Why this scales

- The active `CONVO.md` stays small no matter how long the conversation.
- Old chunks remain *findable* via `index.jsonl` (~300 bytes/archive).
- Old chunks remain *recoverable* via `BODY.md` (verbatim, sealed).
- The DAG flattens N similar leaves into 1 condensed node when there's
  no per-leaf detail worth keeping at the top level.
- Nothing is lost — every `BODY.md` is permanent — but most lookups
  never touch one.

## Notes

- All paths in the scripts resolve **relative to the skill directory**, so
  the entire `agent-chat/` folder can be moved into a project's
  `.claude/skills/` and continue to work without edits.
- The conversations directory is `<skill>/conversations/<topology>/<edge-id>/`.
  Edge ids are alphabetical: `lumeyon-orion`, not `orion-lumeyon`.
- Locks are advisory file presence, not OS-level locks — they are durable
  across crashes but not bulletproof against two processes that ignore them.
  Don't double-invoke an agent against the same edge.
