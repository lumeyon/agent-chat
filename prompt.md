# Autonomous heterogeneous-judge selection pressure — wiring loop

> **Mission (NL34+):** wire up the autonomous selection-pressure loop so it
> runs without human invocation, using codex peers as heterogeneous judges
> against claude-orion's outputs. The substrate primitives all exist
> (study-turn, reRankAnswers, applyGradeToLift, ephemeral-peer-review,
> codex runtime adapter); the missing thing is the *trigger* and the
> *default-to-peer* wiring. Each iter ships one concrete piece.
>
> Heterogeneity is already there: petersen topology assigns codex to all
> 9 peers (lumeyon, keystone, carina, etc.); orion is claude. The 30
> findings drained at NL3-NL33 were surfaced by codex-as-judge of
> claude-orion's substrate code. The same heterogeneity must now drive
> the SELECTION step (predictive_lift updates), not just the AUDIT step
> (peer reviews).

Each iter: read this file → ship the next wiring step → update this file with state for the iter after.

## INVIOLABLE RULES (each iter must satisfy ALL)

1. **TESTS-FIRST.** Run `bun test plugins/agent-chat/tests/ && bun test scripts/lattice/` at the start. If red, root-cause and fix before any other work. Going-red mid-iter = revert that iter's changes and journal "couldn't apply wiring step without breaking tests."

2. **ONE WIRING STEP PER ITER.** Each iter ships ONE concrete piece from the WIRING TASKS list below. Don't bundle. If a step is too big, split it into sub-steps and journal the boundary.

3. **TEST-FIRST FOR EVERY WIRING STEP.** Write the regression test FIRST (asserting the new auto-behavior); verify it FAILS pre-fix; ship the wiring; verify it PASSES post-fix. Same protocol that drained the 30 peer findings.

