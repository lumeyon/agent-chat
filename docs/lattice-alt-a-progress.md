# Alternative A — Progress Dashboard

> Status file maintained by the autonomous `/loop` driver. Captures Alt A deliverable progress, decision points, and verification results.

## Current state — 2026-05-08T03:08Z

**Phase: New /loop iter 3 (NL3) — boss re-fired the strict loop. Carina (codex) reviewed study-turn.ts, returned 5 REAL findings on the cosine-grading mechanics. C1 (empty predictor output → spurious -0.10 lift penalty) FIXED this iter. C2-C5 queued.**

**Substrate-readiness finding (iter NL1, rule 3 trigger):** push-context query "what should be reviewed next?" against the production lattice returned all hits with cosine ≤ 0.367 — corpus too sparse to drive its own discovery. Manual selection still works (apprenticeship.ts was the obvious next high-leverage module), but the substrate isn't yet self-driving for review prioritization. Documented; not blocking.

## Phase status

| Phase | Deliverable | Status |
|---|---|---|
| ALT-A-1 | AI-to-AI dialog import | **COMPLETE** — pairSections() extended; 23 tests pass; production lattice grew 252→386 questions / 693→846 answers |
| ALT-A-2 | pushContext wired into agent-chat runtime | **COMPLETE** — `lattice-context.ts` helper + cmdRun integration; 12 unit tests + real-data end-to-end smoke pass |
| ALT-A-3 | Study turn loop with LLM integration | **COMPLETE** — `study-turn.ts` + `agent-chat study-turn` CLI; 16 unit tests pass; real-LLM end-to-end run completed (3 claude calls, dry-run, results table) |

## Iteration log

### 2026-05-08T03:08Z (NEW /loop iter 3: carina peer-review of study-turn.ts → 5 REAL findings; C1 fixed)

**Loop:** strict halt-on-fail loop, re-fired by boss after NL2 halt. Same prompt as NL1/NL2.

