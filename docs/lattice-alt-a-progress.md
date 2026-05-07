# Alternative A — Progress Dashboard

> Status file maintained by the autonomous `/loop` driver. Captures Alt A deliverable progress, decision points, and verification results.

## Current state — 2026-05-07T20:08Z

**Phase: Self-improvement /loop iteration 4 — first depth=1 question + first question_parent edge in the lattice DAG. Boss-approval question (from iter-3 journal) promoted to a first-class lattice node. Sparse-citation finding documented.**

## Phase status

| Phase | Deliverable | Status |
|---|---|---|
| ALT-A-1 | AI-to-AI dialog import | **COMPLETE** — pairSections() extended; 23 tests pass; production lattice grew 252→386 questions / 693→846 answers |
| ALT-A-2 | pushContext wired into agent-chat runtime | **COMPLETE** — `lattice-context.ts` helper + cmdRun integration; 12 unit tests + real-data end-to-end smoke pass |
| ALT-A-3 | Study turn loop with LLM integration | **COMPLETE** — `study-turn.ts` + `agent-chat study-turn` CLI; 16 unit tests pass; real-LLM end-to-end run completed (3 claude calls, dry-run, results table) |

## Iteration log

### 2026-05-07T20:08Z (Self-improvement /loop iteration 4: depth=1 spawn + sparse-citation finding)

**Target category:** D (SPAWN DEPTH>0 QUESTIONS) primary, plus opportunistic C (citation patch).

**Pivoted from category C as planned in iter-3:** The original plan was "spawn lumeyon to identify 1-3 prior-answer citations, target citations 1 → 4-5." Reality check: ran pushContext on iter-2 and iter-3 framings, top-K hits (excluding self-match at cosine=1.0) had cosine 0.21–0.31. The auto-imported lattice content is mostly conversational coordination ("got it", "GREEN-with-CONCERN"), so semantic similarity from a structured technical question to auto-imported chat fragments stays low. Lesson: **citations naturally form at peer-review hubs and authored-content seeds; the auto-imported tail won't surface meaningful citation candidates via embedding alone**. Iter-1's lumeyon review functions as the hub — both iter-2 and iter-3 cite it.

