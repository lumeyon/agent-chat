# Architecture & Design Decisions

This document records the architectural decisions behind `agent-chat`,
in roughly the order they were made, with the reasoning for each. It's
a living artifact — when a future change reverses one of these
decisions, edit the relevant section in place rather than appending a
revisions log, so the file always describes the *current* state.

The skill went through eleven design rounds, each surfacing a problem
the previous round couldn't anticipate. Reading this top-to-bottom is
the fastest way to understand why the code looks the way it does.

---

## Round 1 — Generalize codex-chat to N agents on a graph

### Starting point

The [`codex-chat`][codex-chat] skill is a two-agent turn protocol:
Claude and Codex append sections to a shared markdown file
(`CONVO.md`), with a one-line `.turn` sentinel naming whose move it
is. That works for two named agents but bakes the names directly into
the skill — `claude` and `codex` are hardcoded values for `.turn`.

[codex-chat]: https://docs.claude.com/en/docs/claude-code/sub-agents

### Decision

Generalize to **N agents on an arbitrary graph topology**, where each
graph edge is an independent two-party CONVO.md+.turn pair. The
topology is data (`agents.<name>.yaml`); the protocol is a single
file-locking dance shared across all edges.

### Why a graph instead of all-to-all?

Two failure modes of unbounded all-to-all multi-agent communication:

1. **Chat-room collapse.** Signal-to-noise drops as N grows. Every
   agent gets every other agent's chatter.
2. **Coordination bottleneck.** Frameworks that try to fix #1 grow a
   coordination layer (router, broker, scheduler) that becomes its own
   correctness and performance problem.

A bounded graph fixes both. With Petersen specifically (10 nodes, 15
edges, degree 3, diameter 2), every agent has exactly three direct
neighbors and any non-neighbor is reachable through one intermediary.
The blast radius of a chatty agent is bounded to its three neighbors.

### What we rejected

- **Hardcoding Petersen into the skill.** The graph is a configuration
  of the protocol, not the protocol. Pair (2 agents), ring, star, and
  arbitrary topologies all use the identical `.turn`/`CONVO.md` dance.
  The skill ships four topologies (`agents.pair.yaml`,
  `agents.petersen.yaml`, `agents.ring.yaml`, `agents.star.yaml`); users
  add their own by dropping a yaml file in the skill root.
- **Inferring identity from process heuristics or model-name guessing.**
  Tempting (`hostname`, `pid`, parsing `claude --version`), but every
  heuristic breaks for someone. The skill explicitly refuses to guess —
  silent identity-guessing is exactly what made codex-chat 2-agent-only.
  See Round 5 for how the explicit-identity invariant ended up being
  satisfied without user friction.

### How edges are addressed

For agents `A` and `B`, the edge id is `min(A,B)-max(A,B)` (alphabetical
sort). This means orion talking to lumeyon and lumeyon talking to orion
both resolve to `conversations/<topology>/lumeyon-orion/`. The
canonicalization happens in `lib.ts edgeId()`; scripts never hand-build
edge paths.

### Why filesystem-only?

No SQLite, no daemon, no MCP server, no external service. The substrate
is markdown + YAML + JSONL. This means the skill:

- works on local disk, NFS, sshfs, CIFS, or anywhere a filesystem mounts;
- diffs cleanly in `git`;
- versions in source control like prose;
- is auditable (`cat` works on every artifact);
- has no build step and no dependency surface (zero npm packages).

The cost is that we do polling instead of `inotify` (which silently
emits zero events on NFS/FUSE/sshfs); the skill explicitly chose
correctness over efficiency on this axis.

---

## Round 2 — Lossless conversation archives, inspired by lossless-claw

### Starting point after Round 1

The basic protocol worked but had no answer for *long* conversations.
A `CONVO.md` that grows past ~1000 lines makes every turn re-read pages
of older context, most of which is no longer relevant.

### Decision

Add an **archive layer**: a per-edge DAG of summary nodes with a
*fresh tail* of recent verbatim sections, where most lookups stop at a
cheap grep over the index, drilling to body text only when needed.

The design is directly inspired by the [lossless-claw][lcm] OpenClaw
plugin, which uses the same DAG-with-fresh-tail architecture to give
Claude effectively unlimited context-window memory. We adopted the
pattern; we did **not** adopt the SQLite/daemon dependencies, because
filesystem-only is a load-bearing skill invariant (Round 1).

[lcm]: https://losslesscontext.ai

### How it works

```
conversations/<topology>/<edge-id>/
  CONVO.md              # hot file: append-only, fresh tail kept verbatim
  CONVO.md.turn         # sentinel
  index.jsonl           # cheap-search surface, one line per archive
  archives/
    leaf/<arch_L_…>/    # depth 0: BODY.md (verbatim) + SUMMARY.md + META.yaml
    condensed/d1/<…>/   # depth 1+: SUMMARY.md + META.yaml (parents = leaf ids)
```

**Leaf archives** seal the prefix of CONVO.md (everything before the
fresh tail). The agent fills in a SUMMARY.md *stub* from a depth-aware
template; commit validates the result before appending the index entry.

**Condensed archives** (depths 1+) merge several same-depth siblings
into a higher-level node using a more abstract policy at each depth:
d0 (segment) → d1 (session) → d2 (phase) → d3+ (durable trajectory).
Bidirectional links (parents on condensed, body_sha256 on leaves) let
search walk up *or* down the DAG.

### What we adopted from lossless-claw

| LCM concept | agent-chat implementation |
|---|---|
| DAG of summaries (leaf→condensed) | `archives/leaf/` and `archives/condensed/d{1,2,3}/` per edge |
| Fresh tail protection | last K=4 sections of CONVO.md kept verbatim, never archived |
| Three-level escalation | normal/aggressive/fallback policies in `depthPolicy()` |
| `Expand for details about:` footer | mandatory section, validator rejects empty |
| `descendantCount` | summed transitively at condense time, stored in META + index |
| grep → describe → expand escalation | `search.ts` subcommands over index.jsonl + summaries + bodies |
| Bidirectional summary↔source links | `body_sha256` on leaves, `parents:` on condensed |

### What we adapted to skill constraints

- **No SQLite.** The flat search surface is `index.jsonl` (~300 bytes
  per archive, append-only, ripgrep-friendly). Filesystem-native.
- **No LLM-from-script.** The summarizer is the calling agent itself.
  `archive.ts seal` produces a stub embedding the source text inline
  in an HTML comment; the agent fills it in conversation context;
  `archive.ts commit` validates the result. This avoids spawning a
  child LLM call from inside a CLI script and avoids any provider
  dependency at the skill level.
- **Two-step seal/commit.** Separates the destructive operation
  (truncating CONVO.md) from the index update, so a failing validator
  doesn't leave the index in a corrupt state.

### Why a strict validator instead of "trust the agent"?

The validator rejects a SUMMARY.md missing any required section
(TL;DR, Decisions, Blockers, Follow-ups, Artifacts, Keywords,
"Expand for details about"), with leftover TODO markers, or with
empty Keywords / Expand-for-details. This is the same anti-theater
rule the petersen-v1 spec enforces for review receipts: "looks good"
is not accepted as a summary.

The discipline costs the agent a few seconds per archive but prevents
a worse failure mode: an index full of vague summaries that don't
actually compress anything. Once that happens, you've lost the value
of archiving — the index becomes noise, not signal.

### What we rejected

- **Auto-archiving on a timer.** Triggers should align with conversation
  boundaries, not clock cuts. We trigger off explicit signals: park +
  size threshold, user request, or a `--archive-hint` notification from
  the monitor.
