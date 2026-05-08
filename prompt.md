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

Single first-attempt failures are NOISE. Retry once. **NL5 confirmed:** keystone retried on import-from-kg.ts after NL2 timeout — succeeded first try, 8 REAL findings. The retry rule is load-bearing.

## PEER ROTATION (only counts when a fresh peer call HAPPENS)

| iter cycle position | peer | specialty |
|---|---|---|
| N | lumeyon | general correctness, API design, type safety |
| N+1 | keystone | SQL schema, locking, protocol invariants |
| N+2 | carina | embeddings, cosine math, grading thresholds |
| N+3 | cycle back to lumeyon |

Queue-draining iters DO NOT count toward peer rotation.

## CURRENT STATE (as of NL5 commit)

### Covered modules (with prior peer review entries):
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 3 fixed at code level; SQL migration in boss-approval queue)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, 2 fixed; K2 in boss-approval queue)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, L1+L2 fixed; L3-L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, C1 fixed; C2-C5 queued)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, E6 fixed; E1-E5 + E7 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, K-imp-2 fixed; K-imp-1, 3-8 queued)

### Uncovered modules (priority order for fresh peer reviews):
1. `plugins/agent-chat/scripts/lattice-context.ts` — cmdRun-pushContext bridge; lumeyon fit
2. `scripts/lattice/stats.ts` — read-only inspector; lumeyon or keystone fit
3. `scripts/lattice/synthesize-corpus.ts` — purpose unclear; needs lumeyon assessment
4. `scripts/lattice/validate-corpus.ts` — same as above
5. `plugins/agent-chat/scripts/lattice-stats.ts` — wait, stats.ts is the lattice script; check if there's a plugin variant

### Queued findings (drainable WITHOUT fresh peer call — 20 total):

#### apprenticeship.ts (lumeyon NL1) — 3 queued
- **L3** (apprenticeship.ts:216): single-answer `reRankAnswers` promotion sets answer to "accepted" then returns at :218, skipping question lifecycle update at :247. Leaves `question.status="open"` + `best_answer_id=null` after promotion.
- **L4** (apprenticeship.ts:227): exact-margin wins fail due to IEEE float comparison. `0.30 - 0.25 < 0.05` evaluates true under raw subtraction. **Smallest queued fix — 1-line change with epsilon.**
- **L5** (apprenticeship.ts:152): `pushContext k` is unvalidated. Negative `k` → `slice(0, k)` → truncated results instead of zero/error.

#### study-turn.ts (carina NL3) — 4 queued
- **C2** (study-turn.ts:141, 182): `selectStudyQuestions` can pick accepted answer with empty body → cosine=0 → spurious penalty.
- **C3** (study-turn.ts:213, 215, 216): NaN cosine propagates to `predictive_lift` → NaN written to storage. Add `Number.isFinite` guard.
- **C4** (study-turn.ts:213): negative cosine produces lift penalty exceeding `-learningRate` while positive caps at `+learningRate`. Asymmetry — design call.
- **C5** (study-turn.ts:128, 141): SQL `limit: 5` applied before in-memory authored filter; eligible answer at rank ≥6 silently unreachable.

#### ephemeral-peer-review.ts (lumeyon NL4) — 6 queued
- **E1** (line 206): resume-write steals floor from any non-orion turn (race).
- **E2** (line 206 + 213): `.turn` flipped before lock acquired (race; same fix area as E1).
- **E3** (line 213): lock failure outside try → edge stuck on "orion" if lock fails. Fix: park-on-lock-failure.
- **E4** (line 220, 256): dispatch failure parks but leaves CONVO arrow `→ peer` while `.turn=parked` (protocol drift).
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

**NL6 → DRAIN L4** (apprenticeship.ts:227 float margin).

**Why L4 over alternatives:**
- Smallest queued fix (1-line epsilon change).
- Apprenticeship.ts wasn't touched in NL5 (last touched NL1 — plenty of gap, satisfies file-touch rule).
- Mature test scaffolding in apprenticeship.test.ts; regression test pattern is well-established.
- LLM-cost-free (queue-drain, no fresh peer call).

**Test approach for L4:**
- Construct a scenario where `top.predictive_lift - second.predictive_lift` evaluates to e.g. `0.05000000000000004` or `0.04999999999999998` (raw float math).
- Pre-fix: comparison `>= margin` may fail or pass spuriously.
- Post-fix: use `>= margin - epsilon` (with epsilon like `Number.EPSILON * 100` or `1e-9`).

After NL6 (L4 drained), NL7 candidates per peer rotation + queue precedence:
- If queue still non-empty: drain L5 (small) or C3 (NaN guard, also small).
- If/when fresh peer call happens: NL7 would be carina cycle position → review lattice-context.ts (uncovered, fits carina via push-context retrieval).

## STOPPING CONDITIONS (any one halts)

1. Tests go red AND 2 fix attempts fail.
2. Peer call fails on BOTH first attempt AND retry.
3. 3 iterations in a row produce no metric delta AND no fix shipped.
4. Same-file-as-previous-iter trip (rule 3).
5. Queued findings empty AND all uncovered modules covered → write "review pass complete" summary commit and STOP.
6. REAL finding requires design call boss hasn't authorized → spawn depth>0 question + STOP.

## CADENCE: 1500s.

## LESSONS LEARNED (cumulative — read first)

- **Peer reviews yield 5-8 REAL findings per call** (NL1=5, NL3=5, NL4=7, NL5=8). Strongest yields come from largest substrate modules. Pattern is reproducible.
- **Codex flakes once per ~5 calls but recovers** (NL2 timeout, NL3/4/5 succeeded). Single failures are noise; retry once before halting. NL5 SUCCESSFULLY retried after NL2's timeout — the retry rule is proven.
- **Test-first catches the bug exactly** — and surface-level test scaffolding is sometimes too lenient. NL5's first K-imp-2 test attempt passed pre-fix because `toContain` was too loose; tightened to assert the exact internal substring survives. Always verify your test FAILS pre-fix. If it doesn't, re-think.
- **Queue precedence saves LLM cost.** With 20 queued findings already identified, no need to spawn a fresh peer call to find more work.
- **The strongest single peer review yet (NL5 keystone, 8 findings) was a RETRY** of a prior failed call. Don't give up after one flake.
- **Peer-driven yields nontrivial bugs even in mature code** — K-imp-2 (regex /m flag) was data-corrupting but had been latent. K-imp-5 (try/catch swallowing all errors) is bug-masking. These aren't theoretical — peer review surfaces real production-risk gaps.
- **Boss is asleep.** Architectural decisions (schema migrations, routing-table changes, predictor tuning) → boss-approval queue + lattice depth>0 questions. No autopilot decisions.
- **prompt.md as state file works.** Each iter reads it, executes, updates it. State survives between conversations.

## NO synthetic work. NO inventing citations. NO authoring explanations of iteration N.

The substrate's job is to find real bugs and surface real architectural questions, not to grow its own metrics for their own sake.