**What was done:**
  1. **First depth=1 question spawned:** Promoted iter-3's journaled boss-approval question ("Should the SQL schema migration to TEXT NOT NULL be performed in the next iteration touching the lattice schema, or should the type+runtime-guard pair stay as the sole enforcement?") to a first-class lattice node. status=open, posed_by=orion, depth=1. parent=iter-3's question (v1:477192c96d6e8abb) via the question_parents DAG edge.
  2. **iter-2 → lumeyon citation patched:** When iter-2 was authored, I missed adding the citation that should have existed (iter-2's quality_tier-fix answer rests on lumeyon's iter-1 finding #1). Added now: parent=iter-2 ans:e2f37..., child=lumeyon ans:791b1...

**Dog-food check (forcing functions exercised):**
  - ✅ Function 4 (PUSH-CONTEXT) — exercised end-to-end on production data; revealed the sparse-citation finding (top-K hits all cosine < 0.32 for authored queries against auto-imported corpus).
  - ✅ Function 5 (FORMAT-UNIFORM ARTIFACTS) — depth=1 question carries full provenance (id, framing, status, posed_at, posed_by, posed_in_context, depth).
  - ⚠️ Function 1 (DUAL-OUTPUT) intentionally NOT exercised on the new depth=1 question — it's posed open for boss to answer, since the migration question is an architectural decision per inviolable principle 4.

**Lattice metrics (BEFORE → AFTER) — TWO new DAG-structure metrics moved:**
  - Questions: 396 → 397 (+1 depth=1 child)
  - **question_parents: 0 → 1** ← first ever DAG edge in the question hierarchy
  - **depth=1: 0 → 1** ← depth_distribution gains a new bucket
  - **citations: 1 → 2** (+1 iter-2 → lumeyon patch)
  - Authored: 2 → 2 (no change; new question is open, no authored answer yet)
  - posed_by orion: 67 → 68

**Tests:** plugin 502/0/3, lattice 99/0 (no change — no code changes this iteration, only lattice writes).

**Commit:** (this turn).

**WHAT'S NEXT (iteration 5):** **STOPPING CONDITION CHECK** — boss has TWO open architectural decisions journaled: (1) the SQL schema migration (now also represented as the depth=1 lattice question), (2) the routing-table/petersen-neighbors mismatch from iter-1. Iter 5 should NOT pile on more decisions; instead, execute lumeyon's REAL #3 (Question.status / best_answer_id consistency) — same shape as iter-3 (TS type tightening + runtime guard at putQuestion). That maintains forward motion without compounding boss-approval debt. Per the rotate-categories rule, iter 5 returns to category I.

### 2026-05-07T20:00Z (Self-improvement /loop iteration 3: explanation invariant — TS type + persistence guard; first citation)

**Target category:** I (NEW BUG SURFACE — execute lumeyon's REAL #2 from iter-1's smoke).

**Peer used:** solo. The bug was specific enough (Answer.explanation typed as nullable despite recordAnswer enforcing non-empty) that a fresh peer call wasn't needed.

**Test-first protocol applied:**
  1. Wrote 3 regression tests at sqlite-store.test.ts:281-307 covering (null, empty-string, whitespace-only) explanation in putAnswer.
  2. Verified all 3 FAIL pre-fix (existing putAnswer accepted these silently — bug confirmed).
  3. Applied fix: types.ts Answer.explanation `string | null` → `string`; sqlite-store.ts putAnswer adds the same non-empty-string guard recordAnswer has.
  4. Verified all 3 PASS post-fix; full lattice suite 96 → 99 (+3).

**Schema migration BOSS-APPROVAL QUESTION (journaled per stopping condition 2):**
  The TS-side fix tightens the type and adds a runtime guard at putAnswer.
  But the SQL schema column is still `explanation TEXT` (nullable in DDL).
  In the production lattice (866 rows), all explanations are non-null
  (auto-imported placeholders or authored). Tightening to `TEXT NOT NULL`
  via migration is safe in DATA terms but is a destructive schema change
  on a live database. **Question for boss:** approve a migration step
  (CREATE TABLE answers_new with NOT NULL → INSERT INTO answers_new
  SELECT * FROM answers → DROP/RENAME) for the next iteration touching
  this area? Or accept the current state where the type+guard pair is
  the enforcement and the schema stays permissive? Iter-3 takes the
  conservative path (no schema change) until boss decides.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 1 (DUAL-OUTPUT) — recordAnswer with real explanation
  - ✅ Function 5 (FORMAT-UNIFORM) — quality_tier=2, validator_id=null, full provenance
  - ✅ **Citation DAG populated for the first time** — my new answer cites lumeyon's iter-1 review answer (parent=mine, child=lumeyon's). The DAG arrow says "this answer's reasoning rests on that prior answer's finding."

**Lattice metrics (BEFORE → AFTER) — TWO new metrics moved:**
  - Questions: 395 → 396 (+1)
  - Answers: 866 → 867 (+1 authored)
  - **AUTHORED: 1 → 2** (forcing function 1 exercised again)
  - **CITATIONS: 0 → 1** ← first ever — graph-structure metric finally non-zero
  - posed_by orion: 66 → 67
  - by_agent orion: 410 → 411

**Tests:** plugin 502/0/3 (no change), lattice 96 → 99 (+3 regression tests).

**Commit:** (this turn).

**WHAT'S NEXT (iteration 4):** Category C (POPULATE CITATION DAG) is now interesting because we've proven the DAG works end-to-end. Pick a recent answer in the lattice and identify its 1-3 prior-answer citations via lumeyon (codex). Goal: citations 1 → 4-5 in one iteration. After that, iter 5 can revisit lumeyon's REAL #3 (Question.status / best_answer_id consistency).

### 2026-05-07T19:55Z (Self-improvement /loop iteration 2: types.ts doc clarification + first authored answer)

**Target category:** I (NEW BUG SURFACE — execute lumeyon's REAL #1 from iter-1's smoke).

**Peer used:** solo. Lumeyon's iter-1 finding was specific enough that no fresh peer call was needed; the existing test at sqlite-store.test.ts:300 already documents the correct semantic interpretation.

**Fix:** types.ts QualityTier doc comment. Old: "filter to ≥3 for high-stakes contexts" (ambiguous; numeric reading INCLUDES the worst tiers). New: "pass `quality_tier_min: 3` for high-stakes contexts (returns tiers 1-3 — the top three quality levels — and excludes 4,5). Internally this becomes SQL `quality_tier <= 3`." Plus an explicit "Numeric ordering is INVERTED from quality ordering" paragraph.