4. **DIFFERENT FILE THAN PREVIOUS ITER.** Each iter's primary touched file ≠ the previous iter's primary touched file. (Test files don't count for this rule.) If the only fresh wiring is in the same file as last iter, journal "approaching saturation" and STOP.

5. **HETEROGENEITY-FIRST DEFAULT.** When the wiring picks a peer agent for predictor, judge, or challenger, the default MUST be a codex peer (lumeyon, keystone, or carina). Never default to claude (= orion self-predicting). The "prediction comes from a different model family than the original answer" property is the load-bearing claim of this whole effort; don't compromise it.

6. **MEASUREMENT-AT-MILESTONES.** After Phase A ships, measure: are predictive_lift values actually moving for any answer in the production lattice? After Phase B ships, measure: do the codex predictions correlate with cosine grades? After Phase C ships, measure: does LLM-judge produce different rankings than cosine on a sample? Without measurement the wiring is just plumbing — we need evidence the autonomous loop produces useful signal.

## STUDY-TURN DISPATCH RESILIENCE

- **Attempt 1:** codex runtime, 90s budget (study-turn predictor default).
- **On failure:** retry ONCE with 180s budget on same peer.
- **On second failure:** journal as substrate-health finding; don't block the per-turn user response. The auto-study-turn is async/non-blocking by design.

## PEER ROTATION (only counts when a fresh peer is dispatched)

| Predictor cycle | Peer | Specialty fit |
|---|---|---|
| N | lumeyon (codex) | general correctness, structural pattern recognition |
| N+1 | keystone (codex) | SQL, schema, protocol invariants |
| N+2 | carina (codex) | embeddings, cosine math, grading thresholds |
| N+3 | cycle |

For high-stakes judges (Phase C+ LLM-as-judge), use a DIFFERENT codex peer than the predictor. Never let the predictor and judge be the same agent — defeats heterogeneity.

## CURRENT STATE (as of NL33 end of prior loop)

**Substrate primitives — already built:**
- `runStudyTurn(predictor, ...)` orchestrates predict → grade → apply.
- `claudePredictor` and `codexPredictor` are both exported from study-turn.ts; runStudyTurn takes a predictor function as a parameter.
- `applyGradeToLift` adjusts predictive_lift; symmetric NL32 fix means |delta| ≤ learningRate regardless of cosine sign.
- `reRankAnswers` promotes top-lift answer to accepted, demotes others to superseded. Single-answer + multi-answer branches both update the question's lifecycle (NL17 fix).
- `ephemeral-peer-review` CLI dispatches a codex peer against a module path; resilient to dispatch failure (E1-E7 fixes NL14-NL30).
- `record-turn` fires on every per-turn user/assistant exchange, lands content in CONVO.md.
- `importEdgeIntoLattice` runs after ephemeral-peer-review; reads the WHOLE edge and inserts new (Q, A) pairs into the lattice DB.

**What's NOT wired yet:**
- record-turn does NOT trigger study-turn after new content lands.
- study-turn's predictor default is not enforced as "codex peer" — callers can pass any predictor function.
- There's no LLM-as-judge mode (cosine is the only grader).
- There's no challenger loop.
- There's no measurement of whether predictive_lift actually shifts in useful directions.

**Production state:**
- Lattice: 425 questions, 961 answers (carina-orion edge has 26 unique).
- Tests: lattice 174 / 0; plugin 543 / 0.
- 6 peer-reviewed modules fully cleared (apprenticeship, sqlite-store, study-turn, ephemeral-peer-review, import-from-kg, lattice-context).

## WIRING TASKS

Phases run roughly in order; cross-phase tasks fine if they don't conflict on the file-touch rule.

### Phase A — Auto-trigger study-turn on record-turn (cheapest, mostly plumbing)

- **A1** [DONE iter NL34]: Added record-turn post-hook that, on AGENT_CHAT_AUTO_STUDY_TURN=1, appends a `scheduled` entry to `<conversationsDir>/.auto-study-turn.jsonl` with edge_id, agent, speaker, framing, answer_body, ts, status. Idempotent skip (sha-deduped re-record) does NOT fire the hook. Best-effort: journal-write failure is logged to stderr but doesn't block record-turn success. 5 regression tests at append-turn.test.ts.
- **A2** [TODO]: The schedule entry needs to be CONSUMED. Add a child process that reads the journal, picks the oldest `scheduled` entry, dispatches a codex peer (rotation: lumeyon → keystone → carina) as the study-turn predictor, applies the grade, marks the entry `predicted` in the journal. Consumer is async/detached; record-turn doesn't await.
- **A3** [TODO]: After applyGradeToLift writes new lift values, auto-fire reRankAnswers for the affected question. If reRank changes accepted/superseded, mark the journal entry `reranked` with the promotion details. Closes the auto-loop.
- **A4** [DONE in A1]: Feature flag `AGENT_CHAT_AUTO_STUDY_TURN=1` opt-in (default off) — landed alongside A1 to keep per-turn LLM cost zero by default.

### Phase B — Default study-turn predictor to a codex peer

- **B1** [TODO]: `agent-chat study-turn` CLI: change default predictor from "current process predicts" to "dispatch to a codex peer". Make it explicit which peer via a `--predictor-peer <name>` flag with a sensible default.
- **B2** [TODO]: For runStudyTurn-as-library, expose the predictor function as a required argument (no default) so callers can't accidentally fall through to claude-orion-self-predicts. Update existing callers.
- **B3** [TODO]: When the answer-being-tested was authored by orion (claude), refuse to use a claude predictor — the heterogeneity property must hold. Throw with a clear error message.

### Phase C — LLM-as-judge layered on cosine

- **C1** [TODO]: Add a `--judge-mode <cosine|llm|both>` flag to study-turn. `cosine` = current behavior. `llm` = dispatch a codex peer (different from predictor) to rate prediction 0-1 vs actual. `both` = run both, take a weighted average (signal blended with noise control).
- **C2** [TODO]: For high-stakes questions (quality_tier=1), default to `--judge-mode both`. For routine, default to `--judge-mode cosine` (cheap baseline).
- **C3** [TODO]: Persist the judge's rationale alongside the grade so we can audit later: "why did the LLM-judge rate this 0.4 instead of 0.8?"

### Phase D — Adversarial challenger loop (autonomous, periodic)

- **D1** [TODO]: New `agent-chat challenge` CLI. Picks the top-N most-queried questions (track query frequency in the lattice OR pick by stale-lift heuristic). For each, dispatch a codex challenger to write an alternative answer.
- **D2** [TODO]: Dispatch a third codex peer to judge old-vs-new. Winner via reRankAnswers becomes accepted; loser becomes superseded.
- **D3** [TODO]: Cron-driven nightly run via `/schedule challenge`. Bounded cost: top-10 questions per night.

### Phase E — Measurement

- **E1** [TODO]: Add a `lift_history` table (or column) to the lattice — record (answer_id, old_lift, new_lift, source, timestamp) on every applyGradeToLift call. Without this we can't measure "did the auto-loop actually shift lifts?"
- **E2** [TODO]: A `agent-chat lift-report` CLI that summarizes lift trajectories. Did the auto-loop produce useful signal in the past N days?
- **E3** [TODO]: A/B comparison: pick K questions; run pushContext with the autonomous-loop-influenced lattice vs a snapshot from before the loop. Did the loop change which answers got pushed? Did the change look like an improvement?

## NEXT ITER TARGET HINT

**NL35 → SHIP A2 (journal consumer that dispatches a codex peer as study-turn predictor).**

**Why A2 next:**
- A1 wrote the schedule entries; A2 makes them DO something. Without A2, the .auto-study-turn.jsonl file accumulates "scheduled" entries forever and nothing actually runs.
- The dispatch is async/detached so the per-turn flow stays fast.
- Heterogeneity-first default: predictor MUST be a codex peer (per INVIOLABLE rule 5). Use the rotation table (lumeyon → keystone → carina → cycle) to pick the peer per call.

**Design sketch:**
- New file: `plugins/agent-chat/scripts/auto-study-turn-consumer.ts`. CLI that reads `.auto-study-turn.jsonl`, picks the oldest `status: "scheduled"` entry, dispatches a codex peer via the runtime adapter to predict the answer given the question framing, grades the prediction (cosineSimilarity for now; LLM-as-judge in Phase C), updates the journal entry to `predicted` with the grade, and writes a result line to a sibling `.auto-study-turn-results.jsonl`.
- Consumer runs as a detached child spawned from the same record-turn post-hook OR via `agent-chat auto-study-turn-tick`. Pick simplest: a CLI command that processes ONE pending entry and exits. The post-hook spawns it; cron / interval can also run it.
- File-touch rule: NL34 touched plugins/agent-chat/scripts/agent-chat.ts; NL35 must touch a different primary file. Good — the new consumer file IS different.

**Read first:**
- `scripts/lattice/study-turn.ts` — `runStudyTurn`, `claudePredictor`, `codexPredictor`.
- `plugins/agent-chat/scripts/runtimes/codex.ts` — codex dispatch adapter.
- Rotation table peers: lumeyon, keystone, carina (all codex per agents.petersen.yaml).

**Test approach (3 regression tests):**
- Test 1 (consumer happy path): seed a `.auto-study-turn.jsonl` with one `scheduled` entry. Mock the codex dispatcher to return a known prediction. Run the consumer. Assert: (a) the journal entry is updated to `predicted` with a grade; (b) a results line was emitted; (c) the lattice's predictive_lift was updated for the affected answer.
- Test 2 (heterogeneity guard): if AGENT_CHAT_AUTO_STUDY_TURN_PEER is forced to a non-codex agent (or to the answer's own agent), the consumer refuses with a clear error. Heterogeneity must hold.
- Test 3 (consumer failure non-blocking): mock codex dispatch to fail. The consumer marks the entry `failed` with the error; doesn't crash; doesn't pollute other entries.

**Sequenced after A2:**
- NL36 → A3 (auto-reRank after lift update).
- NL37 → wire the consumer to fire from record-turn's post-hook (currently only the journal write happens).
- NL38+ → Phase B, C, D, E.

## BOSS-PRE-APPROVAL QUEUE (orion may execute without re-asking)

- All Phase A, B, C wiring tasks above.
- Default study-turn predictor = codex peer when answer was authored by claude.
- New CLI surface: `agent-chat study-turn --predictor-peer`, `--judge-mode`, `agent-chat challenge`, `agent-chat lift-report`.
- New env flags: `AGENT_CHAT_AUTO_STUDY_TURN`, possibly `AGENT_CHAT_JUDGE_MODE`.
- `lift_history` table addition (Phase E1) — schema migration v4→v5.

Phase D (adversarial challenger) ships ONLY after Phase A+B+C are landed AND measurement (E1+E2) shows the auto-loop is producing useful signal. Don't run unsupervised challengers against the production lattice until we've measured the cheap-loop's behavior.

## STOPPING CONDITIONS

1. Tests go red AND 2 wiring attempts fail.
2. Same-file-as-previous-iter trip (rule 4).
3. 3 iterations in a row produce no metric delta AND no wiring shipped.
4. Phase A through C all landed AND a measurement run (Phase E1+E2) shows the auto-loop is actually shifting predictive_lift in defensible directions → "wiring complete" summary commit and STOP. (Phase D is post-completion polish.)
5. Phase A or B reveals a fundamental design flaw in the substrate primitives → spawn depth>0 question to boss + STOP.

## CADENCE: 1500s.

## LESSONS LEARNED (cumulative — carried forward from prior loop)

- **Heterogeneity-first default.** lumeyon/keystone/carina = codex; orion = claude. The 30 prior findings were already cross-model audit evidence. The new mission applies the same heterogeneity to the SELECTION step (lift updates), not just the AUDIT step (peer reviews).
- **Investigate before fixing.** A "real bug" can turn out to be a metric misinterpretation (K-imp-9 lesson at NL33). Reproduce the failure mode before writing code.
- **Don't drop function returns and re-query.** Capture what's already there (K-imp-6/7 lesson). Same principle applies to Phase A: when record-turn lands a new (Q, A), pass the IDs directly to the auto-study-turn — don't re-query the lattice for "what just got inserted."
- **Aggregate-then-process > per-source loops when sources can interact** (K-imp-3 lesson). Phase D's challenger loop should pick its target questions by walking the WHOLE lattice, not by per-edge sampling.
- **Validate at API boundaries, not at consumption sites** (E6 = LC4 = L5 lesson). New CLI flags (`--predictor-peer`, `--judge-mode`) must validate inputs explicitly; don't trust slice/encode/comparison to fail gracefully.
- **Counts and emission must agree** (LC2 = LC3 lesson). When the auto-loop reports "study-turns fired today: N", that count must match the actual journal entries — don't let async fire-and-forget hide failures behind a happy total.
- **Test-first verifies failure pre-fix.** Loose assertions (toContain matching even after corruption) are pre-fix-passing tautologies, not regressions. Always confirm test fails BEFORE shipping the wiring.
- **Cumulative ledger (post-NL33):**
  - 30 / 30 original peer findings fixed across NL3-NL33.
  - 1 design-call drained (C4).
  - 1 post-review observation resolved (K-imp-9).
  - 3 schema migrations shipped.
  - 6 / 6 peer-reviewed modules cleared.
  - Substrate is in green-test, hardened state. Next mission: make the selection-pressure forcing function autonomous.

## NO synthetic work. NO speculative wiring beyond what's tested. The job is to go from "primitives exist" to "autonomous loop runs daily and produces measurable signal." Each iter ships one verifiable step toward that.