- **Indexing BODY.md by default.** That re-creates the long-context
  problem we're trying to escape. Bodies are the cold path; summaries
  are the search target. `search.ts grep` only walks bodies if you ask
  for `--scope summaries` and bodies — never automatically.
- **Embeddings.** Plain keyword + ripgrep over summaries gets you 95%
  of the way. We add a vector column to `index.jsonl` only if and when
  measured summary recall fails — not on speculation.

---

## Round 3 — Open-source the skill and add a real README

### Decision

Move the skill from `~/.claude/skills/agent-chat/` (private installation)
into `/data/boss/git/agent-chat/` (an open-source repo with MIT license),
and replace the original location with a symlink. Add a `README.md` that
sells the value proposition and walks new users through setup.

### Why?

Three reasons:

1. **Versionability.** The skill is now ~3000 lines across docs and
   scripts. It deserves git history, PRs, and an issue tracker.
2. **Sharability.** The point of generalizing codex-chat was to make
   N-agent collaboration accessible. That doesn't happen if the skill
   only exists in one user's home directory.
3. **Per-project use.** Other projects can `git clone` and symlink into
   their own `.claude/skills/`, picking up new commits with `git pull`.

### Why a symlink instead of a copy?

`SKILL_ROOT` in `lib.ts` is computed via `import.meta.url`, which
resolves through symlinks to the real file location. The skill behaves
identically whether the user accesses it through `~/.claude/skills/` or
through the repo path. A copy would diverge the moment someone edited
in one place and not the other.

The trade-off: Windows-without-developer-mode can't create symlinks
without admin privileges. Documented as a known limitation; copy is a
fine fallback there.

---

## Round 4 — Two sessions sharing one repo

### Problem surfaced

Up through Round 3, identity was tied to the working directory via the
`.agent-name` file. That assumed one cwd → one agent. Two Claude
sessions both `cd`'d into `/data/boss/git/foo` would both read the same
`.agent-name` and both think they were (say) `orion`.

### Decision

Demote `.agent-name` to a fallback resolution source; promote
`$AGENT_NAME` + `$AGENT_TOPOLOGY` env vars to the recommended path for
shared-cwd setups. Add three safety nets:

1. **Conflict warning.** If both env vars and `.agent-name` are set
   with different values, log a stderr warning naming both and use the
   env value.
2. **Lock file format upgrade.** Locks now embed `<agent>@<host>:<pid>`
   instead of just `<agent>`. `unlock` refuses to release a lock owned
   by a different live process, even if the agent name matches.
3. **`resolve.ts --whoami`** — compact one-line identity check users
   can run in each terminal to confirm they didn't forget to export.

### Why env vars instead of process-introspection?

Env vars are exactly the right scope: per-shell, inherited by every
script the session runs, no daemon required. Alternatives we considered:

- **`tty`/`SSH_TTY`/`CLAUDE_SESSION_ID` heuristics.** Whatever heuristic
  we picked would break for someone. Re-introduces the silent-guessing
  failure mode. (Note: in Round 5 we *did* end up using
  `CLAUDE_SESSION_ID`, but explicitly declared by the user via
  `agent-chat init`, not silently inferred.)
- **`.agent-name.<pid>`.** Tempting, but every shell command spawns a
  new pid. The right unit is "the shell session," and that maps to
  env vars, not pids.
- **`--agent <name>` flag on every script.** Adding a flag to `turn.ts`,
  `archive.ts`, etc. invites the "I forgot to pass it" bug class. Env
  is set once per shell, inherited automatically.

### How strict is the lock-file pid check?

The strictness was tuned in two passes:

- **First attempt:** require pid to match exactly. *Broke the normal
  flow* because every `bun` invocation gets a fresh pid; `lock` then
  `unlock` from two separate shell commands always fails.
- **Final design:** allow unlock if the lock-holder pid is the current
  pid OR if the lock-holder pid is dead. Refuse if same agent name +
  same host + different live pid (the misconfig case). Refuse on
  cross-host lock ownership unconditionally.

The five-case smoke test now covers: normal flow, cross-agent refused,
same-agent-live-other-pid refused, same-agent-dead-pid stale recovery,
cross-host refused.

---

## Round 5 — Ten sessions sharing one repo, no env-var fiddling

### Problem surfaced

Round 4's env-vars-per-shell solution scales to two sessions but is a
near-certain footgun at ten. The user has to remember to
`export AGENT_NAME=...` in every terminal, and forgetting once causes
two sessions to silently share an identity. The Round 4 safety nets
catch the *symptom* (lock conflicts, mismatch warnings) but not the
*cause* (forgetting to export).

### Decision

Add a per-session identity file written by Claude itself on its first
turn after the user declares identity in plain English. Drop a single
shell command into the bootstrap instructions:

```
> you are orion in the petersen graph
[Claude runs `bun scripts/agent-chat.ts init orion petersen` automatically]
```

That writes `conversations/.sessions/<key>.json` keyed by Claude's
session id (`$CLAUDE_SESSION_ID` or `$CLAUDE_CODE_SESSION_ID`), with
the parent shell's pid as a fallback. `lib.ts resolveIdentity()` now
checks this session file *first*, before env vars and `.agent-name`.

### Why the session file as top-priority resolution source?

Per-session identity is the only mechanism that:

1. scales cleanly to N sessions sharing one cwd (each session has its
   own file, no shared state to disambiguate);
2. requires zero shell-level setup (no `export`, no wrapper script);
3. survives across script invocations (env vars don't propagate
   across separate `bun` calls automatically — each gets its parent's
   env, but they all read the same session file);
4. integrates with how Claude actually runs (the user types prose,
   Claude executes a single command, done).

The user never thinks about identity bookkeeping. They just say
*"you are orion"* and the rest of the skill knows.

### Why we still preserved env vars and `.agent-name` as fallbacks

CI/CD pipelines, scripted demos, and power users who prefer explicit
shell config still benefit from those mechanisms. Three layers of
resolution (session → env → file) cost nothing and serve real users.

### What `agent-chat init` does

In one command:

1. Validates `<name>` is in `agents.<topology>.yaml`.
2. Refuses if another live session already claims that name (presence
   file + pid-alive check). User can pass `--force` if they're
   certain the prior session is dead.
3. Offers **resume** if the same terminal previously hosted an agent
   (matched by cwd + tty, only when the prior pid is dead). The user
   restarts Claude in the same terminal; init proposes reusing the
   prior identity rather than asking for a redeclaration.
4. **Infers topology** when only one is in use elsewhere on the host.
   Saves typing for sessions 2..N.
5. Auto-launches the multi-edge monitor in the background, logging to
   `conversations/.logs/monitor-<agent>.log`. Stashes the monitor pid
   in the session record so `agent-chat exit` can stop it cleanly.
6. Writes both a session record (`.sessions/<key>.json`) and a
   presence record (`.presence/<agent>.json`) so other sessions can
   list who's online with `agent-chat who`.

### Cleanup

- `agent-chat exit` — explicit sign-out: stops the monitor, deletes
  the session and presence files.
- `agent-chat gc` — sweeps anything whose pid is dead. Safe to run
  any time; idempotent.
- Forgetting either is fine: every consumer of the presence file does
  a `pidIsAlive(pid)` check, so stale entries never block live
  sessions.

### What we rejected

