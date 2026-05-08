# Stateful peer-driven audit loop

Each iter: read this file → execute the next iter → update this file with state for the iter after.
The substrate is built; this loop's job is to find real bugs and ship narrow fixes one at a time.

## INVIOLABLE RULES (each iter must satisfy ALL)

1. **TESTS-FIRST.** Run `bun test plugins/agent-chat/tests/ && bun test scripts/lattice/` at the start. If red, root-cause and fix before any other work. Going-red mid-iter = revert that iter's changes and journal "couldn't apply fix without breaking tests."

2. **PEER-DRIVEN OR QUEUE-DRAINING.** Each iter either:
   - Spawns ONE ephemeral-peer-review against an UNCOVERED module (if any remain), OR
   - Drains ONE finding from the QUEUED FINDINGS section below (no peer call — saves LLM cost, ships work that was already discovered).
   The queue takes precedence when non-empty.

3. **DIFFERENT FILE THAN PREVIOUS ITER.** The fixed/reviewed module's source file must NOT match the immediately-previous iter's source file. If the only fresh target is in the same file as last iter, journal "approaching saturation" and STOP.

4. **CLASSIFY-AT-WRITE-TIME** (peer findings only):
   - **REAL bug** → add to QUEUED FINDINGS or execute one this iter
   - **REFACTOR preference** → dismiss with one journal line
   - **DESIGN decision** (boss authorization needed) → spawn depth>0 question + STOP

5. **WRITE THE TEST FIRST.** For every fix (queued OR fresh): regression test FIRST → verify FAILS pre-fix → apply fix → verify PASSES post-fix → commit. Skip = the fix doesn't ship.

6. **CITATION DISCIPLINE.** If the iter creates a new authored answer in the lattice, it MUST cite ≥1 real prior. No self-cite.

## PEER CALL RESILIENCE (when a fresh peer review IS needed)

- **Attempt 1:** codex runtime, 240s budget.
- **On timeout/non-zero/empty/garbled:** retry ONCE with 360s budget on same peer.
- **On second failure:** STOP, journal as substrate-health finding.

NL5 confirmed the retry rule is load-bearing: keystone retried on import-from-kg.ts after NL2's timeout and succeeded first try with 8 REAL findings.

## PEER ROTATION (only counts when a fresh peer call HAPPENS)

| iter cycle position | peer | specialty |
|---|---|---|
| N | lumeyon | general correctness, API design, type safety |
| N+1 | keystone | SQL schema, locking, protocol invariants |
| N+2 | carina | embeddings, cosine math, grading thresholds |
| N+3 | cycle back to lumeyon |

Queue-draining iters DO NOT count toward peer rotation. Last fresh-peer-call: NL5 (keystone). Next fresh peer would be carina.

## CURRENT STATE (as of NL6 commit)

### Covered modules (with prior peer review entries):
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 3 fixed; SQL migration in boss-approval queue)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, 2 fixed; K2 in boss-approval queue)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, **3 fixed: L1+L2+L4**; L3, L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, C1 fixed; C2-C5 queued)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, E6 fixed; E1-E5 + E7 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, K-imp-2 fixed; K-imp-1, 3-8 queued)

### Uncovered modules (priority order for fresh peer reviews):
1. `plugins/agent-chat/scripts/lattice-context.ts` — cmdRun-pushContext bridge; lumeyon or carina fit
2. `scripts/lattice/stats.ts` — read-only inspector; lumeyon or keystone fit
3. `scripts/lattice/synthesize-corpus.ts` — purpose unclear; needs lumeyon assessment
4. `scripts/lattice/validate-corpus.ts` — same as above

### Queued findings (drainable WITHOUT fresh peer call — 19 total):

#### apprenticeship.ts (lumeyon NL1) — 2 queued (was 3; L4 drained NL6)
- **L3** (apprenticeship.ts:216): single-answer `reRankAnswers` promotion sets answer to "accepted" then returns at :218, skipping question lifecycle update at :247. Leaves `question.status="open"` + `best_answer_id=null` after promotion.
- **L5** (apprenticeship.ts:152): `pushContext k` is unvalidated. Negative `k` → `slice(0, k)` → truncated results.

#### study-turn.ts (carina NL3) — 4 queued
- **C2** (study-turn.ts:141, 182): `selectStudyQuestions` can pick accepted answer with empty body → cosine=0 → spurious penalty.
- **C3** (study-turn.ts:213, 215, 216): NaN cosine propagates to `predictive_lift` → NaN written to storage. Add `Number.isFinite` guard. **Smallest queued fix.**
- **C4** (study-turn.ts:213): negative cosine produces lift penalty exceeding `-learningRate` while positive caps at `+learningRate`. Asymmetry — design call.
- **C5** (study-turn.ts:128, 141): SQL `limit: 5` applied before in-memory authored filter; eligible answer at rank ≥6 silently unreachable.

#### ephemeral-peer-review.ts (lumeyon NL4) — 6 queued
- **E1** (line 206): resume-write steals floor from any non-orion turn (race).
- **E2** (line 206 + 213): `.turn` flipped before lock acquired (race; same fix area as E1).
- **E3** (line 213): lock failure outside try → edge stuck on "orion" if lock fails. Fix: park-on-lock-failure.
- **E4** (line 220, 256): dispatch failure parks but leaves CONVO arrow `→ peer` while `.turn=parked`.
- **E5** (line 143): importer path repo-layout-dependent — silent null in packaged plugin layout.
- **E7** (line 87): truncation by JS string length, not bytes — UTF-16/UTF-8 mismatch, niche.