**Dog-food check:**
  - ✅ Forcing function 1 (DUAL-OUTPUT) exercised: `recordAnswer()` enforced a non-empty explanation; I authored a real one (570 bytes) explaining WHY the parameter is named the way it is, citing the iter-1 finding and the existing test.
  - ✅ Forcing function 5 (FORMAT-UNIFORM ARTIFACTS) exercised: the new answer carries quality_tier=2 (peer-validated, since lumeyon raised the question), validator_id=null (could be promoted later), proper provenance.

**Lattice metrics (BEFORE → AFTER) — focus on authored_count:**
  - Questions: 394 → 395 (+1: my "what does quality_tier_min do" question)
  - Answers: 861 → 864 (+1 from this iteration's authored answer; +2 from background record-turns)
  - **AUTHORED: 0 → 1 (+1, the first ever)** ← the substantive metric move
  - Authored %: 0.0% → 0.1%
  - posed_by orion: 65 → 66
  - by_agent orion: 408 → 409 (+1 authored, the rest auto-imported from CONVO.md)

**Tests:** plugin 502/0/3 (no change), lattice 96/0 (no change). Doc-only code change.

**Commit:** (this turn).

**WHAT'S NEXT (iteration 3):** Category I — execute lumeyon's REAL #2 (Answer.explanation nullable type-hole). Multi-file change: types.ts (string | null → string), sqlite-store.ts schema (TEXT → TEXT NOT NULL via migration), audit putAnswer call sites. Write the test FIRST: a regression test that proves a bypass-via-putAnswer-with-null currently succeeds (it should), then tighten the type and verify the test fails to compile or rejects at runtime.

### 2026-05-07T19:45Z (Self-improvement /loop iteration 1: ephemeral-peer-review CLI)

**Target category:** infrastructure prerequisite — peer-review pipeline must exist before any "category A" iteration can run.

**Peer used:** lumeyon (real codex). Smoke test on `scripts/lattice/types.ts` succeeded at 19:46Z (~88s wall clock). Lumeyon returned 9 distinct findings — 3 graded REAL (queued for iter 2), 6 dismissed as design calls or refactor preferences per the QUALITY BAR rule:
  - **REAL #1:** `QualityTier` doc comment "filter to ≥3 for high-stakes" is semantically backwards in numeric reading (≥3 selects tiers 3,4,5 = the worst three). Fix: clarify the comment. One-line doc fix.
  - **REAL #2:** `Answer.explanation` is `string | null` despite recordAnswer requiring non-empty. Type-safety hole — anyone bypassing recordAnswer can write null. Fix: tighten to `string`, NOT NULL the schema, audit putAnswer call sites.
  - **REAL #3:** `Question.status` and `best_answer_id` not jointly constrained — the type allows nonsensical states (answered with null best_answer; open with non-null). Fix: discriminated union or runtime validator.
  - **DISMISSED #4-9:** depth-vs-DAG (design call: depth is denormalized fast-path), Question lacks tier/predictive_lift (design call: provenance is per-answer), Answer.cites missing (design call: future feature), first-class Explanation type (refactor preference), Question.embedding (design call: stored elsewhere), branded ID types (refactor preference).

**Built:** `plugins/agent-chat/scripts/ephemeral-peer-review.ts` (~360 lines) + `agent-chat ephemeral-peer-review` CLI wrapper + 10 tests (3 pure-function, 7 subprocess-based integration).

**Real bug caught via dog-food smoke:**
  - Symptom: codex timeout at 120s left the lumeyon-orion edge stuck on "orion" instead of "parked".
  - Root cause: error path called `turn.ts unlock` but not `turn.ts park`, so .turn was never reset.
  - Fix: error path now calls `turn.ts park` (atomically resets turn AND removes lock), with unlock fallback if park itself fails.
  - Regression test added; verified failing without the fix, passing with it.
  - Also bumped dispatch timeout from 120s → 240s (codex on a 30KB module legitimately takes 60-180s).

**Petersen routing constraint surfaced for boss sign-off:**
  - The /loop prompt's routing table maps "performance audits → vanguard". But vanguard is NOT a direct neighbor of orion in petersen (orion's neighbors: lumeyon, keystone, carina only).
  - Workaround: future performance reviews route to lumeyon (the designated systems analyst). Boss can change the routing table or authorize relay-through-keystone if vanguard is critical.
  - This is the kind of design call I'm flagging rather than silently improvising.