- **Auto-detecting identity from the user's prose.** Parsing "you are
  X" out of the user's message would put the skill back in
  silent-guessing territory. We make the user say it explicitly and
  have *Claude* act on the explicit statement, which keeps the
  invariant intact.
- **Modifying shell env vars from `init`.** A child process can't set
  parent shell env portably, and trying creates more confusion than
  it removes. Session files are the right scope.
- **A bash launcher script.** Tempting for ergonomics, but TypeScript
  was specifically requested for Windows compatibility (no bash
  required on Windows by default). The TS launcher is the same
  ~300 lines either way.
- **One central monitor for all agents on the host.** Premature
  optimization that breaks "any session can come and go
  independently." With per-session identity files and the existing
  per-edge monitors, ten lightweight monitors is genuinely fine.
  Ten 1-ms-of-CPU processes is not a real problem.

---

## Round 7 — Test strategy

### Decision

Add three layers of automated tests, with real-LLM tests gated behind an
opt-in env var. Use Bun's built-in test runner so the suite has zero
external dependencies and matches the rest of the skill's
no-build-step-no-npm-deps invariant.

The three layers:

1. **Unit tests** (`tests/lib.test.ts`) — pure functions in `lib.ts`.
   Sub-second, deterministic, no I/O.
2. **Protocol + integration tests** (`tests/protocol.test.ts`,
   `tests/archive.test.ts`, `tests/identity.test.ts`) — drive every
   `scripts/*.ts` CLI as a real subprocess against a tmpdir. Catches
   anything pure-function tests miss: subprocess composition, file
   permission/atomicity, the actual error messages users will see.
3. **Mock sub-agent integration test** (`tests/subagent-mock.test.ts`
   plus `tests/fake-agent.ts`) — spawns two real OS processes running
   a deterministic protocol simulator (no LLM). Catches cross-process
   race conditions, lock-file integrity under concurrent writers,
   identity-via-session-file resolution under fork/exec.

A fourth, opt-in layer (`tests/subagent-llm.test.ts`) drives two real
`claude -p` headless sessions through one round-trip. Gated behind
`RUN_LLM_TESTS=1` and not part of CI by default.

### Why mock sub-agents instead of real Claude by default

Real Claude sub-agents (via the SDK or `claude -p`) seem like the
ideal way to test "does it actually work end-to-end." In practice they
have four properties that disqualify them from a default test path:

1. **Cost.** Each round-trip burns API budget. A test suite that runs
   on every commit can't depend on tokens.
2. **Non-determinism.** Real Claude output varies. Tests would have
   to assert on loose properties ("a section was written") rather
   than precise content, which catches less and is more flaky.
3. **Speed.** A single LLM round-trip takes 30-60 seconds. Multiply
   by N tests and CI grinds.
4. **Secrets.** Running them in CI requires plumbing API keys. That's
   a real operational tax for a skill that's supposed to be
   trivially adoptable.

Mock sub-agents get 95% of what real-LLM tests would catch — race
conditions, identity collision, file protocol — without paying any of
those costs. The gated real-LLM test exists for the remaining 5%
(does Claude actually obey `bootstrap.md`?) and runs only when a
maintainer explicitly opts in before a release.

### What we explicitly don't test

- **Topology yaml files themselves.** They're stable inputs; the
  validator in `loadTopology` will catch malformed ones at runtime,
  and adding "test that petersen has 15 edges" provides no signal —
  it just couples the test suite to a configuration choice.
- **The exact wording of stderr error messages.** We test that errors
  *occur* and that the message *contains* the relevant keyword
  (e.g., "refuse to flip"). Asserting on exact strings makes tests
  brittle without catching meaningful bugs.
- **Wall-clock timing of the monitor.** The monitor's 2s poll is a
  default that users tune. Tests use `--once` or shorter intervals.

### Two infrastructure decisions worth recording

**`$AGENT_CHAT_CONVERSATIONS_DIR` env override.** Tests need to isolate
to a tmpdir without polluting the real `conversations/` tree. Adding a
small env-var override in `lib.ts` (default unchanged) gave us that
isolation in five lines of code, vs. the alternatives (snapshot/restore
between tests, or refactoring SKILL_ROOT plumbing).

**Scrubbed env in `freshEnv()`.** The host environment may have
`$AGENT_NAME`, `$CLAUDE_SESSION_ID`, etc. set from real usage. Tests
strip those before spawning subprocesses so resolution behaves the
same regardless of who runs the suite. Without this, a test that
passes on the maintainer's machine could fail in CI for reasons that
have nothing to do with the code.

---

## Round 8 — Hardening audit

### Problem surfaced

The petersen graph's first heavyweight integration test (a 9-agent
hardening audit driven by orion through carina / lumeyon / keystone, who
each fanned out to two more peers) surfaced a class of bugs that pure
unit tests had missed: pid recycling defeating `pidIsAlive`, multi-host
gc unlinking other hosts' state, monitor restart blindness (an agent who
restarts mid-conversation never gets notified about the floor they
already hold), validator escapes, fenced-code section-parse confusion,
torn reads on a growing `index.jsonl`, archive seal racing with itself,
and several smaller ergonomic gaps.

### Decision

Land the audit's findings as five paired commits (P0 / P1 / P2 / P3 plus
a P3 cleanup), each shipping with regression tests:

- `pidStarttime` + `processIsOriginal` — pid+starttime fingerprinting
  defeats pid recycling. `SessionRecord` and lock-file body both gain
  the starttime field; legacy 3-tuple locks parse alongside the new
  4-tuple for one release.
- macOS marker-walk in `stableSessionPid()` (Linux's /proc walk had
  no macOS equivalent; throwaway-shell-pid every Bash() under Claude
  Code on macOS would have made every lock look stale to itself
  without this).
- Lock turn-holder invariant in `turn.ts lock` — only the floor-holder
  may take the lock, preventing squat-DoS by a non-holding peer.
- `flip` / `park` mirror `unlock`'s session-pid match, closing
  asymmetric-defense surface.
- Atomic CONVO.md truncate + fsync(BODY.md) before truncation in
  `archive.ts seal` — destroying the source has to be the last
  destructive op, after the archive is durable.
- Concurrent-gc crash fix — a `safeUnlink` helper that tolerates a
  peer-gc having already removed a presence file (`safeUnlink` returns
  false on ENOENT; raises everything else).
- Multi-host gc skip — `if (rec.host !== os.hostname()) continue` at
  every gc decision point.
- Monitor: startup-pending pass (S-HIGH-1), lock-stale detection
  (S-HIGH-2), protocol-violation:peer-appended-without-flip emission
  (carina Q4a).
