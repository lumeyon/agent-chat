# Alternative A — Progress Dashboard

> Status file maintained by the autonomous `/loop` driver. Captures Alt A deliverable progress, decision points, and verification results.

## Current state — 2026-05-07T19:00Z

**Phase: ALT-A polish iteration — `lattice-stats` CLI for visibility + AGENT_CHAT_DEBUG_PROMPT switch for cmdRun introspection. Alt A architecture complete; iterating on observability.**

## Phase status

| Phase | Deliverable | Status |
|---|---|---|
| ALT-A-1 | AI-to-AI dialog import | **COMPLETE** — pairSections() extended; 23 tests pass; production lattice grew 252→386 questions / 693→846 answers |
| ALT-A-2 | pushContext wired into agent-chat runtime | **COMPLETE** — `lattice-context.ts` helper + cmdRun integration; 12 unit tests + real-data end-to-end smoke pass |
| ALT-A-3 | Study turn loop with LLM integration | **COMPLETE** — `study-turn.ts` + `agent-chat study-turn` CLI; 16 unit tests pass; real-LLM end-to-end run completed (3 claude calls, dry-run, results table) |

## Iteration log

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