**Process bug caught (test design):** initial test file used in-process `runEphemeralPeerReview()` calls. CONVERSATIONS_DIR is frozen at module load, so the tests wrote to PRODUCTION lumeyon-orion / keystone-orion / carina-orion CONVO.md files instead of the tmpdir. Caught immediately by failing assertions; production state restored (3 files truncated to original line counts, carina-orion .turn reset to "parked"). Tests rewritten to use the subprocess pattern from cmd-run.test.ts with a new `AGENT_CHAT_MOCK_PEER_RESPONSE` env-var seam for hermetic happy-path coverage. **Lesson:** any future test that calls into in-process functions which touch CONVERSATIONS_DIR MUST use the subprocess pattern.

**Dog-food check:**
  - ✅ Built infrastructure that future iterations USE the substrate through.
  - ✅ Smoke test exercised the real codex runtime end-to-end on the production petersen graph.
  - ✅ Lattice grew (+1 Q, +1 A) — substrate metric MOVED.

**Tests:** before 495 / after 502 plugin (+7); lattice unchanged at 96.

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 391 → 392 (+1)
  - Answers: 860 → 861 (+1)
  - posed_by orion: 64 → 65
  - by_agent lumeyon: 356 → 357
  - Date range latest: extended to 2026-05-07T19:44:50Z
  - Authored count: 0 → 0 (the import always tags new content as auto-imported; future iter B work will demonstrate authored-explanation flow)

**Cosmetic bug caught + fixed:** import-stats regex in the CLI was looking for `questions_inserted=N` but the importer emits `questions: +N (already existed: M)`. Fixed in iteration 1 close-out commit. The actual import succeeded; only the CLI's reported count was wrong.