- Validator hardening (vanguard's drop-in rewrite): fenced-code-block
  strip, `REQUIRES_REAL_BODY` set on TL;DR/Decisions/Keywords/Expand-for-details,
  broadened placeholder regex, line-anchored heading match, escapeRegex
  on heading names.
- `parseSections` fence-aware (keystone #2): `## fake` inside a fenced
  code block no longer splits a section.
- `readIndex` torn-read pair (rhino #2/#3): `readIndexSnapshot` opens
  the file, fstat-bounds the read to the open-time size, then per-line
  try/catch handles any residual torn trailer.
- `turn.ts recover --apply` — read-only-by-default crash recovery:
  reconstructs the intended flip from the trailing `→ X` arrow when
  a session crashed between append and flip.
- NFSv3 probe-warn at init time.
- Round-2 follow-up (`7cbf5b1`): half-set env vars throw,
  `findResumableSession` sorts by recency, `writeFileAtomic` for
  session/presence files.

### Why the hardening audit was the right shape

A single agent reading the code top-to-bottom would have caught some of
these, but not the cross-cutting class. The graph topology (10 agents,
diameter 2, every audit slice owned by a different agent) created
genuine independent verification: carina and lumeyon both surfaced the
pid-recycling flaw from different angles; keystone and vanguard both
caught fenced-code parsing failures; rhino and cadence independently
diagnosed the index-torn-read race. The agreement-across-independent-
audits is the signal that converted "speculative concern" into
"merge it." Reading any single file gave you the receipt for one
finding; reading the cross-edge consolidations gave you the topology.

### What we explicitly didn't do

- **Lock-body wire-format flag day.** The 4-tuple lock-body addition
  parses alongside the legacy 3-tuple for one release. Mixed-version
  sessions Just Work; no coordinated restart needed.
- **Auto-update of long-lived monitors.** A monitor process holds the
  pre-fix `monitor.ts` in memory; we documented the cycle recipe
  (`agent-chat exit && init`) rather than building a self-restart
  primitive. Cycling is rare enough that the operational cost is
  trivial; auto-restart adds a class of "did the new code start?" bugs
  that are worse than the cycle.

---

## Round 9 — Per-agent sidecar daemon (active queries + inotify + diff cache)

### Problem surfaced

A 10-agent latency-instrumented poll measured wall-clock decomposition:
**~85-90% of round-trip is LLM compose**, ~5-10% is monitor polling,
~5% is file I/O. Per-leaf compose for a structured reply: 9.8-13.5 s
(the bare Claude Code turn floor). Relay-side compose for two sub-asks
back-to-back: 60-95 s (the largest single span). Propagation per hop:
1-4 s within the 2-second monitor poll budget.

The fundamental problem: an LLM-driven session is overkill for cheap
structured queries (name, time, who's online, last section, what's
new since I last spoke), AND every substantive turn pays a re-read tax
on the full `CONVO.md`.

### Decision

Add `scripts/sidecar.ts` — a long-lived per-agent daemon — alongside
the existing `monitor.ts`. Same wire format, much better compute layer.
Three independent benefits:

1. **Active structured-query interface over Unix domain socket.** UDS
   at `<conversations>/.sockets/<agent>.sock` (mode 0600 for
   filesystem-permission auth). Eight v1 methods: `whoami`, `time`,
   `peek`, `last-section`, `unread`, `since-last-spoke`, `health`,
   `shutdown`. Wire format: line-delimited JSON. Cross-runtime by
   construction (Codex sidecars in any language can speak the same
   protocol).
2. **Inotify-driven notification.** `fs.watch` on the edge directories
   (directory-level, not per-file — survives atomic tmp+rename writes
   on Linux, which `monitor.ts` relies on for `.turn` updates) with a
   25 ms debounce. Replaces 2-second polling with kernel-event ms
   latency. A 5-second reconcile poll catches misses on
   FUSE / WSL1 / coarse-mtime mounts where `fs.watch` silently
   under-fires.
3. **Pre-computed diff cache.** Per-edge in-memory `Section[]` updated
   on every debounced inotify fire. The `since-last-spoke` method
   walks back to the caller's last self-section and returns only what
   the peer has appended since — eliminating the "re-read 600 lines of
   CONVO.md every turn" tax.

### What this delivers (measured on a 10-agent rollout)

- **Name+time-class polls**: ~3 min → ~1-8 ms (LLM bypassed via UDS).
  Measured across 9 cycled sidecars: keystone 1-2 ms, carina 2 ms,
  lumeyon 3 ms, sentinel 5 ms, cadence 7 ms, lyra 8 ms.
- **Substantive turns**: `since-last-spoke` returns peer-only diff;
  exercised in production the same day by lumeyon, who used it three
  times in a single turn to fold sentinel + lyra GREENs without
  re-reading either CONVO.md.
- **Notification latency**: 1-4 s polling → kernel-event ms.
- **Peer→relay propagation asymmetry from round-2 dramatically reduced**:
  the sidecar absorbs notifications outside the LLM session's
  foreground tool-call queue, so a relay mid-compose doesn't block
  notification delivery for sub-replies on its other edges.

### Why a sidecar instead of an Agent SDK orchestrator?

The dramatic alternative was: replace one-Claude-Code-session-per-agent
with a single orchestrator process driving N parallel `messages.create()`
calls via the Anthropic SDK. That collapses serial-session compose into
parallel-API compose and lets prompt caching amortize the shared CONVO.md
prefix across all agents. Estimated impact: round-2's ~3:45 → ~20-40 s.

We rejected it because it kills the cross-runtime invariant. The
agent-chat protocol's whole point is that Claude sessions, Codex
sessions, and arbitrary future agent runtimes coordinate through a
shared file format. An Agent-SDK-based orchestrator can only drive
Anthropic models. The sidecar gets most of the dramatic latency win
(3 orders of magnitude on cheap queries; 3-5× on substantive turns
through the diff cache) while preserving the file-based wire format
exactly. Codex can ship its own sidecar in Python tomorrow and interop
trivially.

### Why per-agent instead of host-wide?

Lifecycle binding. Per-agent gives clean coupling to `agent-chat init` /
`exit`: when a session ends, its sidecar is stopped; another agent's
session is unaffected. A host-wide daemon would need request-level auth
(re-introducing the problem we get for free with mode-0600 sockets),
larger blast radius on a crash, and a separate pid lifecycle. The
process-count economy isn't real on a host that already runs 10 Claude
Code instances — 10 sidecars at ~10 MB each is rounding error.

### Why UDS over HTTP loopback?

UDS sidesteps port management ("which port is orion's sidecar on?"),
gives faster transport (no TCP/IP stack overhead), and provides
filesystem-permission auth (mode 0600) for free. Cross-runtime is
unaffected — every language with a UDS client can speak this. The only
real upside of HTTP loopback would be browser access, which is not in
scope.

### Why `fs.watch` instead of `chokidar`?

`chokidar` is the obvious choice for a production watch loop, but the
skill is dep-free by invariant (Round 1). On Linux, `chokidar`'s back-end
is `fs.watch` anyway. The robustness benefits we want from `chokidar`
(rename coalescing, atomic-write detection) we get for free by using
directory-level `fs.watch` and a 25 ms debounce. The audit posture stays
"every file is plain Node std," matching the rest of the skill.

### Cutover policy

Default-on with `--no-sidecar` opt-out. The sidecar AND the existing
monitor both launch from `agent-chat init`. The monitor remains the
chat-notification source for v1 because Claude Code's Monitor tool is
already wired to its stdout — replacing the monitor with the sidecar
would force every session to rewire. v2 may promote the sidecar to
primary (its stdout uses the *exact same* line format on purpose, so a
simple stream swap suffices) once the inotify path has been validated
on every realistic filesystem.

The sidecar holds **zero protocol authority**. `lock` / `flip` / `park`
/ `unlock` / `recover` stay file-direct. The sidecar is a pure
read-accelerator + notification multiplexer; killing it never affects
correctness.

### Two bugs caught only by the load-bearing test (and what they teach)

The rollout used `since-last-spoke` against real long-running edges
with peer activity in the cursor range. Two bugs surfaced that smoke
tests like `time`-UDS-RTT would have missed:

1. **`monitor_alive: false` on every cycled sidecar.** Slice-5
   placeholders (`monitor_pid: null`, `monitor_alive: false`) were
   left literally hardcoded in the dispatcher and never wired to read
   from `SessionRecord`. Caught by 6 independent agents reporting the
   same false negative on `health`. Carina diagnosed: `init` spawns
   the sidecar BEFORE writing `monitor_pid` to the session record, so
   a startup-cached read sees null. Fix: re-read SessionRecord on each
   `whoami`/`health` dispatch.
2. **`sectionMeta` rejected fractional-seconds timestamps** in section
   headers. The regex hard-coded second-precision; the round-2 latency
   poll spec instructed agents to use `date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"`
   for `send_time`, and several agents echoed that into headers.
   Result: those sections silently parsed as `author: "unknown"` and
   fell out of `since-last-spoke` cursor calculations. Caught by
   keystone tracing back from a vanguard section that returned the
   wrong cursor diff. Fix: regex accepts `(?:\.\d{1,9})?`.

The lesson: smoke tests verify the surface; load-bearing tests verify
the diff. The audit-discipline rule is now: when shipping a new IPC
method, exercise it on a real long-running edge before declaring
GREEN. The petersen-graph rollout pattern (orion → 3 neighbors → fan
out to 6 more, every agent reports concrete UDS-time receipts and
runs `since-last-spoke` against their actual conversation state) is
the canonical way to validate.

---

## Round 10 — Multi-user transparency (humans + AI on one graph)

### Problem surfaced

Up through Round 9 the skill was implicitly framed as "AI agents talking
to AI agents," with humans as the *driver* of a Claude Code session
rather than first-class participants. Two questions made that framing
inadequate:

1. **One Claude Code session, multiple humans typing.** ("I'm boss
   talking; now I'm john talking now.") Each human's conversation
   needs its own thread; switching humans should not corrupt the prior
   thread, leak across threads, or require restarting the session.
2. **Long-term memory of user-AI conversations.** The lossless-claw
   archive layer (Round 2) was always going to compound most when it
   captured human↔AI threads spanning weeks, not just AI↔AI audit
   rounds that wrap in hours. Wiring user prompts and assistant
   responses into the existing CONVO.md / .turn / archive shape was
   the natural extension.

The user explicitly required **transparency as an invariant**: "to be
a truly effective organisation we don't want truly private
conversations. Everyone needs to be accountable for what they say."
That constraint collapsed several otherwise-ambiguous design choices
(privacy controls, per-edge ACLs, role distinctions) into clean
"don't" answers.

### Decision

Treat humans as **first-class agents in a topology**, indistinguishable
from AI agents at every protocol layer. Add three artifacts plus one
queued closeout-item, totaling ~750 LoC across new code and tests:

1. **`agents.org.yaml`** — new topology declaring 12 agents (2 humans
   + 10 AI) and 36 edges. Bipartite-plus-petersen shape: every human
   has an edge to every AI (20 edges), boss-john for human-to-human
   (1 edge), the existing 15 petersen edges among the AI subset
   preserved verbatim. **Zero `lib.ts` changes required** — humans-as-
   agents is a naming convention atop the existing primitives. The
   `parseTopologyYaml` allowlist, `isValidAgentName` regex, and edge
   canonicalization all accept the larger graph as-is.
2. **`agent-chat speaker <name>`** CLI subcommand + per-session state
   file at `.sessions/<key>.current_speaker.json` (mode 0600). Pure
   write-only-to-state — never writes CONVO.md or .turn. Speaker
   resolution is "live state, not durable identity"; resume-on-init
   wipes it.
3. **`agent-chat record-turn`** CLI subcommand. Reads the
   `current_speaker`, validates it's a topology agent (rejects
   AI-to-AI misroute via degree heuristic — humans=11, AI=5 in the
   org topology), uses two-flips-per-turn protocol on the
   `<speaker>-<agent>` edge: lock → flip to AI → append two sections
   (user turn + assistant response) → flip back to speaker → unlock.
   Idempotent retries via per-edge `recorded_turns.jsonl` ledger
   (sha256 of speaker+user+assistant). Speaker-switch handoff: the
   first record-turn after a speaker change writes a handoff section
   to the OLD edge (`## prev — handoff to new` ending `→ parked`,
   `.turn=parked`) before proceeding on the new edge.
4. **`monitor.ts --no-parked-startup`** flag (round-3 closeout item 1
   of 7, bundled here). At org-topology degree=11, every monitor
   restart for a human session can fire up to 11 parked-startup
   notifications — load-bearing UX flag the hardening-audit closeout
   list had queued. The other 6 closeout items remain queued for a
   separate commit.

### Why "humans = first-class agents" is structurally correct

The transparency invariant means privacy controls are explicitly NOT
in the design space. That choice eliminates the only thing that would
have justified a role distinction in the schema:

- **Edge canonicalization** (`alphabetical-min-max`) works the same
  for human-AI as for AI-AI. `boss-orion` and `john-orion` are just
  edge ids.
- **Lock semantics** are agent-name-scoped, not role-scoped. A human
  taking the floor is the same protocol primitive as an AI taking the
  floor.
- **The archive layer** (Round 2) compounds across all edges
  uniformly — user-AI threads and AI-AI audit chains both seal into
  the same `index.jsonl` and become grep-able through one query.
- **Cross-runtime interop** (Round 9 invariant #11) is preserved.
  A Codex session in Python can be a fourth human; the file-based
  wire format doesn't care.

The bipartite-plus-petersen edge shape gives the AI-to-AI misroute
defense for free: humans have degree=11 (every AI plus the other
human), AI have degree=5 (3 petersen peers plus 2 humans). The
`record-turn` dispatcher refuses any turn where
`degree(speaker) <= degree(agent)`, which exactly catches "AI tried
to record a turn through the human-record-turn path" without any
schema marker.

### Soft-discipline mechanism for the hook

Claude Code's `Stop` hook is session-level (one fire per session, at
session end), not per-turn, and its payload doesn't include the user
prompt or assistant response. So there's no kernel-level guarantee
that the agent calls `record-turn` after every response. v1 ships as
a soft-discipline mechanism: SKILL.md instructs the agent to call the
CLI at end of every response; the per-edge `recorded_turns.jsonl`
ledger is a grep-able audit signal — a session that ran for N turns
but has 0 ledger entries is detectable post-hoc.

`docs/HOOK_REQUEST.md` files the hard-discipline ask with the Claude
Code team: a `PostResponse` hook that fires after every assistant
response with `{user_prompt, assistant_response}` on stdin. If/when
that ships, the dispatcher gets a one-line wire-up; the protocol
above is unchanged.

### Cross-review caught two real bugs that solo work would have shipped

The four-phase orchestration (plan → cross-pollinate → implement →
cross-review → integrate) ran end-to-end through the petersen graph
without escalation. The round-robin Phase-4 review pattern surfaced
two genuine bugs at the cross-slice integration layer that the
slice authors couldn't have caught on their own:

1. **`listSessions` contamination** — the speaker CLI's
   `current_speaker.json` files live in `SESSIONS_DIR` with a `.json`
   suffix. `listSessions()` blindly accepted any `.json` file and
   pushed `{name, set_at}` records as if they were SessionRecords.
   `agent-chat who` then crashed in `r.agent.padEnd(undefined)`.
   Lumeyon caught it because she knew `listSessions`'s contract;
   carina didn't because that helper wasn't part of slice 2.
2. **`fetchSpeaker` dead-code field path** — keystone's `record-turn`
   read `r.result.name` from the sidecar `speaker` UDS response;
   carina's actual response shape was `{ current_speaker: { name,
   set_at } | null }`. Field path mismatch meant the dedicated
   fast-path was *always* falling through to the file-direct path —
   functionally correct, but the optimization that motivated
   shipping the dedicated UDS method was silently dead. Carina
   caught it because she knew her own UDS response shape.

Same structural lesson as the Round 9 sidecar bug-fix round (where
load-bearing tests caught the `monitor_alive` placeholder and the
fractional-seconds regex bug that smoke tests missed). Bugs that
surface at integration are the ones that pure unit tests cannot see.
The round-robin review is now validated as the load-bearing-test
rule applied to code-review.

### What we explicitly didn't do (anti-creep)

- **No `kind: human | ai` schema tag.** The transparency invariant
  means there are no behaviors that fork on agent role; uniform
  treatment is the simplest correct design. The degree heuristic
  derives the human-set when needed (record-turn AI-to-AI defense)
  with no schema extension.
- **No org-wide grep CLI.** The existing per-edge `search.ts` already
  works on the org topology; an aggregate command is cosmetic and
  defers to v2.
- **No timeline / `agent-chat thread-of <topic>` view.** Same — pure
  ergonomic, defers to v2 once we have actual recall queries that
  miss.
- **No PostResponse hook wired by Claude Code.** `record-turn` is a
  CLI the agent calls explicitly; the v2 hook is filed as a feature
  ask in `docs/HOOK_REQUEST.md`.
- **No prose-level speaker switch detection.** "I am john now" is
  not parsed; the user runs `agent-chat speaker john` (or the agent
  runs it on the user's behalf when they say so). Cross-cutting
  invariant #2 — never silently guess identity.

### Closeout-commit accounting

The round-3 closeout commit had 7 items queued. This commit ships
**1 of 7** (`--no-parked-startup` flag + 3 tests, bundled into
slice 1 because it was load-bearing UX at degree=11 for human
sessions). Remaining 6 still queued for a separate commit:

- `turn.ts resume <peer>` CLI (sentinel's CLI gap finding)
- pulsar (a) — `turn.ts:142` `process.pid` → `stableSessionPid()`
- pulsar (b) — `recover --apply` symmetric `processIsOriginal` guard
- parked-startup test (sentinel HIGH-1 ack)
- v-next observability fields on `unread`/`since-last-spoke`
  (`malformed_count`, `parse_warnings: []`)
- `validate.ts` cartesian-vs-declared edges check (sentinel's
  slice-1 sub-relay finding from this round)

### Process observation

This rollout was the first heavyweight integration where the user
explicitly authorized the team to operate autonomously: "leave me
out of this and build this with your team." The 5-phase pattern
(plan → cross-pollinate → consolidate → implement → cross-review →
integrate) ran end-to-end without escalation. Total wall-clock from
kickoff (22:53Z) to commit-ready (~23:40Z) was ~50 min for ~750 LoC
of new code, including two real bugs caught and fixed in review.

The compound win: the structural changes from Round 9 (sidecar +
`since-last-spoke`) made the team's own coordination dramatically
faster — lumeyon's report noted "~13ms each to fetch sentinel's +
lyra's replies," carina's noted "the diff between my last write and
orion's Phase-2 dispatch was the only thing I needed to read, ~250
lines vs the full ~1100." The latency primitive built in Round 9
made the multi-agent rollout in Round 10 feasible at the wall-clock
budget the user expected.

---

## Round 11 — Orthogonal user overlay (refactor of round 10)

### Problem surfaced

Round 10 shipped multi-user support but with two friction points the user
identified the moment we tried to use it: **multi-user required ceremony,
not automatic capture**, and **users were coupled to a specific topology**.

Concretely:

1. **Topology coupling.** Round 10's `agents.org.yaml` declared humans
   alongside AI in one yaml. Adding a user meant editing the topology
   yaml; using a user with a different topology required a NEW topology
   yaml. Petersen, ring, star, pair couldn't pick up users at all.
2. **Explicit `agent-chat speaker`.** Every session had to run
   `speaker <name>` before `record-turn` would accept anything. The
   user expected automatic capture by default — typing in their own
   Claude Code instance shouldn't require ceremony to be recorded.

The user's framing: *"It's strange, I actually thought this was what we
had just built. So if this is not what we did, we need to refactor it."*

### Decision

Refactor to an **orthogonal user overlay**: topology stays AI-only;
humans live in a separate `agents.users.yaml` registry; user-edges are
derived at runtime by `loadTopology`'s merge step. `init` auto-resolves
the speaker from the OS environment so capture is automatic. Backward
compatible: round-10's `agents.org.yaml` keeps working; explicit
`agent-chat speaker <name>` remains as override.

The architectural shift is one of **factoring**, not feature addition.
Round 10 conflated two orthogonal concerns:

- **AI peer-coordination topology** (petersen, ring, star, pair) — graph
  shape is mathematically meaningful for AI-AI peer review.
- **User-AI conversation channels** — bilateral, one per (user, AI) pair,
  no graph shape needed.

Round 10 forced both into one topology yaml. Round 11 separates them.

### What ships

1. **`agents.users.yaml`** — single source of truth for the user
   registry. Schema: `users: [{name, default?: bool}]`. At-most-one
   `default: true` (load-time enforced). Initial content: boss
   (default: true), john.

2. **`parseUsersYaml` + `loadUsers()` + `User` type** — strict parser
   mirroring `parseTopologyYaml`'s hardening (allowlist top keys,
   `Object.create(null)`, `AGENT_NAME_RE`). `loadUsers` returns `[]`
   on missing yaml — graceful degrade for pre-overlay sessions.

3. **`loadTopology(name)` overlay merge** — the structural lever that
   makes the rest of the slice trivial. After parsing the AI topology
   yaml, calls `loadUsers()` and merges users into `t.agents` and
   user-AI/user-user edges into `t.edges`, with Set-based dedup so
   pre-existing `agents.org.yaml` declarations don't duplicate.
   `edgesOf`, `neighborsOf`, edge canonicalization — all unchanged.
   ONE function modification, ZERO call-site edits across the codebase.

4. **`resolveDefaultSpeaker()`** — pure function, `$AGENT_CHAT_USER` →
   `$USER` (if registered) → `users.yaml default` → null. `cmdInit`
   calls it BEFORE writeSessionRecord; on `error` (e.g., explicit
   `$AGENT_CHAT_USER=alice` but alice not in users.yaml), hard-fail
   exit 65 with no state writes. After spawn, `exclusiveWriteOrFail`
   the auto-resolved value with `mode: 0o600` at create time.

5. **`record-turn` membership check rewrite** — replaces round-10's
   degree heuristic (`deg(speaker) > deg(agent)`) with explicit
   `users.includes(speaker) && !users.includes(agent)`. The degree
   heuristic worked under round-10's bipartite-by-construction org
   topology but inverts at smaller AI topologies with many users
   (e.g., petersen + 10 users → AI degree 13, human degree 12 → defense
   refuses legitimate human turns). Membership check is correct at any
   topology size.

### Why "users.yaml membership IS the human marker" instead of `kind: human|ai`

Lumeyon's framing in Phase-1: if `users.yaml` only contains humans,
then `users.includes(name)` IS the marker. No schema field needed.

Two paths considered:

- **B1**: only `kind: human` on users.yaml entries; topology agents
  implicitly `kind: ai`. Defense via `kindOf` helper.
- **Membership-as-marker**: no kind field. `loadUsers()` is the source
  of truth; `users.includes()` is the check. Topology agents are
  implicitly AI by being absent from users.yaml.

The membership-as-marker design wins on simplicity (no schema
duplication, single source of truth) and survives the lumeyon
collision-tolerance choice (below) cleanly: even when a name appears in
both lists, `loadUsers()` is unambiguously checked.

### Lumeyon's spec deviation (accepted explicitly)

Phase-2 directive said `loadUsers` should throw on user-name == AI-name
collision. Lumeyon's slice-1 implementation softened this to **Set-based
dedup with an inline comment** because strict throw broke
`loadTopology("org")` (which already pre-declares boss/john alongside
the AI agents). Same name, same human, no semantic conflict — dedup is
the right policy.

Strict throw was wrong because:

1. It conflates "same identifier, same person" (legitimate dedup) with
   "same identifier, different role" (genuine conflict).
2. The membership check (`users.includes`) is the source of truth, not
   topology.agents — collision in topo.agents doesn't break the misroute
   defense.
3. Pre-existing org.yaml declarations would all break, requiring
   migration that the user explicitly said wasn't desired.

The deviation is **strictly better UX, doesn't compromise correctness,
and is documented inline at the merge site**. Accepted explicitly here:
the round-11 design rule is "users.yaml is the human-set; topology
agents lists are AI-set; collisions are dedup'd silently because they're
non-conflicts under uniform-treatment."

### What we cleaned up in agents.org.yaml

Round-10's `agents.org.yaml` declared `boss` and `john` as topology
agents AND declared 21 cross-edges (1 human-human + 20 human-AI).
Round 11 removes them: org becomes a pure 10-agent AI topology with the
15 petersen edges. The user-edges and human-human edge come from the
overlay automatically.

This is purely cosmetic — lumeyon's dedup made the duplicate
declarations a no-op at runtime — but it cleans intent. The shape rule
"topology yaml = AI peer graph; users.yaml = human registry" is now
visible in the file structure, not just in the protocol.

### Two real bugs caught at Phase-4 cross-review

The four-phase orchestration ran end-to-end through the petersen graph
without escalation. Cross-review surfaced:

1. **chmod-race in `exclusiveWriteOrFail`** (lumeyon → carina). The
   auto-write splice did `exclusiveWriteOrFail(...)` followed by
   `chmodSync(0o600)`. Between the openSync(O_CREAT|O_EXCL) syscall
   and the chmod, the file existed at default umask 0o644 — the same
   identity-leak window the 0o600 invariant was meant to prevent.
   Fix: extend `exclusiveWriteOrFail` to accept `mode?` option,
   applied at openSync time as the third arg, eliminating the gap.
   ~3 LoC; same pattern `writeFileAtomic` already used.
2. **self-require dead code** (lumeyon → carina, nit). The
   `resolveDefaultSpeaker` helper used a `require("./lib.ts")`
   self-require to access `loadUsers()` defensively, with a comment
   "tolerate loadUsers being absent from older lib.ts builds." Dead
   code: `loadUsers` ships in the same file. Simplified to direct
   call.

Both fixed at Phase-5 integration. Same shape as round 10's two cross-
review catches (listSessions contamination + fetchSpeaker dead-code
field path) — the load-bearing-test rule applied to code review
continues to catch one or two real bugs per round that pure unit tests
miss.

### What we explicitly didn't do (anti-creep)

- **Did NOT delete `agents.org.yaml`.** Backward compat preserved;
  cleaned up but kept.
- **Did NOT remove explicit `agent-chat speaker <name>`.** Override
  remains for the rare multi-user-on-one-session case.
- **Did NOT add per-user `default_topology`.** Keystone proposed it for
  resolving rhino's edge-dir collision concern; lumeyon's load-time
  merge resolved that without per-user fields.
- **Did NOT add `users.yaml` editing CLI.** Manual yaml edits are fine
  for v1.
- **Did NOT wire the `PostResponse` Claude Code hook.** Still v-next
  via `docs/HOOK_REQUEST.md`. SKILL.md prompt discipline remains the
  v1 mechanism.

### Process observations

This was the third heavyweight integration the team has run
autonomously (round 9 sidecar rollout, round 10 multi-user, round 11
this refactor). Wall-clock from kickoff (00:03:54Z) to commit-ready
(~00:50Z) was ~45 min for ~250 LoC of new code + 100 LoC of test
modifications, including two real bugs caught and fixed in review.

The compound win across rounds: each round's structural changes made
the next round's coordination dramatically faster. Round 9's sidecar +
`since-last-spoke` made round-10's multi-agent orchestration possible
at the wall-clock budget the user expected. Round 10's multi-user
groundwork made round-11's refactor a focused 4-artifact change with
zero from-scratch architectural work. The team understood the codebase
deeply enough by round 11 to surface lyra's "merge inside loadTopology"
design lever in Phase-1 — reducing the slice from 5+ call-site edits
to ONE function modification.

The user's framing — *"every topology to naturally and automatically
record the user's interaction"* — is now structurally satisfied:
**any topology, plus `agents.users.yaml`, captures user-AI conversations
automatically without any explicit setup beyond `agent-chat init`**.

---

## Round 12 — Document the architecture (this file)

### Decision

Create `ARCHITECTURE.md` capturing every architectural decision with
its reasoning, in roughly chronological order. Keep it as a *living
artifact*: when a decision is reversed, edit the relevant section in
place rather than appending a revisions log.

### Why the chronological ordering?

The skill is an evolutionary design. Each round surfaced a problem the
previous rounds couldn't anticipate. Reading top-to-bottom is the
fastest way to understand:

- *why* the skill works the way it does (the constraints that drove
  each decision);
- *what we explicitly considered and rejected* (so future contributors
  don't re-litigate settled questions);
- *what could plausibly change* (sections marked with hedges and
  conditions for revision).

The alternative — a static "current architecture" document — loses
the rejected-alternatives information, which is the part that's most
valuable when someone is considering a redesign.

---

## Cross-cutting invariants

These are the rules that survived every round. Don't break them
without a careful redesign and a corresponding update to this file.

### 1. Filesystem-only

No SQLite, no daemon, no MCP server, no external service. The skill
runs on plain files. (Round 1.)

### 2. Never silently guess identity

Every identity comes from an explicit user declaration: `agent-chat
init`, env vars, or `.agent-name`. The skill refuses to act if none
are set. (Round 1, reaffirmed in Round 5.)

### 3. Append-only conversation transcripts

`CONVO.md` is append-only. Editing or deleting earlier sections
written by another agent is a protocol violation. The fresh tail and
breadcrumb model preserves continuity across archives without
mutation. (Round 1.)

### 4. Two-step seal/commit for archives

Sealing the body and committing the index entry are separate
operations. A failing validator never leaves the index corrupt.
(Round 2.)

### 5. Anti-theater validation

A summary missing required sections, with leftover TODOs, or with
empty Keywords / Expand-for-details is rejected at commit time.
"Looks good" is not a valid summary. (Round 2.)

### 6. Auto-proceed-on-agreement, escalate on disagreement

When a peer's section ends with a concrete reversible action the
local agent agrees with, the local agent just executes it (and
records the agreement in its reply section). Disagreement,
destructive actions, and resource gaps escalate to the user. The
rule is per-edge, not global, so it scales to N agents. (Round 1,
inherited from codex-chat.)

### 7. Polling is the correctness floor; inotify is an opt-out accelerator

`monitor.ts` uses a 2-second `stat`+`read` poll loop, not inotify.
Inotify silently emits zero events on NFS/FUSE/sshfs, which would
break the multi-host use case. The polling overhead is negligible
(one stat per edge per 2s). (Round 1.)

`scripts/sidecar.ts` (Round 9) opts into `fs.watch` for sub-millisecond
notification latency on local filesystems, but preserves correctness on
hostile mounts via a 5-second reconcile poll that re-evaluates every
edge regardless of whether `fs.watch` fired. The sidecar is also
opt-out: `agent-chat init --no-sidecar` falls back to monitor-only
operation, and the sidecar holds no protocol authority — killing it
never affects correctness. So inotify is a *latency optimization*
behind a feature flag, not a substitute for the polling correctness
floor. The single-host filesystem invariant (#9) still bounds where
inotify can be relied on. (Round 1, refined Round 9.)

### 8. Identity is per-session, not per-cwd

The session file under `conversations/.sessions/<key>.json` is the
canonical identity record. cwd and tty are used only as
*resume keys* (matching a returning session to a prior identity),
never as identity *sources*. (Round 5.)

### 9. Single-host filesystem only — multi-host is an explicit non-goal

The lock layer (wx-EXCL), gc semantics, and `pidIsAlive`/`processIsOriginal`
all assume one host shares the filesystem. Multi-host introduces failure
modes the skill does not defend against:

- **wx-EXCL on NFSv2/v3** is historically lossy — the server may report
  success when another client already holds the file, defeating the
  serialization that lock acquisition depends on. NFSv4 has working
  O_EXCL but multi-host coordination beyond it is still untested.
- **`gc` on a shared dir** would otherwise unlink other hosts' live
  state, because their pids are meaningless in our pid namespace. The
  P0 multi-host gc fix (`if (rec.host !== os.hostname()) continue`) at
  every gc decision point is a *defense*, not an enabler — it prevents
  catastrophic data loss when someone accidentally crosses the line, but
  it does not make multi-host work.
- **`agent-chat init`** runs `nfsv3ProbeWarn()` which parses
  `/proc/self/mountinfo` and emits a stderr WARN if `conversations/`
  sits on NFS. NFSv3 is a hard warn; NFSv4 is a soft note.

If multi-host ever becomes a goal, the design changes are: link()-based
lock acquisition (NFSv2/v3 fallback) per `lib.ts:exclusiveWriteOrFail`
note, and a remote-pid liveness check (e.g., a heartbeat file the holder
touches every N seconds) instead of the local `pidIsAlive`. (Round 8 —
formalized after the petersen-graph hardening audit revealed the
multi-host gc bug as the loudest unguarded failure.)

### 10. fsync is opt-in, not default

`writeFileAtomic` and `appendIndexEntry` accept an `{fsync?: boolean}`
flag. Commit paths set `fsync: true` (durability matters once the
validator has passed); seal paths fsync the BODY.md before destroying
the source CONVO.md (the source-destruction window is the only place
durability actually matters). Everything else skips fsync — the syscall
budget would be wasted on intermediate state that's rebuildable from
session records. The `.turn` file specifically is NOT crash-durable
to power loss; recovery is a manual re-init. (Round 8.)

### 11. The file-based wire format is the canonical protocol; daemons are accelerators

`CONVO.md`, `.turn`, `.turn.lock`, and the archive layout are
authoritative. Anything an agent writes goes to the filesystem first;
anything an agent reads can be served from the filesystem. The
`scripts/sidecar.ts` daemon (Round 9) is a *pure accelerator* — it
serves cheap structured queries from in-memory cache and replaces the
poll loop with inotify for sub-millisecond notification latency, but
it holds zero protocol authority and writes nothing to the protocol
files. `lock`, `flip`, `park`, `unlock`, and `recover` stay file-direct
on principle.

This invariant is what preserves cross-runtime interop. A Codex session
in Python and a Claude session in TypeScript don't have to share a
runtime, an SDK, or a daemon implementation — they share the
`<topology>/<edge-id>/CONVO.md`+`.turn` files. The sidecar's IPC
(line-delimited JSON over UDS) is also runtime-agnostic, so a future
Codex sidecar in Python coordinates with a Claude sidecar in TypeScript
through the same socket-and-file shape, but it would still work
correctly with no sidecar at all on either side. (Round 1, made
explicit in Round 9.)

---

## Future work, deferred until evidence demands it

These ideas are deliberately *not* built yet. They each have a clear
trigger that would justify the work; pre-building them violates the
"build for evidence, not speculation" principle the skill was designed
under.

### Vector embeddings on `index.jsonl`

Plain keyword + ripgrep over summaries handles 95% of recall queries
today. Embeddings get added if and when we measure summary recall
failing on a real lookup the user knew was in there.

### One-monitor-per-host consolidation

Ten lightweight monitors at <1ms CPU each is not a real problem.
Consolidation gets built only if a profile shows monitor overhead
mattering, AND the consolidation can be done without breaking
"any session can come and go independently." The Round 9 sidecar
explicitly stays per-agent for the same reason; see Round 9 for the
rejected-alternative analysis.

### Sidecar promoted to primary chat-notification source

v1 (Round 9) ships both `monitor.ts` and `scripts/sidecar.ts`; the
monitor remains the chat-notification source so existing Claude Code
Monitor-tool wiring works unchanged. The sidecar's stdout uses the
*exact same* line format on purpose, so a stream swap is a one-line
change. We promote only after the inotify path has been validated on
every realistic filesystem in real use — meaning every reported
`fs.watch` miss has been attributable to a documented limitation
(NFS / WSL1 / coarse-mtime FUSE), not a bug.

### Sidecar v2 methods (subscriptions, peek-many, archive-hint)

Reserved in the v1 dispatcher with `E_NOT_IMPLEMENTED`. Built when a
real consumer needs them — most likely a TUI dashboard (above) wanting
push subscriptions instead of polling the sidecar's IPC.

### Multi-host coordination

Today the skill works on multi-host setups via shared filesystem
(NFS, sshfs). A genuine multi-host design with no shared filesystem
would need a different transport layer. We'd build it only after
the single-host case is in real use and the multi-host case has a
real user with a real workflow.

### TUI / dashboard

`agent-chat who` is a CLI listing. A live TUI showing who's online,
which edges have unread turns, and which archives need committing
is plausible — but only after we know which information actually
matters in daily use.

### TOK gateway integration

The petersen-v1 spec at `nodes/agent-comms/petersen-v1/` describes
a TOK-native gateway with ACL enforcement, archive sealing, review
receipts, and delivery gates. The on-disk protocol agent-chat uses
is compatible: a TOK gateway watching `conversations/<topology>/`
would Just Work without skill changes. Building the gateway is a
separate project; the skill stays standalone.

---

## Credits

- The original `.turn` sentinel pattern and the two-agent turn
  protocol come from [codex-chat][codex-chat], which agent-chat
  generalizes from.
- The DAG-of-summaries archive architecture, fresh-tail protection,
  depth-aware policies, *Expand for details about:* footer, and the
  three-tier grep→describe→expand escalation come from
  [lossless-claw][lcm], which itself implements the
  [LCM paper][lcm-paper] from [Voltropy][voltropy].
- The 10-agent name set (orion, lumeyon, lyra, keystone, sentinel,
  vanguard, carina, pulsar, cadence, rhino) and the Petersen-graph
  topology rationale come from the [Celestial Cortex][cc] team's
  `petersen-v1` agent-comms spec.
- The anti-theater validation rule for review receipts is also
  drawn from petersen-v1.

[voltropy]: https://x.com/Voltropy
[lcm-paper]: https://papers.voltropy.com/LCM
[cc]: https://github.com/lumeyon