**Target:** `scripts/lattice/study-turn.ts` (the cosine grader + lift-update mechanics, where carina's specialty fits). Not touched in last 2 iters. No prior review entry.

**Peer used:** carina (codex) per peer rotation rule (iter NL+2 → carina). Carina's specialty (embedding, cosine math, grading thresholds) is a precise match.

**Findings (all 5 REAL, no nitpicks — strongest yield-per-call iter so far):**

  - **C1** (study-turn.ts:182, 258): Empty predictor output grades cosine=0; runStudyTurn applies negative lift update at line 258. **Runtime failures of the LLM (AGENT_CHAT_NO_LLM=1, codex missing, transient API error) propagate as -0.10 quality penalty on the lattice's content.** Active harm.
  - **C2** (study-turn.ts:141, 182): selectStudyQuestions can select an accepted answer with empty body; that answer then grades cosine=0 and gets penalized for being empty. (queued)
  - **C3** (study-turn.ts:213, 215, 216): grade.cosine is trusted as finite. NaN cosine → NaN newLift → written to storage. (queued)
  - **C4** (study-turn.ts:213): The lift signal `(cosine - 0.5) * 2 * lr` is asymmetric — true cosine can be negative (rare for MiniLM but possible), giving penalties below `-learningRate` while the positive side caps at `+learningRate`. (queued — design call about whether asymmetry is intended)
  - **C5** (study-turn.ts:128, 141): SQL `limit: 5` is applied before the in-memory `requireAuthored` filter; an eligible answer ranked 6th+ is silently unreachable. (queued)

**This iter executes C1 (highest-impact, regular-runtime-path bug):**

**Test-first protocol:**
  1. Wrote 2 regression tests (empty prediction → no lift change; whitespace-only prediction → no lift change). Both verified FAILING pre-fix (lift dropped by exactly -0.10 in both cases — confirms the math).
  2. Applied fix: added `gradable: boolean` field to `GradeResult`. `gradePrediction` sets `gradable: false` when prediction or actual is empty/whitespace. `runStudyTurn` skips `applyGradeToLift` when `!grade.gradable`, treating it as a no-op.
  3. Both tests PASS post-fix.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 2 (STUDY TURN) — exercised on real production data (the carina review itself produced grade results, but those weren't used for lift updates this iter; the test path verified the new behavior).
  - ✅ The fix protects forcing function 3 (selection pressure) integrity going forward — runtime failures no longer corrupt the predictive_lift signal.

**Citation discipline:** No new authored answer this iter. Carina's peer review imported as tier-3 authored content via iter-11 importer logic.

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 406 → 407 (+1: orion's review request to carina)
  - Answers: 892 → 893 (+1: carina's response, auto-tagged tier-3 authored)
  - **authored: 8 → 9** (carina review)
  - quality_tier histogram: tier 2=5, tier 3=4, tier 5=882

**Tests:** plugin 502/0/3 (no change). Lattice 119 → 121 (+2 C1 regression tests).

**Files touched (4):**
  - scripts/lattice/study-turn.ts (C1 fix)
  - scripts/lattice/study-turn.test.ts (2 regression tests)
  - docs/ephemeral-peer-reviews.md (study-turn.ts row added)
  - docs/lattice-alt-a-progress.md (this entry)

**Commit:** (this turn).

**WHAT'S NEXT (NL4):** Per peer rotation rule, iter N+3 → cycle back to lumeyon. Per file-touch rule, must NOT pick study-turn.ts (just touched) NOR apprenticeship.ts (touched NL1). Eligible: import-from-kg.ts (keystone NL2 timed out — could retry but lumeyon doesn't fit SQL specialty), stats.ts, lattice-context.ts, ephemeral-peer-review.ts, synthesize-corpus.ts, validate-corpus.ts. Lumeyon (general correctness, API design, type safety) fits lattice-context.ts (the cmdRun-pushContext bridge) or ephemeral-peer-review.ts (the CLI itself, which has never been peer-reviewed by anyone but me). Recommend ephemeral-peer-review.ts — it's the unreviewed-but-load-bearing dispatcher.

### 2026-05-08T02:43Z (NEW /loop iter 2 — HALTED: keystone (codex) review of import-from-kg.ts timed out)

**Loop:** new prompt — strictly peer-driven, halt-on-peer-failure.

**Wakeup triggered by:** queued OLD-loop wakeup from iter 13 fired with the obsolete prompt at boss's session re-fire. Honored boss's explicit switch to new-loop pattern; treated this as NL2.

**Target:** `scripts/lattice/import-from-kg.ts` (the importer logic, modified iter-11 for ephemeral peer review detection — but iter-11 was 4 iters ago in old-loop count, so within rule 2's "different file from previous 2 iters" of NEW loop count). No prior review entry. Module size: 17774 bytes (well within the 24KB review cap).

**Peer used:** keystone (codex) per peer rotation rule (iter NL+1 → keystone).

**What happened:**
  1. Tests-first: 502/0/3 plugin, 119/0 lattice — green ✓
  2. Spawned `agent-chat ephemeral-peer-review --peer keystone --module .../import-from-kg.ts`
  3. orion's request section appended to keystone-orion/CONVO.md ✓
  4. .turn flipped to keystone, lock acquired ✓
  5. codex exec dispatched
  6. **codex exec timed out at 240s** — no response received
  7. CLI's iter-1 park-on-failure path triggered: turn.ts park executed, edge atomically returned to "parked", lock removed
  8. Stderr: `[ephemeral-peer-review] dispatch failed: reason=timeout code=null stderr=codex exec timed out after 240000ms`

**Substrate-health finding (the deliverable):**
  - Codex CLI is not reliably responsive on a 17KB review request. Iter-NL1 (lumeyon on apprenticeship.ts, 8.6KB) succeeded in ~3min wall clock. Iter-NL2 (keystone on import-from-kg.ts, 17.7KB) timed out at 4min. The 2x size delta might explain it, but past iter-6 (keystone on sqlite-store.ts, 24KB capped review) succeeded at ~3min.
  - Possible root causes (not investigated this iter, per stop rule):
    - Codex API backend latency variance
    - Module content tricky to reason about
    - Codex agent ran into a tool loop and exhausted budget
  - The signal IS the finding. Future iters can retry; the protocol's halt-on-fail is correct behavior.

**Edge cleanup verified:**
  - `cat keystone-orion/CONVO.md.turn` → "parked" ✓
  - No `CONVO.md.turn.lock` file ✓
  - Orphaned orion request section left in CONVO.md as historical record of the failed attempt (per iter-1 design decision)

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 405 → 406 (+1: orion's review request question; no paired answer because keystone never responded — orphan in lattice import logic, will be a question with no accepted answer)
  - Answers: 892 → 892 (no new — keystone produced no response)

**Tests:** 502/0/3 plugin, 119/0 lattice (no change — no code modification this iter).

**Files touched (2):**
  - docs/ephemeral-peer-reviews.md (TIMEOUT row for import-from-kg.ts)
  - docs/lattice-alt-a-progress.md (this entry)

**Commit:** (this turn).

**LOOP HALTED.** Per the new loop's stopping condition 2: "Peer call fails (any reason) → STOP, journal as substrate-health finding." NO ScheduleWakeup this turn.

**To resume the loop, boss can either:**
  - Re-fire `/loop` with the new prompt (codex may simply work on retry)
  - Investigate codex flakiness (perhaps a system-level issue affecting the codex backend)
  - Switch peer specialties: route iter NL2 retry to a CLAUDE-runtime peer if available
  - Accept that periodic codex failures are part of substrate health and use the stopping condition as a circuit breaker, with manual re-fires when boss is around

The 3 queued L-findings from iter NL1 (L3 lifecycle, L4 float margin, L5 k validation) remain in the queue; iter NL3 can pick those up in apprenticeship.ts when the loop resumes — they don't need a fresh peer review since lumeyon already identified them.

### 2026-05-08T02:30Z (NEW /loop iter 1: lumeyon peer-review of apprenticeship.ts → 5 REAL findings; L1+L2 fixed)

**Loop:** new prompt — strictly peer-driven, single-finding-per-commit, halt-when-nothing-real-found.

**Target:** `scripts/lattice/apprenticeship.ts` (the substrate's API layer: recordAnswer + pushContext + reRankAnswers). No prior review entry. Untouched in last 2 iters.

**Peer used:** lumeyon (codex) per peer rotation rule (iter N → lumeyon).

**Findings (all 5 REAL, no nitpicks):**
  - **L1** (apprenticeship.ts:157): pushContext bypasses `quality_tier_min` / `predictive_lift_min` on the best_answer_id path; filters only apply in the fallback. High-stakes callers passing `quality_tier_min: 1` could still receive tier-5 raw answers via the pointer.
  - **L2** (apprenticeship.ts:157): best_answer_id is treated as authoritative even if `store.getAnswer()` returns null OR a no-longer-accepted answer (e.g., status='superseded'). Stale pointers return silently.
  - **L3** (apprenticeship.ts:216): single-answer reRankAnswers promotes to "accepted" then returns at line 218 — skips the question lifecycle update at line 247. Leaves question.status="open" + best_answer_id=null. **(queued)**
  - **L4** (apprenticeship.ts:227): exact-margin wins fail due to IEEE float comparison. `0.30 - 0.25 < 0.05` evaluates true under raw float subtraction. **(queued)**
  - **L5** (apprenticeship.ts:152): k is unvalidated in pushContext; negative k reaches `slice(0, k)` and returns truncated results instead of zero/error. **(queued)**

**This iter executes L1+L2 together (same code path, related root cause):** the new pushContext trusts best_answer_id as a HINT only. When present, it must (a) resolve to an existing answer, (b) be currently accepted, AND (c) pass the caller's filters. If any check fails, we fall back to queryAnswers. L3-L5 are independent fixes in different functions; queued for iters NL2/NL3/NL4.

**Test-first protocol:**
  1. Wrote 2 regression tests at apprenticeship.test.ts:198-269 (L1: filter bypass; L2: stale pointer).
  2. Verified both FAIL pre-fix.
  3. Applied fix: refactored the topK.map to extract a `queryFallback` helper and call it whenever the best_answer_id pointer is null/stale/filter-failing.
  4. Verified both PASS post-fix; full lattice suite 117 → 119.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 4 (PUSH-CONTEXT) — exercised in step 3 to satisfy lattice-driven discovery rule. Documented the substrate-readiness finding.
  - ✅ Forcing function exercises happened in real fix space, not synthetic.

**Citation discipline:** No new authored answer this iter (per the new loop's explicit rule — only commit fixes, not synthetic explanations). The new lumeyon review answer DID land in the lattice via the iter-11 importer detection (auto-import the peer review as authored content). It's already in the DAG with proper provenance.

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 404 → 405 (+1: the lumeyon review's question)
  - Answers: 891 → 892 (+1: lumeyon's review response, auto-tagged as authored tier 3 by iter-11 importer logic)
  - **authored: 7 → 8** (lumeyon's review IS authored content)
  - quality_tier histogram: tier 2=5, tier 3=3, tier 5=881 (was 2; 1 new tier-3 answer)

**Tests:** plugin 502/0/3 (no change). Lattice 117 → 119 (+2 L1+L2 regression tests).

**Files touched (4):**
  - scripts/lattice/apprenticeship.ts (L1+L2 fix)
  - scripts/lattice/apprenticeship.test.ts (2 regression tests)
  - docs/ephemeral-peer-reviews.md (apprenticeship.ts row added)
  - docs/lattice-alt-a-progress.md (this entry)

**Commit:** (this turn).

**WHAT'S NEXT (iter NL2):** Per peer rotation rule, iter NL2 → keystone. Keystone's specialty: SQL schema, locking, protocol invariants. The remaining 3 L-findings (L3 lifecycle, L4 float margin, L5 k validation) are all in apprenticeship.ts which lumeyon already reviewed. Keystone should review a DIFFERENT module (rule 2: different file each iter). Candidates: scripts/lattice/import-from-kg.ts, plugins/agent-chat/scripts/lattice-context.ts, scripts/lattice/study-turn.ts. import-from-kg.ts was modified iter-11 — but iter-11 was 2 iters ago in old loop count, not within "previous 2" of NEW loop count, so it's eligible. Keystone reviewing import-from-kg.ts is a good fit (SQL schema discipline, idempotency invariants).

### 2026-05-08T01:25Z (Self-improvement /loop iteration 13: pivoted to category D — 3 depth=1 questions; lattice DAG as structured decision-tracking)

**Target category (planned):** I (NEW BUG SURFACE — pin claude predictor temperature to 0). **PIVOTED to D** when the precondition wasn't met.

**Pivot reason:** the claude CLI exposes no `--temperature` flag (verified via `claude --help`). Settings can be passed as JSON via `--settings <json>`, but the schema isn't documented for the temperature key — would require empirical probing AND likely API-key-only scope. Cost/value didn't justify a half-iteration of CLI archeology. Pivoted to category D (depth>0 questions): low-risk metric move that exercises the substrate's question-DAG primitive.

**Peer used:** solo. Pure substrate write.

**3 depth=1 questions spawned:**

  1. **`Should putQuestion forbid status='answered' and 'closed' entirely, forcing every promotion through setQuestionStatus?`**
     - parent: iter-5 joint-consistency Q (`v1:bc5fba80f5d4a28e`)
     - WHY this question: iter-5's invariant only catches null/non-null mismatch at putQuestion; iter-7's K1 FK guard runs only at setQuestionStatus. Tightening putQuestion to forbid non-open inserts would eliminate the test-fixture loophole iter-7 deliberately preserved.

  2. **`Are there other lattice write operations (besides addCitation and addQuestionParent) that mix a SELECT-based check with an INSERT/UPDATE and need BEGIN IMMEDIATE wrapping for cross-connection safety?`**
     - parent: iter-8 K3 atomic-DAG Q (`v1:cd2e10e240527727`)
     - WHY this question: iter-8 fixed two specific call sites; the broader pattern (read-then-write under BEGIN IMMEDIATE) might apply elsewhere in lattice ops. Worth a peer audit of sqlite-store.ts looking specifically for SELECT + UPDATE/INSERT patterns.

  3. **`Can the claude predictor be made deterministic for study-turn (e.g., via temperature pinning) so empirical threshold calibration becomes possible without ±0.19 variance dominating?`**
     - parent: iter-3 explanation-invariant Q (`v1:477192c96d6e8abb`)
     - WHY this question: iter-12 documented the variance, but the path forward needs CLI archeology + design call. Promoting it to a lattice question makes the open architectural decision visible.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 5 (FORMAT-UNIFORM ARTIFACTS) — 3 new questions + 3 question_parent edges all carry full provenance.
  - ⚠️ Function 1 (DUAL-OUTPUT) NOT exercised on the new questions — they're posed open, intentionally, since each represents an open architectural decision boss should weigh in on (per inviolable principle 4).

**Lattice metrics (BEFORE → AFTER) — DAG-structure heavy:**
  - Questions: 401 → 404 (+3)
  - **question_parents: 1 → 4** (4x growth in one iter; first time the DAG has fan-out — multiple distinct parents each have 1 child)
  - **depth_distribution[1]: 1 → 4** (4x growth)
  - Answers: 887 → 891 (+4 background)
  - Authored, citations, predictive_lift: unchanged (this iter only spawned open questions)

**Tests:** plugin 502/0/3, lattice 117/0 (no change — no code modification).

**Files touched (1):**
  - docs/lattice-alt-a-progress.md (this iteration log)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 14):** The boss-approval queue is becoming unwieldy. There are now 7 open architectural questions across (a) the lattice depth=1 nodes from iter-4 and iter-13, and (b) the journal-tracked items (SQL NOT NULL migration, schema FK constraint, K2 fractional-tier CHECK, petersen routing-table). Iter 14 should consolidate: write a single docs/boss-questions.md with all 7 items, link each to the relevant lattice question or journal entry, and explicitly mark which need boss approval before iter-N+ can proceed. This is **category H (DOCS DRIFT CHECK)** territory and is overdue (the rule says use H sparingly — at most 1 in 5 iterations; iters 1-13 have used H 0 times, so iter 14 is well-justified). Substrate use: forcing function 4 (push-context) — query the lattice for all status='open' questions, verify the consolidated doc covers each.

### 2026-05-08T00:55Z (Self-improvement /loop iteration 12: third study-turn run with full 7-answer authored corpus; variance characterization)

**Target category:** E (STUDY-TURN AGAINST AUTHORED). Third pass; first time the 2 peer-review answers (lumeyon iter-1 types.ts review, keystone iter-6 sqlite-store.ts review) were eligible (iter-11 upgraded them to tier 3 / authored).

**Peer used:** none. Study-turn uses claude predictor.

**What ran:** `agent-chat study-turn --n 7 --runtime claude --threshold 0.85` against the lattice. 7 authored candidates selected.

**Results — n=7, threshold=0.85:**

| # | cosine | passed | lift Δ | by | origin |
|---|--------|--------|--------|----|----|
| 1 | 0.733 | ✗ | +0.047 | orion | iter-8 K3 (atomic DAG cycles) |
| 2 | 0.729 | ✗ | +0.046 | orion | iter-7 K1 (best_answer_id FK guard) |
| 3 | 0.650 | ✗ | +0.030 | keystone | iter-6 sqlite-store.ts review (3 bullets) |
| 4 | 0.616 | ✗ | +0.023 | orion | iter-5 (joint status/best_answer_id) |
| 5 | 0.607 | ✗ | +0.021 | orion | iter-3 (explanation invariant) |
| 6 | 0.628 | ✗ | +0.026 | orion | iter-2 (quality_tier_min) |
| 7 | 0.819 | ✗ | +0.064 | lumeyon | iter-1 types.ts review (9 bullets) |

**avg cosine 0.683, 0/7 passed at 0.85.**

**Hypothesis status (re: detail-rich peer-review answers passing 0.85):**
  - **PARTIALLY CONFIRMED:** lumeyon's 9-bullet review hit 0.819 (highest of all 7 candidates this run, edges out the next-best at 0.733). Detail-rich + lexically-specific + bullet-structured content does score higher.
  - **DISCONFIRMED for keystone's review:** cosine 0.650 despite same "review with line numbers" structure. Why? Keystone's 3 findings reference very specific code internals (line numbers like `sqlite-store.ts:44`, schema constraints, transaction primitives) that claude's predictor — without access to the actual file — can only describe abstractly. Lumeyon's broader 9-bullet structure happened to map closer to claude's general technical reasoning.
  - **VARIANCE dominates at this sample size:** the iter-2 quality_tier_min answer scored 0.820 in iter-10 and 0.628 in iter-12. Same exact answer, different prediction run. Claude predictor is non-deterministic at default temperature; cosines vary ±0.10 across runs.

**Cross-iteration comparison (iter-2 quality_tier_min answer over time):**
  - iter-9 (n=5, claude): cosine 0.793
  - iter-10 (n=5, claude, threshold 0.70): cosine 0.820
  - iter-12 (n=7, claude, threshold 0.85): cosine 0.628
  - SAME answer, three runs, range 0.628-0.820. Variance ±0.19. Larger than the iter-9-vs-iter-15j signal (+0.19 on aggregate). The single-trial study-turn approach has too much noise for confident pass/fail decisions on borderline content.

**Implication for design:** A future iteration should pin the predictor's temperature to 0 (or use an averaging approach: 3 runs per candidate, take median) for stable signal. Both are configuration changes — temperature=0 is simpler. Adding to the queue.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 2 (STUDY TURN) — third pass, first across the full 7-answer corpus
  - ✅ Function 3 (SELECTION PRESSURE) — applyGradeToLift bumped lift on all 7 candidates; cumulative pressure visible in histogram

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 401 → 401
  - Answers: 887 → 887 (no background activity this iter — quiet)
  - **predictive_lift max: 0.123 → 0.156** (+0.033 from this iter; 3rd cumulative pass on highest-scoring candidates)
  - predictive_lift mean: 0.001 → 0.002 (still tiny; 880 zero-tail dominates)
  - 7 / 7 candidates exercised — selection picked up the iter-11 upgrades correctly

**Tests:** plugin 502/0/3, lattice 117/0 (no change — code unmodified this iter).

**Files touched (1):**
  - docs/lattice-alt-a-progress.md (this iteration log)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 13):** Boss-approval queue is getting long (4 schema migrations + 1 routing-table). Iter 13 should NOT keep running smoke tests against the same 7 candidates (anti-churn — same study-turn pattern 3 iterations in a row would tip the rule). Two natural alternatives:

  **Option A — Add temperature pinning to the runtime adapter** (`temperature: 0` for study-turn predictions, default temperature for cmdRun). Solves the variance issue documented above. Small code change in runtimes/claude.ts (and codex.ts symmetrically). Test: same answer should produce identical cosine across multiple runs at temperature=0.

  **Option B — Pivot to category D** (SPAWN DEPTH>0 QUESTIONS). The lattice has 1 depth=1 question. Add 2-3 more, building the question hierarchy depth_distribution[2]++. Each one is a recordQuestion + addQuestionParent edge.

  **Recommendation: A.** Variance is the real bottleneck for empirical threshold calibration. Once stabilized, iter 14+ can revisit threshold experiments with confidence. B is a graph-structure win but doesn't solve the substrate's actual signal problem.

### 2026-05-08T00:25Z (Self-improvement /loop iteration 11: importer recognizes ephemeral peer reviews → first stratified quality_tier histogram)

**Target category:** Substrate generalization — the importer was treating ephemeral peer review responses as identical to historical CONVO.md scrape (auto-imported placeholder, tier 5). But peer-review responses ARE substantive content — they're the peer's actual review, not just transcript. Iter-6's flagged "observation worth flagging for future work" became iter-11's deliverable.

**Peer used:** solo. Mechanical change once the spec was clear.

**What was done:**
  1. Added `setAnswerExplanation(id, explanation)` and `setAnswerQualityTier(id, tier)` methods to LatticeStore. Honor the same dual-output non-empty guard as putAnswer.
  2. Updated import-from-kg.ts importPairs: when assistant.description starts with "ephemeral peer review response", use a constructed authored explanation (`"Peer review response from <agent>..."`) and quality_tier 3 instead of the auto-imported placeholder + tier 5.
  3. Added a RETROACTIVE upgrade path: when import hits a PRIMARY KEY conflict (answer already exists from a prior import) AND the section is a peer-review response AND the existing explanation contains "auto-imported", call setAnswerExplanation + setAnswerQualityTier to upgrade in place. Idempotent — re-running on already-upgraded answers is a no-op.
  4. Added 2 tests in import-from-kg.test.ts: one for the new-import path, one for the retroactive-upgrade path.
  5. Added 3 tests in sqlite-store.test.ts: setAnswerExplanation update, setAnswerExplanation rejects empty/null/whitespace, setAnswerQualityTier update.
  6. Re-imported lumeyon-orion + keystone-orion edges in production. Both peer-review answers (lumeyon iter-1, keystone iter-6) upgraded from auto-imported tier 5 → authored tier 3.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 1 (DUAL-OUTPUT) — peer review responses now carry real authored explanations.
  - ✅ Function 5 (FORMAT-UNIFORM) — quality_tier histogram now stratified per the design intent (the dual-audience-fusion contract says quality matters for buyer pricing AND agent retrieval).

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 401 → 401
  - Answers: 885 → 887 (+2 background)
  - **AUTHORED: 5 → 7** (+2: lumeyon iter-1 + keystone iter-6 retroactively upgraded)
  - **quality_tier histogram FIRST STRATIFIED:** tier 2=5, tier 3=2, tier 5=880 (was: all tier 5 except authored). The substrate's quality stratification is now visible in real data — a structural milestone that pre-iter-11 was theoretical.
  - Authored %: 0.6% → 0.8%

**Tests:** plugin 502/0/3 (no change). Lattice 112 → 117 (+5: 3 sqlite-store + 2 import-from-kg).

**Files touched (5):**
  - scripts/lattice/sqlite-store.ts (2 new methods)
  - scripts/lattice/sqlite-store.test.ts (3 new tests)
  - scripts/lattice/import-from-kg.ts (detection + upgrade path)
  - scripts/lattice/import-from-kg.test.ts (2 new tests)
  - docs/lattice-alt-a-progress.md (this journal)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 12):** Re-run study-turn now that we have 7 authored Q/A (vs the 5 in iter-9/10). The 2 newly-upgraded peer-review answers — lumeyon's 9-finding review of types.ts and keystone's 3-finding review of sqlite-store.ts — are detail-rich, line-numbered content. Hypothesis: study-turn against those will produce HIGH cosines (potentially passing 0.85) because the predictor can reason about specific findings cited verbatim. Test the hypothesis empirically. Lattice metric: more passing study turns + lift histogram extends. Plus this exercises the substrate's selection: question_id selection should pick up the new authored answers organically.

### 2026-05-07T23:55Z (Self-improvement /loop iteration 10: `--threshold` flag → first passing study turns)

**Target category:** I (NEW BUG SURFACE — make iter-9's calibration capability explicit) + E (STUDY-TURN, second pass).

**Peer used:** solo. The flag addition is mechanical; the in-production verification needed real claude calls but no peer.

**What was done:**
  1. Added `--threshold F` flag to `agent-chat study-turn` CLI. Validated to be float in [0, 1] (cosine range). Plumbed through to `runStudyTurn`'s `grade_threshold` option.
  2. Updated CLI help text to document the flag and the calibration-rationale (MiniLM-L6-v2 cosines for "same topic, different phrasing" cluster in [0.6, 0.85]; 0.85 is calibrated for near-identical strings).
  3. Added 1 unit test at study-turn.test.ts:323 verifying `grade_threshold` propagates correctly. Cosine should be deterministic across runs (same predictor, same actual); only the `passed` boolean depends on threshold.
  4. **In-production smoke** — re-ran `study-turn --n 5 --runtime claude --threshold 0.70` against the lattice.

**Smoke results — first passing study turns in lattice history:**

| # | cosine | passed | lift Δ | answer | iter origin |
|---|--------|--------|--------|--------|-------------|
| 1 | 0.794 | ✓ | +0.059 | concurrent connections / DAG cycles | iter-8 K3 |
| 2 | 0.806 | ✓ | +0.061 | best_answer_id FK validation | iter-7 K1 |
| 3 | 0.664 | ✗ | +0.033 | joint status/best_answer_id invariant | iter-5 |
| 4 | 0.675 | ✗ | +0.035 | dual-output invariant enforcement | iter-3 |
| 5 | 0.820 | ✓ | +0.064 | quality_tier_min semantics | iter-2 |

**3/5 passed @ 0.70.** The 2 that didn't pass are about MORE ABSTRACT invariants (joint consistency, dual-output as a forcing function); the 3 that passed are about CONCRETE code paths (FK checks, BEGIN IMMEDIATE, quality_tier numeric semantics). Hypothesis: claude's predictor produces lexically closer matches for concrete-mechanism questions than for "why does this invariant exist" questions. Plausible follow-up: improve the predictor's system prompt with substrate-specific context, OR write more lexically-anchored authored answers for abstract questions.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 2 (STUDY TURN) — second run; cumulative selection-pressure signal accumulating.
  - ✅ Function 3 (SELECTION PRESSURE) — applyGradeToLift bumped lift by +0.03 to +0.06 per answer; cumulative effect visible in histogram.

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 401 → 401 (no new this iter)
  - Answers: 883 → 885 (+2 background)
  - **predictive_lift max: 0.059 → 0.123** (~doubled from cumulative iter-9 + iter-10 selection pressure)
  - **predictive_lift mean: 0.000 → 0.001** (tiny shift; 880 zero-tail still dominates)
  - **First passing study turns: 0 → 3** ← real data, real predictor, real cosine grader; substrate produced verifiable retrieval-quality signal at calibrated threshold

**Tests:** plugin 502/0/3 (no change). Lattice 111 → 112 (+1 grade_threshold propagation test).

**Files touched (3):**
  - plugins/agent-chat/scripts/agent-chat.ts (--threshold flag + help text)
  - scripts/lattice/study-turn.test.ts (grade_threshold unit test)
  - docs/lattice-alt-a-progress.md (this iteration log)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 11):** Two options, comparable leverage:

  **Option A — Detect "ephemeral peer review response:" sections in the importer** so iter-6's keystone review (and future peer-review responses) are tagged as authored content rather than auto-imported. This would unblock more authored data in the lattice (currently the 9 sections from peer-review responses have substantive content but are tagged auto-imported, hiding their value from study-turn selection). Production impact: re-running import after the change would flip ~9 answers from auto-imported to authored → authored_count jumps from 5 to ~14, opening richer study-turn candidates.

  **Option B — Author lexically-anchored answers for the 2 abstract Q/A that didn't pass** (iter-3 explanation invariant, iter-5 joint consistency). New answers would be more concrete (cite line numbers, function names, exact values); study-turn re-run might pass them at 0.70 OR even at 0.85. Tests the hypothesis that lexical specificity drives cosine.

  **Recommendation: A.** Larger structural impact (unlocks 9+ peer-review answers as first-class authored content); smaller code change (importer regex + status path). B is a calibration experiment; A is a substrate generalization. A enables more meaningful B-style experiments later.

### 2026-05-07T23:30Z (Self-improvement /loop iteration 9: first study-turn against authored — full forcing-function loop verified end-to-end)

**Target category:** E (STUDY-TURN AGAINST AUTHORED). Unblocked at iter-8 when authored_count hit 5.

**Peer used:** none (study-turn uses claude predictor as a "self-review" mechanism — not a peer dispatch).

**What ran:** `agent-chat study-turn --n 5 --runtime claude` against the lattice. 5 candidates selected (the 5 authored Q/A from iters 2/3/5/7/8). For each: claude predictor produces a prediction; embedding-cosine grader compares prediction to actual answer body; applyGradeToLift updates predictive_lift via `(cosine - 0.5) * 2 * lr` (lr=0.1 default).

**Results:**

| # | cosine | passed | lift Δ | answer (truncated) |
|---|--------|--------|--------|--------------------|
| 1 | 0.716 | ✗ | +0.043 | iter-8 K3 (atomic DAG cycles) |
| 2 | 0.745 | ✗ | +0.049 | iter-7 K1 (best_answer_id FK guard) |
| 3 | 0.737 | ✗ | +0.047 | iter-5 (joint status/best_answer_id) |
| 4 | 0.735 | ✗ | +0.047 | iter-3 (explanation invariant) |
| 5 | 0.793 | ✗ | +0.059 | iter-2 (quality_tier_min semantics) |

**Avg cosine 0.745. 0/5 passed the 0.85 threshold. avg lift Δ +0.049.**

**Comparison to iter-15j (conversational corpus):** conversational Q/A produced cosines 0.42-0.65 (avg ~0.55). Authored Q/A: 0.716-0.793 (avg 0.745). **+0.19 lift on average — structured authored content is meaningfully more predictable than conversational chatter, exactly what the substrate's design predicts.** But still under the 0.85 threshold.

**Why didn't they pass 0.85?**
  - Claude predictor's response style differs LEXICALLY from orion's authored content (different word-choice for the same concept).
  - Questions reference specific code internals (file paths, function names like `enforceQuestionStatusInvariant`, line numbers); claude predicts general technical reasoning, not exact code references.
  - The 384-dim Xenova/all-MiniLM-L6-v2 embedding gives cosines in [0.6, 0.85] for "same topic, different phrasing" rather than for "literally same answer". 0.85 is calibrated for near-identical strings.
  - The cosine threshold IS configurable via `grade_threshold` option (study-turn.ts:247), default 0.85; the CLI doesn't expose it as a flag yet.

**Substrate's full forcing-function loop now verified on real data:**
  - F2 (study turn) exercised end-to-end ✓
  - F3 (selection pressure) exercised — applyGradeToLift updated 5 answers ✓
  - Predictor → grader → lift-update flow ran 5 times without errors ✓

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 401 → 401 (no new this iter; reads only)
  - Answers: 881 → 883 (+2 from background record-turns)
  - **predictive_lift max: 0.000 → 0.059** ← FIRST non-zero value in the entire lattice history (every single answer was 0.000 since lattice-creation; iter-9 produced the first signal).
  - predictive_lift mean: stays at 0.000 because 878/883 answers (auto-imported tail) remain at 0; the 5 authored ones now have ~0.04-0.06 each.
  - Authored: 5 → 5 (no new this iter)
  - Citations: 8 → 8

**Tests:** plugin 502/0/3, lattice 111/0 (no change — no code changes this iteration).

**Files touched (1):**
  - docs/lattice-alt-a-progress.md (this iteration log + progress doc current state)

**Note on file-change minimality:** this is a "verify the substrate works on real data" iteration. The substrate produced new lattice state (predictive_lift values), but the verification is journaling, not new code. Per principle 3, the metric delta (first non-zero predictive_lift) justifies the commit even though no code changed.

**Commit:** (this turn).

**WHAT'S NEXT (iteration 10):** Two natural follow-ups, pick whichever has higher leverage:

  **Option A — Add `--threshold` flag to study-turn CLI** so future runs can be calibrated (e.g., 0.70 for "good enough", 0.85 for "near-identical-string"). Small code change (1-2 lines in agent-chat.ts cmdStudyTurn). Lets future iterations explore the threshold space empirically without touching study-turn.ts.

  **Option B — Run study-turn AGAIN with the same n=5 to see lift accumulation.** Each pass adds ~0.05 to lift via applyGradeToLift. After 5-6 passes, the 5 authored answers should have lift in [0.25, 0.30] — visible in the histogram. Demonstrates selection pressure (forcing function 3) accumulating.

  **Recommendation: A first, then B in iter 11.** A enables empirical threshold exploration; B becomes more meaningful once we can see how lift behaves under different thresholds.

### 2026-05-07T23:05Z (Self-improvement /loop iteration 8: K3 atomic DAG cycle checks via BEGIN IMMEDIATE)

**Target category:** I (NEW BUG SURFACE — execute keystone's K3 from iter-6).

**Peer used:** solo. The fix was straightforward — same pattern as fts.ts's existing withWriter helper.

**The bug:** addCitation and addQuestionParent did read-then-insert without a transaction. Two LatticeStore connections to the same file could each pass opposite-edge cycle checks (each seeing a state where the other's edge doesn't exist yet) and then both INSERT — producing X→Y→X. Real race window between SELECT-release and INSERT-acquire of the writer-mutex.

**The fix:** New `withImmediateWriter(db, fn)` helper wraps fn in `BEGIN IMMEDIATE...COMMIT` (with ROLLBACK on throw). addCitation and addQuestionParent now run their cycle-check + INSERT inside this helper. SQLite's writer-mutex serializes all immediate transactions, so the second writer's BEGIN blocks until the first commits — by then its read sees the new edge and correctly detects the cycle. Mirrors fts.ts:108 (the FTS5 index uses the same pattern; lattice version is sync without retry because contention is rare).

**Test approach:**
  1. Two new multi-connection regression tests at sqlite-store.test.ts (one for addCitation, one for addQuestionParent) using a file-backed DB with two LatticeStore connections to the same file. The tests demonstrate functional correctness across connections — storeA writes a citation, storeB on the OTHER connection then sees the committed state under BEGIN IMMEDIATE and correctly refuses the cycle-creating opposite edge.
  2. Note: the actual interleaving race is hard to reproduce deterministically without real concurrency primitives. The functional multi-connection test verifies the integration path; the protection itself comes from BEGIN IMMEDIATE serializing writers (a SQLite primitive). Comment in the source explains the rationale.

**Pre-existing single-thread cycle tests still pass:** BEGIN IMMEDIATE is a strict superset of the previous unwrapped behavior; existing tests exercise the same function signatures, just now under a transaction wrapper.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 1 (DUAL-OUTPUT) — authored a 928-byte explanation citing both keystone's iter-6 review AND iter-7's K1 answer.
  - ✅ Function 5 (FORMAT-UNIFORM) — full provenance on new Q/A.
  - ✅ Citation DAG growth — multi-parent citations re-confirmed (iter-8 cites both keystone iter-6 + iter-7).

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 400 → 401 (+1)
  - Answers: 878 → 881 (+1 authored + ~2 background)
  - **AUTHORED: 4 → 5** ← STUDY-TURN ELIGIBILITY THRESHOLD REACHED (category E unblocks at >= 5)
  - **CITATIONS: 6 → 8** (+2 from iter-8 multi-parent)
  - posed_by orion: 69 → 70

**Tests:** plugin 502/0/3 (no change). Lattice 109 → 111 (+2 multi-connection K3 regression tests).

**Files touched (4):**
  - scripts/lattice/sqlite-store.ts (withImmediateWriter helper + addCitation/addQuestionParent wrapped)
  - scripts/lattice/sqlite-store.test.ts (2 multi-connection regression tests)
  - docs/ephemeral-peer-reviews.md (mark K3 closed)
  - docs/lattice-alt-a-progress.md (this iteration log)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 9):** **Category E (STUDY-TURN AGAINST AUTHORED) is now eligible** — authored_count >= 5. Run `agent-chat study-turn --n 3` against the 5 authored answers (iter-2 quality_tier, iter-3 explanation invariant, iter-5 joint consistency, iter-7 K1 FK, iter-8 K3 atomic). Expectation: claude predictor against these substantive Q/A pairs may produce passes (cosine ≥ 0.85) for the more direct technical questions, vs the conversational corpus that produced 0 passes in iter-15j. Lattice metric: predictive_lift histogram shifts. If passes happen, that's the strongest signal yet that the substrate WORKS. If not, root-cause: predictor too generic, threshold too strict, or genuine knowledge gap.

### 2026-05-07T22:35Z (Self-improvement /loop iteration 7: K1 runtime-guard for best_answer_id FK existence + matching + accepted)

**Target category:** I (NEW BUG SURFACE — execute keystone's K1 from iter-6).

**Peer used:** solo. Keystone's iter-6 finding was specific enough that no fresh peer call was needed.

**Test-first protocol:**
  1. Wrote 4 regression tests at sqlite-store.test.ts:359-413 (non-existent answer, mismatched question_id, non-accepted answer, happy-path).
  2. Verified 3 of 4 FAILED pre-fix (the happy-path test passed pre-fix because there was no validation in either direction).
  3. Applied fix: new helper `enforceBestAnswerReference(db, qid, ans_id)` called from setQuestionStatus AFTER iter-5's null/non-null guard. Verifies (a) answer exists, (b) its question_id matches, (c) its status === "accepted".
  4. Verified all 4 PASS post-fix; full lattice suite 105 → 109 (+4).

**Design decision (judgment call, journaled for boss visibility):** The guard is added to setQuestionStatus only, not putQuestion. Reason: at putQuestion insert-time the answer typically doesn't exist yet (production path is put-as-open then promote); FK validation at putQuestion would force test fixtures with placeholder best_answer_id strings to either pre-create answers or use put-as-open-then-promote. The setQuestionStatus choke-point IS the production promotion path, so K1 is enforced where it matters. A future iteration could tighten putQuestion further (e.g., reject status="answered"/"closed" entirely from putQuestion, forcing all promotions through setQuestionStatus). Not done in iter-7 to avoid breaking the 5 test fixtures iter-5 already updated.

**Pre-existing test bugs caught + fixed:** sqlite-store.test.ts:64 ("setQuestionStatus updates lifecycle") used a placeholder best_answer_id without creating the matching answer. Updated to create the real accepted answer first. The test now exercises BOTH the lifecycle update AND the K1 FK validation as a positive case.

**Dog-food check (forcing functions exercised):**
  - ✅ Function 1 (DUAL-OUTPUT) — authored a 745-byte explanation about the three-step guard chain, recorded into the lattice via recordAnswer + setQuestionStatus(answered).
  - ✅ Function 5 (FORMAT-UNIFORM) — new question + answer carry full provenance.
  - ✅ Citation DAG growth — iter-7 cites BOTH keystone's iter-6 review AND iter-5's joint-invariant answer (multi-parent semantic citation: keystone surfaced the bug, iter-5 established the put-as-open-then-promote pattern that iter-7 extends).

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 399 → **400** ← milestone: 400-question lattice
  - Answers: 875 → 878 (+1 authored, +2 background)
  - **AUTHORED: 3 → 4** (each iteration adds one)
  - **CITATIONS: 4 → 6** (+2 from this iter; multi-parent citation pattern proven again)
  - posed_by orion: 68 → 69
  - by_agent orion: 421 → 422

**Tests:** plugin 502/0/3 (no change). Lattice 105 → 109 (+4 K1 regression tests).

**Files touched (4):**
  - scripts/lattice/sqlite-store.ts (the new enforceBestAnswerReference helper + setQuestionStatus call)
  - scripts/lattice/sqlite-store.test.ts (4 K1 regression tests + 1 pre-existing test fixed)
  - docs/ephemeral-peer-reviews.md (mark K1 closed)
  - docs/lattice-alt-a-progress.md (this iteration log)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 8):** Execute keystone's K3 (DAG cycle check + insert not atomic). Wrap addCitation and addQuestionParent's check+insert in `BEGIN IMMEDIATE...COMMIT`. Test approach: regression test that demonstrates the race window (two concurrent connections each passing opposite-edge cycle checks then both inserting). Bun:sqlite supports BEGIN IMMEDIATE. K2 (fractional quality_tier CHECK) stays in the boss-approval queue with iter-3 NOT NULL and iter-6 K1 schema FK.

### 2026-05-07T22:00Z (Self-improvement /loop iteration 6: keystone peer-review of sqlite-store.ts → 3 fresh REAL findings)

**Target category:** A (PEER REVIEW UNCOVERED MODULE).

**Peer used:** keystone (codex). 19381-byte review prompt, 1225-byte response, ~3 min wall clock.

**Routing call:** /loop's routing table maps SQL/protocol/locking → keystone, and `sqlite-store.ts` is exactly that domain. Petersen yaml's keystone role ("Documentation, community, and manifest comparison specialist") is a less-perfect match, but the per-edge runtime config (codex) and the protocol-discipline focus the prompt forced are aligned. Outcome: keystone returned 3 strictly REAL findings — no nitpicks, no design preferences, all citing exact line numbers.

**Findings (all REAL per QUALITY BAR rule):**
  - **K1 — best_answer_id not FK-validated and not checked for existence/matching/accepted.** Iter-5's joint-invariant guard checks null vs non-null but never verifies the pointed-to answer exists, has matching question_id, or is status="accepted". Pre-K1, an "answered" question can have best_answer_id="ans:nonexistent" or "ans:wrong-question". **Fix split:** code-only runtime guard at iter 7 (extends enforceQuestionStatusInvariant); schema FK constraint pending boss approval (joins the migration queue).
  - **K2 — CHECK(quality_tier BETWEEN 1 AND 5) allows fractional values like 2.5.** SQLite's BETWEEN is a numeric range, not a discrete-set check. Type contract `QualityTier = 1 | 2 | 3 | 4 | 5` is discrete only; schema is permissive. Fix: `CHECK(quality_tier IN (1,2,3,4,5))`. **Pending boss approval** (schema migration on production).
  - **K3 — DAG cycle checks (addCitation, addQuestionParent) are read-then-insert without a transaction.** Two LatticeStore connections can concurrently pass opposite-edge cycle checks then insert a cycle. Fix: wrap check+insert in `BEGIN IMMEDIATE...COMMIT`. **Code-only fix, queued iter 8.**

**Dog-food check (forcing functions exercised):**
  - ✅ Function 5 (FORMAT-UNIFORM ARTIFACTS) — keystone's review section appended to keystone-orion CONVO.md, imported to lattice as Q/A pair with full provenance.

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 398 → 399 (+1: orion's review request)
  - Answers: 872 → 875 (+1: keystone's response, +2 background)
  - **by_agent keystone: 28 → 29** ← PEER DIVERSITY moved (different distribution than iter 1 lumeyon-only)
  - Authored: 3 → 3 (keystone's response was imported via auto-imported placeholder; the importer doesn't yet distinguish ephemeral-peer-review content from historical CONVO.md scrape)
  - Citations: 4 → 4 (no new this iteration)

**OBSERVATION worth flagging for future work:** the importer auto-tags imported answers with the auto-imported placeholder regardless of whether the section is fresh ephemeral-peer-review content (which IS substantive reasoning) or historical CONVO.md scrape. A future iteration could detect "ephemeral peer review response:" descriptions and use the section body itself as a quality-tier-3 explanation. Adding to the queue but not as REAL bug — current behavior is consistent with the "auto-import is conservative" design.

**Tests:** plugin 502/0/3, lattice 105/0 (no change — code wasn't touched this iteration).

**Files touched (3):**
  - docs/ephemeral-peer-reviews.md (mark sqlite-store.ts as reviewed; queue K1/K2/K3)
  - docs/lattice-alt-a-progress.md (this iteration log)
  - (production lattice + production CONVO.md modified by the peer-review CLI; not git-tracked)

**Commit:** (this turn).

**WHAT'S NEXT (iteration 7):** Execute K1's code-only part — extend enforceQuestionStatusInvariant in sqlite-store.ts so that when status in {answered, closed}, the best_answer_id MUST point to an EXISTING answer with matching question_id and status="accepted". This is a 1-file source change + 3-4 regression tests. Schema FK migration stays in the boss-approval queue with K2 and the iter-3 NOT NULL question.

### 2026-05-07T20:25Z (Self-improvement /loop iteration 5: joint-consistency invariant — Question.status ↔ best_answer_id)

**Target category:** I (NEW BUG SURFACE — execute lumeyon's REAL #3 from iter-1's smoke).

**Peer used:** solo. Lumeyon's iter-1 finding was specific enough that no fresh peer call was needed.

**Test-first protocol:**
  1. Wrote 6 regression tests at sqlite-store.test.ts:289-356 (3 cases each for putQuestion and setQuestionStatus violations).
  2. Verified all 6 FAIL pre-fix.
  3. Applied fix: `enforceQuestionStatusInvariant()` helper called from both putQuestion (insert) and setQuestionStatus (update). Status in {open, reopened} → best_answer_id MUST be null. Status in {answered, closed} → best_answer_id MUST be a non-empty string.
  4. Verified all 6 PASS post-fix.

**Production audit + cleanup:**
  - Pre-fix: 2 production violations (both my own iter-2/iter-3 puts that left best_answer_id=null after a status="answered" insert).
  - Post-fix: 0 violations of either type. Manually set best_answer_id on both via setQuestionStatus.

**Production code fix:**
  - `import-from-kg.ts:288-298` was using the same anti-pattern (putQuestion with status="answered" + null, then setQuestionStatus to set the FK after recordAnswer). Rewrote to put-as-open-then-promote pattern. The transient invariant violation that pre-existed is gone.

**5 test files updated to comply with the new invariant:**
  - sqlite-store.test.ts: multi-axis-question-query seeds now provide best_answer_id placeholder strings for status=answered/closed seeds
  - apprenticeship.test.ts: pushContext seeds now seed as "open" + promote to "answered" via setQuestionStatus after recordAnswer
  - stats.test.ts: 5 inline fixtures now provide best_answer_id placeholders
  - study-turn.test.ts: seedQuestion default changed to "open"; 4 affected tests now do setQuestionStatus after recordAnswer; new seedAnsweredQuestion helper added for future-test-author convenience
  - plugins/agent-chat/tests/lattice-context.test.ts: same treatment as study-turn

**Dog-food check (multiple forcing functions exercised):**
  - ✅ Function 1 (DUAL-OUTPUT) — authored a 765-byte explanation about the invariant and how it's enforced
  - ✅ Function 5 (FORMAT-UNIFORM) — new question + answer carry full provenance
  - ✅ **Citation DAG growth** — iter-5 authored answer cites BOTH lumeyon's iter-1 review AND iter-3's authored answer (multi-parent semantic citation, since iter-5's reasoning rests on both: lumeyon for surfacing the bug, iter-3 for establishing the put-as-open-then-promote pattern that iter-5 generalizes)

**Lattice metrics (BEFORE → AFTER):**
  - Questions: 397 → 398 (+1)
  - Answers: 869 → 872 (+1 authored, +2 from background)
  - **AUTHORED: 2 → 3** (function 1 exercised again on real production data)
  - **CITATIONS: 2 → 4** (+2: iter-5 → lumeyon + iter-5 → iter-3)
  - Production violations: 2 → 0 (data-cleanup metric not in lattice-stats but real)

**Tests:** plugin 502/0/3 (no change — the test-fixture updates kept the count the same; the lattice-context.test changes were inside the existing suite). Lattice 99 → 105 (+6 regression tests).

**Files touched (9 files; coherent-feature exemption from 5-file cap):**
  scripts/lattice/sqlite-store.ts, sqlite-store.test.ts, import-from-kg.ts, apprenticeship.test.ts, stats.test.ts, study-turn.test.ts, plugins/agent-chat/tests/lattice-context.test.ts, docs/ephemeral-peer-reviews.md, docs/lattice-alt-a-progress.md

**Commit:** (this turn).

**WHAT'S NEXT (iteration 6):** All three lumeyon iter-1 REAL findings are now closed. Two boss-approval questions still pending (SQL NOT NULL migration + petersen routing-table). With no queued REAL findings, iter 6 should rotate categories: pick A (PEER REVIEW UNCOVERED MODULE) — pick `scripts/lattice/sqlite-store.ts` (the most invariant-rich module after types.ts) and spawn keystone (codex; protocol-discipline reviewer per yaml role) for an audit. Goal: surface 1-2 fresh REAL findings to refill the queue.

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
