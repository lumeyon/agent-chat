# Round 14 — Ruflo Lessons Audit (Integrated Summary)

**Round status:** complete (audit only; implementation is Round 15+).
**Audit dates:** 2026-05-04.
**Repo audited:** `/data/eyon/git/ruflo` (Claude Flow / Ruflo, GitHub: `ruvnet/claude-flow`).
**Slice owners:** lumeyon (architectural), carina (development process + plugin distribution), keystone (documentation + community + plugin manifest comparison).

This file is the integrated punch-list. Per-slice deep dives are inline in the petersen graph CONVOs (`conversations/petersen/{lumeyon,carina,keystone}-orion/CONVO.md`, look for the `## <name> — Round-14 Phase-1/Phase-3` sections).

---

## TL;DR

Three independent reviewers converged on the same strategic answer:

1. **Ruflo's architectural divergence is the session lifecycle**: ephemeral process invocations + native Claude Code `ScheduleWakeup` / `CronCreate`, not long-running peers. They sidestep the "stuck-agent" problem agent-chat surfaced in Rounds 12-13.
2. **HYBRID is the right answer for agent-chat**: keep persistent mode (today's default) AND add ephemeral mode (opt-in). Both write to the same wire protocol.
3. **The plugin pivot is structurally cheap**: ~60 LoC of per-runtime manifest fork + the existing skill/scripts/conversations/yaml unchanged. NO MCP server needed (agent-chat's protocol is filesystem-mediated).

**Round 15 scope (locked, decoupled):**
- **15a — Ephemeral mode + cache-warm wakeup loop**: ~313 LoC, Claude-only, no Codex dependency.
- **15b — Plugin pivot (Claude + Codex dual-manifest)**: ~60 LoC manifest fork + ~290 LoC runtime adapters = ~350 LoC. Codex empirical verification gated on credit refresh.

**The stuck-agent problem we surfaced in Round 12 and detected in Round 13 is solved at Round 15a** — `ScheduleWakeup({delaySeconds: 270})` re-injects the prompt cache-warm. No tmux, no manual "please continue", no PTY wrapper.

---

## Convergent findings (independently confirmed across all three slices)

| Finding | carina | lumeyon | keystone |
|---|---|---|---|
| **Ruflo has zero `.codex-plugin/` content** — Claude-only | grep verified `Section B.6` | inferred from federation transport stub | scout-verified at Phase-1 plan |
| **HYBRID architecture (persistent + ephemeral opt-in)** | aligned via Round-15a / 15b sequencing | LOAD-BEARING verdict, Phase-3 synthesis | Section G reconciles explicitly |
| **Skill-only plugin pivot (no MCP server in our ship)** | implicit in proposed file tree | NOTE-verdict on hooks-daemon | Section D explicit verdict |

Three reviewers, same finding from three different code paths — strong receipt that the strategic answer is right.

---

## Three load-bearing findings driving Round 15

### 1. `ScheduleWakeup({delaySeconds: 270})` is cache-aware-by-design

**Receipt** (lumeyon Finding 2): `plugins/ruflo-autopilot/skills/autopilot-loop/SKILL.md:14`:
```
ScheduleWakeup({ delaySeconds: 270, reason: "next autopilot iteration" })
```
Line 18 explains: *"Always use delay 270s (under 300s cache TTL) to keep the prompt cache warm between iterations."*

The 270s is not arbitrary. Anthropic's prompt cache has a 5-minute TTL; sleeping past 300s pays a full cache-miss on the next wake. 270s stays under the line.

**Why it matters for agent-chat:** Round 13 left the wakeup-itself problem unsolved. Our agents stayed alive between turns precisely because we couldn't wake them on demand. ScheduleWakeup with cache-warm delay solves it: ephemeral agents exit cleanly and Claude Code re-injects the prompt 270s later, cache-warm.

**Adopt:** `lib.ts CACHE_WARM_DELAY_SEC = 270` constant + comment block citing autopilot-loop SKILL.md:18 as empirical source. Any future skill using the wakeup pattern reads this constant.

### 2. Our existing wire format already encodes "more work to do"

**Receipt** (lumeyon Finding 7): walked Ruflo's `file-checklist` task discovery at `v3/@claude-flow/cli/src/autopilot-state.ts:258-277`:
```ts
if (source === 'file-checklist') {
  const checklistFile = resolve('.claude-flow/data/checklist.json');
  // ... reads JSON, parses {id, subject, status} entries
}
```

The autopilot-loop SKILL.md described this as "Markdown checkbox items in tracked files" — the doc lies; the actual implementation reads a JSON sidecar. **But the deeper insight**: agent-chat's existing `.turn=parked + recent index.jsonl mtime` already encodes the same "more work to do" signal. We don't need a separate task-list file format.

**Strict simplification over Ruflo's design.** The wakeup loop reads current state from `.turn` + `index.jsonl` mtime. Same primitives, no new file format. This is the kind of finding that justifies team audit over solo audit — a solo reader would have copied their JSON checklist; cross-discipline of "verify the SKILL.md description against the code" caught the misleading docs AND surfaced the simplification.

### 3. Recursive Round-13 receipt — the safety net caught its own production case

**Receipt** (keystone re-ship narrative, 2026-05-04T16:38:00Z): keystone's Round-14 Phase-3 was delayed because his session's monitor was a stale May-02 binary lacking carina's Round-13 stuck-on-own-turn detector. He cycled (`agent-chat exit + init + Monitor re-arm`). The new monitor with Round-13 slice 2 immediately fired:

```
edge=keystone-orion stuck=agent-stuck-on-own-turn turn_age_s=6700+
```

on all three of his edges. **The detector built specifically for the Round-12 hang case (orion himself) caught its real-world equivalent in production usage on a peer it wasn't designed against, before that peer even knew they were stuck.** Quote-worthy.

This is the load-bearing case for shipping safety-net infrastructure even when the failure mode hasn't been observed yet. Round-15 commit message will reference it.

---

## Strategic verdict punch-list (consolidated across slices)

Verdict frame (vanguard's design, adopted via keystone): every verdict carries a **rigor field** — ADOPT requires `Downgrade trigger`, REJECT requires `Invariant cited`, ADAPT requires the `Load-bearing IDEA`. Empty rigor field flags an unfalsified claim.

### ADOPT (direct lift)

| Item | Receipt | Lands at | Downgrade trigger |
|---|---|---|---|
| `ScheduleWakeup` 270s cache-warm pattern | autopilot-loop/SKILL.md:14-18 | Round-15a `loop-driver.ts` | If Anthropic raises cache TTL above 300s, revisit constant |
| `CACHE_WARM_DELAY_SEC = 270` shared constant | inferred from above | `lib.ts` | If used in <2 callers, fold back inline |
| `marketplace.json` shape (top-level + per-plugin) | `.claude-plugin/marketplace.json` | Repo root marketplace.json (1 entry for v1) | If marketplace.json blocks `claude code plugin add` direct install, remove |
| `git-subdir` source for marketplace add | Codex docs + Ruflo precedent | marketplace.json sources field | If users find direct git installs simpler, drop |
| Skill format (YAML frontmatter + body) | shared between Codex docs and existing agent-chat skill | Existing `agent-chat/SKILL.md` (no change) | N/A — shared format |
| `commands/<name>.md` for slash commands (deferred) | Round-15+ when we expose subagent dispatch as user-invocable | n/a v1 | If Codex slash command surface diverges, fork |
| Co-author tags in commits | already adopted Round-12 + 13 | CONTRIBUTING.md (new) | N/A |
| npx-based MCP server spawn pattern (deferred) | Ruflo plugin.json:51-70 | Round-16+ if MCP surface materializes | N/A — deferred |
| Verdict-rigor frame for future audits | vanguard via keystone | new `docs/audit-rigor.md` | N/A |

### ADAPT (keep our shape, borrow their idea)

| Item | Ruflo mechanism | Our adaptation | Load-bearing IDEA |
|---|---|---|---|
| Registry-vs-execution split (`agent_spawn` metadata-only) | metadata blob in store.json; execution via Task tool / claude -p | We have `SessionRecord` registry; ADD ephemeral-execution path via `cmdRun` | Identity is data; execution is dispatched |
| Skill-only plugin shape (drop ruflo's MCP-heavy bundle) | 314 MCP tools claimed (~122 actual) | NO mcpServers in our plugin.json; CLI scripts driven by Bash tool | Plugins ship cohesive surfaces — not all need MCP |
| Two-manifest dual-runtime layout | only `.claude-plugin/` exists in Ruflo | `.claude-plugin/` + `.codex-plugin/` (ours, ~60 LoC manifest fork) | Cross-runtime is a metadata-layer fork, not implementation-layer |
| WASM destructive-command detection | 1.1MB compiled wasm wrapping 12+8 regex patterns | TS regex set in `scripts/safety.ts` (~50 LoC); no wasm dep | Pattern matching is the value; the runtime container is incidental |
| Hook handler `type: prompt` (model evaluates Stop) | `plugin/hooks/hooks.json:160-162` | DEFER — our stuck-on-own-turn detector already does what model-prompt-Stop achieves | The model is a valid hook handler when the decision is "did this finish gracefully" |
| Internal event taxonomy mapped to documented surface | `v3HookMapping` collapses 13 internal events onto Claude's 8 documented | Subagent.ts already has internal events; document the mapping | Emit your own internal events to a private dispatcher; register at the documented vocabulary level |

### REJECT (explicit non-adoption)

| Item | Invariant cited / why |
|---|---|
| Federation / multi-machine | `ARCHITECTURE.md` Round-9 invariant: "filesystem-only, single-host". Ruflo's `sendToNode` at `plugin.ts:136` is a stub that only logs. Borrowing skeleton code with no production path is theater. |
| Self-learning memory / neural | Round-12 lossless-claw-inspired DAG is the genuine archive. Ruflo's `pattern-learner.ts` has zero training code (no `train`/`optimizer`/`gradient` matches). Type signatures for PPO/DQN/EWC/LoRA without instantiation = marketing fiction. |
| `mcpServers` inline in plugin.json | NEW invariant proposed for ARCHITECTURE.md: "MCP server declarations live in `.mcp.json` at project root, not inline in plugin.json — single source of truth, runtime-portable." |
| 314 MCP tools as a target | Counted: 122 actual (104 V3 + 18 V2 compat). ~10 used in tests. Cargo-culting tool count over our domain-fit 8-method UDS surface. |
| Single-author 5932-commit pattern | `Round 9-12 ARCHITECTURE.md` cross-cutting invariant: cross-review-as-discipline catches what unit tests miss. Petersen-graph cross-review (caught real bugs in 4 of 4 rounds 12-14) is the better contributor model. |
| 33-plugin federation (drop into Round-15 v1) | Single cohesive plugin is the right scope for v1. ADAPT-deferred to Round-16+ if we split agent-chat into plugin sub-units. |
| Hooks pipe through `npx claude-flow@alpha hooks <sub>` | Direct `bun scripts/...` is fewer moving parts, no npm cycle. Round-9 invariant: zero npm deps. |

### NOTE (observation, not action-relevant)

- Ruflo's hooks-daemon is 30 LoC of clock + dispatch (`v3/@claude-flow/hooks/bin/hooks-daemon.js:43-79`). Our sidecar.ts is at slice-5 maturity (heartbeat, FTS index, fs.watch, auto-compaction). We're past it.
- `PermissionRequest` at `plugin/hooks/hooks.json:190` may be an undocumented Claude event or an alias the runtime ignores. Runtime probe deferred to Round-15+.
- `engines.claudeCode` / hypothetical `engines.codex` per-runtime version pinning — trivial to add to each manifest.

### NOTE-MARKETING (Section A; deprioritized unless user surfaces "viral" goal)

- One-line tagline at the top of README. Ruflo: *"Multi-agent AI orchestration for Claude Code."*
- "You don't have to learn 26 CLI commands" reassurance line addressing the complexity-tax objection BEFORE the user feels it.
- ASCII architecture diagram immediately under the README hook.
- Integration GIF (`./ruflo-plugins.gif` in their repo).
- Hosted UI beta at flo.ruv.io as a "thing people try" surface (would be a separate project; out of agent-chat scope).
- Origin-story narrative framing of inevitability.

These are zero-LoC additions to a future README rewrite. Not load-bearing for the architecture decision.

---

## Round 15 dispatch shape (locked)

### Round 15a — Ephemeral mode + cache-warm wakeup loop (~313 LoC, Claude-only, no Codex dep)

**Goal:** close the Round-13 wakeup gap on the Claude side. Ephemeral agents exit cleanly; ScheduleWakeup re-injects the prompt 270s later.

**Slice owners (per lumeyon's recommendation):**
- **lumeyon** (architectural primitives): `cmdRun` ephemeral entry point, `loop-driver.ts` ScheduleWakeup wrapper, `safety.ts` destructive-command + secret regex set lifted from `gates.rs:29-43`. ~250 LoC.
- **carina** (integration with existing flows): verify `resolveDefaultSpeaker` works under `claude -p` shell-out (no live session); verify `record-turn` semantics from ephemeral mode; ephemeral-mode round-trip tests. ~30 LoC adjustments + tests.
- **keystone** (docs + tests): README "Hybrid mode" section, ARCHITECTURE.md Round-15 narrative, ephemeral-mode test fixtures. ~30 LoC tests + docs.

**Files added/modified:**
- `scripts/safety.ts` (new, ~50 LoC) — destructive + secret regex set lifted from `v3/@claude-flow/guidance/wasm-kernel/src/gates.rs:29-43`. Source attribution in file header.
- `lib.ts` — `CACHE_WARM_DELAY_SEC = 270` shared constant + comment citing autopilot-loop SKILL.md:18.
- `agent-chat.ts` — `cmdRun` (~80 LoC). Ephemeral entry point. Resolves identity, walks `edgesOf(topo, id.name)`, peeks each, processes any edge with `.turn=<self>`, exits. Wraps `claude -p`. No sidecar startup. No monitor.
- `scripts/loop-driver.ts` (new, ~60 LoC) — ScheduleWakeup wrapper polling `peek` results across edges.
- Tests (~120 LoC) — ephemeral-mode round-trip, cache-warm timing constant pin, safety pattern coverage.

### Round 15b — Plugin pivot (~350 LoC, Codex empirical verification gated on credits)

**Goal:** ship agent-chat as a single-codebase dual-runtime plugin (Claude + Codex). User installs via either runtime's marketplace.

**Slice owners:**
- **carina** (manifest mechanics): produce `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` from her Round-14 file tree.
- **keystone** (manifest fields + hook taxonomy reverse-engineering): finalize the field-by-field manifest schemas; runtime-probe Codex hook events (rhino's protocol — write a hooks.json registering every plausible event name, run codex, observe which fire).
- **lumeyon** (runtime adapter shims): `scripts/runtimes/{claude,codex}.ts`. Each adapter exposes `runEphemeral({prompt, context})` wrapping `claude -p` or `codex exec`.

**Files added/modified:**
- `.claude-plugin/plugin.json` (~30 LoC) — Claude metadata (engines.claudeCode pinned, no inline mcpServers).
- `.codex-plugin/plugin.json` (~30 LoC) — Codex metadata (engines.codex hypothetical).
- `marketplace.json` (~20 LoC) — 1-entry agent-chat root, `git-subdir` source.
- `.mcp.json` (~5 LoC) — empty `{"mcpServers": {}}`, reserved for future.
- `hooks/hooks.json` (~50 LoC, Path A: shared) — PreToolUse / PostToolUse / Stop / etc. If runtime probe reveals Codex divergence, fork to per-runtime hooks.json (Path B).
- `scripts/runtimes/claude.ts` (~150 LoC) — `runEphemeralClaude({prompt, context})` wrapping `claude -p`. ScheduleWakeup integration.
- `scripts/runtimes/codex.ts` (~150 LoC) — `runEphemeralCodex({prompt, context})` wrapping `codex exec`. CronCreate integration as fallback (since Codex has no documented ScheduleWakeup analog).
- `agents.<topology>.yaml` schema bump — agents grow a `runtime: claude|codex` field. Default `claude` for backward compat.
- README.md install section — both `claude code plugin add ...` and `codex plugin marketplace add ...`.

### Decoupling

15a ships before 15b without blocking. 15a is purely additive (ephemeral mode is opt-in; persistent mode unchanged). 15b is purely additive (plugin manifest pair lives outside the existing source tree). Either order works.

**Critical-path block for 15b**: Codex hook event reverse-engineering. Gated on user's Codex credit refresh (2026-05-05).

---

## Open empirical questions (deferred to Round 15 pilot)

1. **`PermissionRequest` hook event** — undocumented in Anthropic's Claude Code docs but used by Ruflo. Runtime probe required: install Ruflo, trigger an MCP tool call, observe whether the hook executes.
2. **Codex hook event taxonomy** — undocumented entirely. Rhino's protocol: write a hooks.json registering every plausible event name (PreToolUse, PreCommand, PreEdit, PreSubmit, PreSession, PrePrompt, etc.), each emitting `echo $EVENT_NAME >> /tmp/codex-events.log`. Run a representative codex session. The events that fire ARE the real surface.
3. **`.mcp.json`-only plugin acceptance on Claude Code** — Anthropic's docs say `.mcp.json` is read from project root. Verify a plugin with `.mcp.json` and no inline `mcpServers` works. If yes, the `mcpServers` divergence collapses to single-source-of-truth.
4. **Codex slash-command registration surface** — flagged "NOT documented" in Codex docs. May exist; pending OpenAI docs publication or runtime probe.

---

## Process meta-observations (for future audits)

### Same anti-pattern caught three times across three slices

Round 12 Phase 4: `bm25(archives, 2.0, 1.0, 1.5, 2.5)` — wrong number of weights aligned to wrong columns. Test passed for the wrong reason.

Round 13 Phase 4: same shape recurred three times in three slices — `lockHeld = fs.existsSync()` (file presence ≠ liveness); `parseHeartbeat` accepts missing/unknown sidecar_version (string presence ≠ semantic validity); test fixture `ts=x` short-circuited on `Date.parse` before reaching the labeled invariant.

Round 14 (this audit): the *audit equivalent* — Ruflo's autopilot-loop SKILL.md describes "markdown checkbox" task discovery; the actual implementation reads a JSON file. The doc lies; the code is the truth. Reading SKILL.md without verifying against `autopilot-state.ts` would have led to a wrong adoption.

The pattern: **load-bearing claim guarded by an under-specified primitive**. Whether the primitive is a numeric tuple's length, a boolean's semantic meaning, a string's presence, a test fixture's fall-through, or a doc's accuracy — the failure mode is identical. **Verify the primitive matches the load-bearing claim.**

### Verdict-rigor frame is a Round-15 carryover

Vanguard's design (via keystone Phase-3 Section "Verdict-rigor frame"):
- ADOPT requires a `Downgrade trigger` — without it, ADOPT becomes optimistic-by-default and survives integration friction through drift.
- REJECT requires an `Invariant cited` — citation to existing ARCHITECTURE.md OR a one-line proposed addition. A REJECT without principle is a preference.
- ADAPT requires a `Load-bearing IDEA` — one sentence that must survive intact through adaptation. If the line can't be written, the import is a different feature wearing the source's name.

Lift into a project convention. Capture in a new `docs/audit-rigor.md` so future audit rounds have a template. Cite vanguard explicitly (sub-relay credit).

### Cross-pollination via Phase-1.5 acks

This round we leaned more heavily on Phase-1.5 acks than formal Phase-2 cross-pollination batch dispatch. Each peer received cross-cuts from sibling slices as those slices landed, rather than waiting for all three Phase-1 plans to land simultaneously. Worked well — peers had relevant context earlier, total wall-clock was tighter.

For Round 15 dispatch: Phase-2 batch can probably be dropped entirely if Phase-1 outputs are independent enough. Phase-4 cross-review remains valuable when there's CODE to verify (Round 15 has code; Round 14 didn't).

---

## Sequencing the next 3-6 months of work

1. **Round 15a (next, ~313 LoC)** — ephemeral mode + ScheduleWakeup. Closes the Round-13 wakeup gap. Claude-only. Ships immediately on user go-ahead.
2. **Round 15b (depends on Codex credits)** — plugin pivot. Dual-manifest. Empirical verification of hooks taxonomy. Ships when Codex credits available.
3. **Round 16** — possible: split agent-chat into multiple smaller plugins (33-plugin Ruflo precedent, ADAPT-deferred). Possible: expose petersen topology as Claude Code sub-agents (`agents/<name>.md` shape).
4. **Round 17+** — driven by what we learn from Round 15 in production. Wakeup-mechanism alternatives (tmux send-keys, MCP push) only if ScheduleWakeup proves insufficient.

The audit answers the strategic direction. Round 15 starts immediately on user go-ahead.