**Commits:**
  - `b08e63f` — feat(plugin): ephemeral-peer-review CLI (the iteration's coherent feature)
  - close-out commit (this turn) — regex fix + tracker docs + this journal entry

**WHAT'S NEXT (iteration 2):** Category I (NEW BUG SURFACE) — execute lumeyon's REAL #1 finding (one-line `types.ts` doc comment clarification). It's the smallest of the three real findings, fits cleanly in one commit, exercises the substrate (cite-back the lumeyon section in the commit message). Then iteration 3 picks REAL #2 (the explanation-not-null type tightening).

### 2026-05-07T19:00Z (Alt A polish iteration)

- Built `scripts/lattice/stats.ts` and wired `agent-chat lattice-stats [--db <path>] [--json]` into the CLI. Surfaces the global lattice's contents:
  - Question/answer totals
  - By-status / by-posed_by / by-agent distributions
  - Date range, depth distribution
  - Quality-tier breakdown
  - Authored vs auto-imported counts and percentage
  - predictive_lift histogram (min/max/mean/median)
  - Citation and question-parent DAG sizes
  - Both human-readable markdown and `--json` for downstream tooling
- 7 unit tests in `scripts/lattice/stats.test.ts`; all pass
- Real-data exercise against production lattice (`bun agent-chat.ts lattice-stats`):
  - 387 questions, 852 answers, 3.5MB DB
  - 6 distinct posed_by (boss=257, orion=64, lumeyon=24, carina=20, keystone=19, rhino=3)
  - 10 distinct by_agent (orion=400, lumeyon=356, keystone=28, carina=20, vanguard=10, lyra=9, cadence=8, sentinel=8, pulsar=7, rhino=6)
  - 100% auto-imported (authored=0) — confirms the visibility the lattice needs to grow into authored-quality content
  - All depth=0 (no recursive subgraph spawning yet)
  - All quality_tier=5 (raw)
  - Citations=0, question_parents=0 (DAG structure unpopulated; future work)
- Added `AGENT_CHAT_DEBUG_PROMPT=1` switch to cmdRun: when set, logs the full composed prompt to stderr right before dispatch. Lets future integration tests assert on the ALT-A-2 pushed-context-block wiring without intrusive instrumentation. Default off; production runs see no extra output.
- Plugin tests: 495 pass / 0 fail
- Lattice tests: 96 pass (was 89; +7 stats tests)
- Loop CONTINUES — next iteration could:
  - Author a small set of real explanations to demonstrate study-turn passing predictions
  - Add citation-DAG population to the importer (currently 0 citations)
  - Implement the lattice merge tool (cross-instance mergeability)
  - Or: pivot to quantum-substrate Alt-B work if you redirect

### 2026-05-07T18:25Z (Alt A iteration 3)

- Built `scripts/lattice/study-turn.ts` — Apprenticeship Substrate forcing function 2 orchestration (recreated from the deleted iter-15 scaffold + finished)
- Five exported pieces:
  - `selectStudyQuestions(store, options)` — picks K candidates from the lattice. Filters by status, quality_tier, exclude_agent. Skips auto-imported placeholder explanations by default; `require_authored_explanation: false` opt-in for import-only lattices.
  - `buildStudyPrompt(candidate)` — formats the StudyChallenge for the predictor.
  - `gradePrediction(prediction, actual, threshold=0.85)` — embedding-cosine grader using vendored MiniLM. Cheap (no LLM call), deterministic.
  - `applyGradeToLift(store, answer_id, grade, lr)` — updates predictive_lift via signed signal (`(cosine - 0.5)*2 * lr`), clamped to [0, 1].
  - `runStudyTurn(store, predictor, options)` — full orchestration, returns per-candidate results.
- Two built-in LLM-backed predictors: `claudePredictor` and `codexPredictor` wrapping the existing `runtimes/claude.ts` and `runtimes/codex.ts` adapters. The `Predictor` type is also exported as an injectable interface so test mocks can stand in.
- New CLI: `agent-chat study-turn [--n K] [--runtime claude|codex] [--dry-run] [--exclude-agent <name>] [--quality-tier-min N] [--include-auto-imported]`. Defaults: n=5, runtime=$AGENT_CHAT_RUNTIME or claude. Hard cap at n≤50 (LLM-budget guard).
- 16 unit tests in `scripts/lattice/study-turn.test.ts` (all pass) covering: selectStudyQuestions filtering / exclude_agent / empty lattice; buildStudyPrompt packing; gradePrediction identical-strings / very-different / empty-input; applyGradeToLift bump-up / drop / neutral / [0,1] clamp; runStudyTurn full orchestration with fake predictors / dry-run / empty / challenge-shape inspection.
- Caught and fixed a real production bug along the way: `quality_tier_min: null` was passed to the SQL filter, which builds `quality_tier <= NULL` (always falsy) instead of skipping the filter. Defended both at the CLI layer (treat null as "no filter") and at the store layer (defensive null-check in queryAnswers).
- **Real-LLM end-to-end smoke** — `bun agent-chat.ts study-turn --n 3 --dry-run --runtime claude --include-auto-imported`:
  - Runtime resolved to claude (claude binary on PATH at `/home/eyon/.local/bin/claude`)
  - 3 candidates selected from the production lattice
  - 3 real `claude -p` calls executed
  - Each prediction graded via embedding cosine: 0.624, 0.651, 0.416 (avg 0.564)
  - Results table emitted; dry-run correctly kept predictive_lift unchanged
  - Predictions don't reach the 0.85 pass threshold — expected, because production lattice has conversational-shape Q/A (statements/directives, not curated study material). Mechanics are verified end-to-end.
- Plugin tests: 495 pass / 0 fail (no change in count — study-turn.ts lives at top-level scripts/, not under plugins/)
- Lattice tests: 89 pass (was 73; +16 new study-turn tests)
- Forcing function 2 (mandatory study turns) is now ALIVE in the codebase. The substrate's full forcing-function-set is operational:
  - 1 dual-output: enforced by `recordAnswer` at the apprenticeship API layer ✓
  - 2 study turns: `agent-chat study-turn [--n K]` with real LLM ✓ **NEW**
  - 3 selection pressure: `reRankAnswers` lift-based promotion ✓
  - 4 cross-domain push: wired into `cmdRun` (ALT-A-2) ✓
  - 5 format-uniform artifacts: schema-design level (Phase 5/6) ✓
- **Alternative A is COMPLETE.** The agent-collaboration substrate works end-to-end on real data. The codebase is now ready for the architectural patterns to inherit into quantum-substrate.

### 2026-05-07T17:55Z (Alt A iteration 2)

- Built `plugins/agent-chat/scripts/lattice-context.ts` — helper module bridging cmdRun to the global lattice's pushContext()
- Two exported functions:
  - `composePushedContextBlock({query, latticeDbPath, k, exclude_agent, ...})` — returns formatted markdown block with top-K prior Q/A from the lattice. Empty string if lattice missing, query empty, or no peer hits after filtering.
  - `extractMostRecentPeerBody(sections, myAgentName)` — walks CONVO.md sections in reverse, finds the most recent peer (not-this-agent) section's body. Used as the natural retrieval query (what THIS agent is about to respond to).
- Wired into `agent-chat.ts:cmdRun` in the prompt-composition pipeline: `roleBlock + ... + pushedContextBlock + tailBlock`
  - Lazy-imported so the module loads only when cmdRun is invoked
  - Lattice retrieval failures are caught and logged but never block the response cycle
  - Each pushed answer truncated to 600-byte body budget so the block stays bounded
  - Auto-imported placeholder explanations are stripped (they're noise that would crowd out signal)
- 12 new tests in `plugins/agent-chat/tests/lattice-context.test.ts`; all pass:
  - `extractMostRecentPeerBody`: 5 tests covering peer extraction, self-exclusion, malformed sections, AI-to-AI dialog
  - `composePushedContextBlock`: 7 tests covering missing DB, empty query, no priors, formatted output, agent-self exclusion, peer-vs-self mixed, auto-imported-explanation suppression
- **Real-data end-to-end smoke** against the production lattice (386Q/846A):
  - Query: "What is the deadline?"
  - Result: 3 hits returned, formatted block produced (2640 chars)
  - Top hits ranked by embedding cosine (0.36, 0.25, 0.24)
  - Auto-imported explanations correctly suppressed
  - Orion's own answers correctly excluded — top hits are by lumeyon, keystone, vanguard
  - Confirms pushContext flows end-to-end against real production data
- Plugin tests: 495 pass / 0 fail (was 480; added 12 new + 3 unrelated tests appearing in the run)
- Lattice tests: 73 pass (was 67; one of those moved from a different file count or the AI-to-AI tests added 6 new ones)
- The forcing function 4 (cross-domain push) is now ALIVE in the runtime: every agent response is preceded by automatic retrieval of relevant prior Q/A from the lattice. The substrate pushes; the agent doesn't query.
- Loop CONTINUES — next iteration starts ALT-A-3 (study turn loop)

### 2026-05-07T17:30Z (Alt A iteration 1)

- Read sample AI-to-AI sections from `/data/lumeyon/agent-chat/conversations/petersen/lumeyon-orion/archives/leaf/`. Pattern: each section has `## <agent> — <topic> (UTC <iso>)` header and an arrow trailer. Adjacent different-agent sections form a Q→A pair.
- Extended `scripts/lattice/import-from-kg.ts:pairSections()` to recognize TWO patterns:
  - **human → AI** (existing): `user turn` → `assistant response`
  - **AI → AI** (new): adjacent different-agent sections, neither a handoff/park/proposal, with arbitrary topic descriptions
- Added `kind: "human_to_ai" | "ai_to_ai"` to `QAPair` so downstream tagging is preserved
- Skip-already-consumed logic so 4-section back-and-forths produce 2 pairs not 3
- Filter list of non-Q/A description prefixes: `handoff`, `park`, `parked`, `parking`, `propose subgraph`, `subgraph spawn`
- 6 new tests in `import-from-kg.test.ts` covering: AI-to-AI basic, 4-section sequence (consume-and-skip), handoff rejection, parking rejection, same-agent rejection, mixed human→AI / AI→AI sequence
- Test totals: 23 import tests, all pass (was 17 + 6 new)
- All 67 lattice tests still pass; full plugin suite still green
- **Production import validation:**
  - Before: 252 questions, 693 answers (5 distinct posed_by/by_agent participants — boss + 4 AI agents had answered)
  - After:  386 questions, 846 answers (+130 / +141, distributed across 10 distinct AI agents now answering)
  - Previously-empty AI-to-AI edges now contribute meaningful Q/A:
    - `petersen/lumeyon-orion` archives: +29Q +36A
    - `petersen/keystone-orion`: +23Q +27A
    - `petersen/carina-orion`: +24Q +24A
    - `petersen/lumeyon-sentinel`: +8Q +8A
    - `petersen/keystone-vanguard`: +10Q +10A
    - `petersen/keystone-rhino`: +9Q +9A
    - `petersen/cadence-carina`: +8Q +8A
    - `petersen/carina-pulsar`: +7Q +7A
    - `pair/lumeyon-orion`: +3Q +3A
- The lattice now contains agent-to-agent dialogue alongside human-to-AI Q/A. New participant distribution:
  - `posed_by`: boss=256, orion=64, lumeyon=24, carina=20, keystone=19, rhino=3
  - `by_agent`: orion=394, lumeyon=356, keystone=28, carina=20, vanguard=10, lyra=9, cadence=8, sentinel=8, pulsar=7, rhino=6
- Loop CONTINUES — next iteration starts ALT-A-2 (pushContext wired into runtime)