#### import-from-kg.ts (keystone NL5) — 7 queued
- **K-imp-1** (parseSections:54): splits before validating headers — false sections from `## ` inside fenced transcripts.
- **K-imp-3** (importEdgeConvo:231): cross-archive Q→A pair lost when archiving splits between sections.
- **K-imp-4** (importPairs:283): question idempotency read-then-insert race (same shape as iter-8 K3 — fix with INSERT OR IGNORE or BEGIN IMMEDIATE).
- **K-imp-5** (importPairs:322): try/catch swallows ALL errors as "already imported" — masks non-PK failures. **Bug-masking.**
- **K-imp-6** (importPairs:338): `best_answer_id` chosen via queryAnswers limit:1 instead of recordAnswer return.
- **K-imp-7** (importPairs:355): peer-review retro-upgrade scans only first 5 accepted answers — outside-window matches missed.
- **K-imp-8** (importPairs:274): Date.parse accepts non-UTC strings — silent timestamp shift.

#### Boss-approval queue (architectural decisions — NOT autopilot work):
- iter-3 SQL `explanation TEXT NOT NULL` migration on production
- iter-6 K1 schema FK constraint on `best_answer_id`
- iter-6 K2 schema CHECK `quality_tier IN (1,2,3,4,5)` migration
- iter-1 petersen routing-table mismatch (vanguard not direct neighbor)
- 3 lattice depth=1 questions from iter-13 (open architectural decisions)

## NEXT ITER TARGET HINT

**NL7 → DRAIN C3** (study-turn.ts:213 NaN cosine `Number.isFinite` guard).

**Why C3:**
- Smallest queued fix (single conditional check around the lift-update math).
- Data-corruption risk: NaN propagates to predictive_lift → NaN written to SQLite → NaN reads back through pushContext / selection. Real harm potential.
- study-turn.ts last touched NL3 (3 iters ago) — plenty of gap satisfies file-touch rule.
- Apprenticeship.ts (last iter) ineligible per file-touch rule, so even L5 (smaller than C3) is forbidden.
- LLM-cost-free (queue-drain).

**Test approach for C3:**
- Construct a scenario where `gradePrediction` somehow returns NaN (e.g., zero-norm vector edge case in cosineSimilarity, or mock the function for the test).
- Pre-fix: `applyGradeToLift` sees `cosine: NaN` → computes `(NaN - 0.5) * 2 * lr = NaN` → `Math.max(0, Math.min(1, prev + NaN)) = NaN` → `setAnswerPredictiveLift(id, NaN)` writes to storage.
- Post-fix: `Number.isFinite(grade.cosine)` check; if NaN, treat as ungradable (no-op like NL3's empty-prediction fix).

After NL7 (C3 drained), NL8 candidates per queue precedence:
- L5 (apprenticeship.ts k validation) — but if NL7 touched study-turn.ts, NL8 can touch apprenticeship.ts again (rule 3 only forbids matching the IMMEDIATELY-previous iter).
- K-imp-8 (Date.parse UTC) — small, in import-from-kg.ts (touched NL5; NL8 ineligible if NL7 was study-turn).

NL9 candidate: pick up a fresh peer call on lattice-context.ts (carina or lumeyon fit; carina if rotation cycles back).

## STOPPING CONDITIONS (any one halts)

1. Tests go red AND 2 fix attempts fail.
2. Peer call fails on BOTH first attempt AND retry.
3. 3 iterations in a row produce no metric delta AND no fix shipped.
4. Same-file-as-previous-iter trip (rule 3).
5. Queued findings empty AND all uncovered modules covered → write "review pass complete" summary commit and STOP.
6. REAL finding requires design call boss hasn't authorized → spawn depth>0 question + STOP.

## CADENCE: 1500s.

## LESSONS LEARNED (cumulative — read first)

- **Peer reviews yield 5-8 REAL findings per call** (NL1=5, NL3=5, NL4=7, NL5=8). Pattern reproducible.
- **Codex flakes once per ~5 calls but recovers** (NL2 timeout, NL3/4/5 succeeded). Single failures are noise; retry once before halting.
- **Queue-drain iters are LLM-cost-free** (NL6 shipped L4 with zero peer calls). With 19+ queued findings, prefer drain over fresh peer call.
- **Test-first must verify FAILS pre-fix.** NL5's first K-imp-2 test attempt PASSED pre-fix (loose `toContain` matched even after the bug corrupted content); had to tighten to assert exact internal substring. Always confirm the test fails before the fix, or you don't have a regression test — you have a tautology.
- **Float comparisons need epsilon.** L4 (NL6) was the first IEEE 754 bug we shipped a fix for. Future iters touching numeric thresholds should use `delta < margin - 1e-9` style.
- **The strongest peer review yet (8 findings) was a RETRY.** Don't give up after one flake.
- **Boss is asleep.** Architectural decisions go to boss-approval queue. No autopilot decisions.
- **prompt.md as state file works.** Each iter reads it, executes, updates it. State survives between conversations.
- **Cumulative ledger: 25 REAL findings discovered, 6 fixed (L1, L2, L4, C1, E6, K-imp-2), 19 queued.** Average yield: ~5 findings per peer call. Ratio of fixed/found: 24%. Most findings are still in flight.

## NO synthetic work. NO inventing citations. NO authoring explanations of iteration N.

The substrate's job is to find real bugs and surface real architectural questions, not to grow its own metrics for their own sake.
