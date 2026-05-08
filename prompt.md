# Stateful peer-driven audit loop

Each iter: read this file → execute the next iter → update this file with state for the iter after.
The substrate is built; this loop's job is to find real bugs and ship narrow fixes one at a time.

## INVIOLABLE RULES (each iter must satisfy ALL)

1. **TESTS-FIRST.** Run `bun test plugins/agent-chat/tests/ && bun test scripts/lattice/` at the start. If red, root-cause and fix before any other work. Going-red mid-iter = revert that iter's changes and journal "couldn't apply fix without breaking tests."

2. **PEER-DRIVEN OR QUEUE-DRAINING.** Each iter either:
   - Spawns ONE ephemeral-peer-review against an UNCOVERED module (if any remain), OR
   - Drains ONE finding from the QUEUED FINDINGS section below (no peer call — saves LLM cost, ships work that was already discovered), OR
   - Executes one item from the BOSS-PRE-APPROVAL QUEUE (architectural decisions boss has authorized via this file's edits).

3. **DIFFERENT FILE THAN PREVIOUS ITER.** The fixed/reviewed module's source file must NOT match the immediately-previous iter's source file. If the only fresh target is in the same file as last iter, journal "approaching saturation" and STOP.

4. **CLASSIFY-AT-WRITE-TIME** (peer findings only):
   - **REAL bug** → add to QUEUED FINDINGS or execute one this iter
   - **REFACTOR preference** → dismiss with one journal line
   - **DESIGN decision** (boss authorization needed) → spawn depth>0 question + STOP

5. **WRITE THE TEST FIRST.** For every fix (queued OR fresh): regression test FIRST → verify FAILS pre-fix → apply fix → verify PASSES post-fix → commit.

6. **CITATION DISCIPLINE.** If the iter creates a new authored answer in the lattice, it MUST cite ≥1 real prior. No self-cite.

## PEER CALL RESILIENCE

- **Attempt 1:** codex runtime, 240s budget.
- **On failure:** retry ONCE with 360s budget on same peer.
- **On second failure:** STOP, journal as substrate-health finding.

## PEER ROTATION (only counts when a fresh peer call HAPPENS)

| iter cycle | peer | specialty |
|---|---|---|
| N | lumeyon | general correctness, API design, type safety |
| N+1 | keystone | SQL schema, locking, protocol invariants |
| N+2 | carina | embeddings, cosine math, grading thresholds |
| N+3 | cycle |

Last fresh-peer-call: NL5 (keystone). Next fresh peer would be carina.

## CURRENT STATE (as of NL14 commit)

### Covered modules:
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 4 fixed: #1, #2 fully end-to-end, #3 fully — NL7 closed #2 at SQL level)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, **all 3 fully shipped**: K1 runtime guard iter-7 + SQL FK NL9; K3 atomic DAG iter-8; K2 CHECK migration NL11)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, 3 fixed: L1+L2+L4; L3, L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, **2 fixed: C1, C3**; C2, C4, C5 queued)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, **2 fixed: E6, E3**; E1, E2, E4, E5, E7 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, **3 fixed: K-imp-2, K-imp-5, K-imp-8**; K-imp-1, 3, 4, 6, 7 queued; K-imp-9 added NL12 observation)

### Uncovered modules (priority for fresh peer reviews):
1. `scripts/lattice/stats.ts` — lumeyon or keystone fit
2. `scripts/lattice/synthesize-corpus.ts`
3. `scripts/lattice/validate-corpus.ts`

### Covered (added NL12):
- `plugins/agent-chat/scripts/lattice-context.ts` — carina NL12 (5 findings, 1 fixed: LC5; LC1-LC4 queued)

### Queued findings (drainable WITHOUT fresh peer call — 19 total):

#### apprenticeship.ts (lumeyon NL1) — 2 queued
- **L3** (apprenticeship.ts:216): single-answer `reRankAnswers` promotion skips question lifecycle update.
- **L5** (apprenticeship.ts:152): `pushContext k` unvalidated; negative k returns truncated results.

#### study-turn.ts (carina NL3) — 3 queued (was 4; C3 drained NL8)
- **C2** (study-turn.ts:141, 182): selectStudyQuestions can pick empty-body answer → spurious penalty.
- **C4** (study-turn.ts:213): negative cosine asymmetric lift penalty exceeds `-learningRate`. Design call.
- **C5** (study-turn.ts:128, 141): SQL limit applied before in-memory authored filter.

#### ephemeral-peer-review.ts (lumeyon NL4) — 5 queued (E3 drained NL14)
- **E1** (line 206): resume-write steals floor from non-orion turn (race).
- **E2** (line 206 + 213): `.turn` flipped before lock acquired (race; same fix area as E1).
- **E4** (line 220, 256): dispatch failure leaves CONVO arrow `→ peer` while `.turn=parked`.
- **E5** (line 143): importer path repo-layout-dependent.
- **E7** (line 87): truncation by JS string length, not bytes.

#### import-from-kg.ts (keystone NL5) — 6 queued (K-imp-5 drained NL13)
- **K-imp-1** (parseSections:54): false sections from `## ` inside fenced transcripts.
- **K-imp-3** (importEdgeConvo:231): cross-archive Q→A pair lost when archiving splits.
- **K-imp-4** (importPairs:283): question idempotency read-then-insert race.
- **K-imp-6** (importPairs:338): best_answer_id chosen via queryAnswers limit:1.
- **K-imp-7** (importPairs:355): peer-review retro-upgrade scans only first 5.
- **K-imp-9** (NL12 observation): pairSections may over-eagerly split bulleted peer-review responses into many Q/A pairs. carina's NL12 review yielded 6Q/9A vs typical 1Q/1A. Investigate.

#### lattice-context.ts (carina NL12) — 4 queued
- **LC1** (lattice-context.ts:64): no cosine floor — unrelated content can be pushed for sparse corpus.
- **LC2** (lattice-context.ts:65): over-fetches only k+5 — eligible peer hits dropped if buffer insufficient.
- **LC3** (lattice-context.ts:71): null best_answer survives exclude_agent filter — header-only block.
- **LC4** (lattice-context.ts:109): body_budget_bytes uses string length not bytes; budget≤0 leaks via slice(0,-1). Same UTF class as E7.

#### Boss-pre-approval queue (architectural decisions can be made by you (orion)):
- ~~iter-3 SQL `explanation TEXT NOT NULL`~~ — **SHIPPED NL7**
- ~~iter-6 K1 schema FK constraint on `best_answer_id`~~ — **SHIPPED NL9**
- ~~iter-6 K2 schema CHECK `quality_tier IN (1,2,3,4,5)`~~ — **SHIPPED NL11**
- iter-1 petersen routing-table mismatch (vanguard not direct neighbor — adjust agents.petersen.yaml or accept lumeyon-as-substitute pattern; consider mid-cycle)
- 3 lattice depth=1 questions from iter-13:
  - Should putQuestion forbid status="answered"/"closed" entirely?
  - Other lattice ops needing BEGIN IMMEDIATE besides addCitation/addQuestionParent?
  - Predictor temperature pinning for deterministic study-turn?

## NEXT ITER TARGET HINT

**NL15 → DRAIN LC1** (lattice-context.ts no cosine floor — sparse-corpus pollution).

**Why LC1:**
- Real correctness bug. composePushedContextBlock currently emits ALL top-K hits regardless of cosine. Iter-4 documented production-corpus cosines all ≤ 0.31. Pre-fix: pushed-context block contains barely-relevant content from the lattice, polluting cmdRun's prompt.
- File-touch rule: NL14 touched ephemeral-peer-review.ts; lattice-context.ts last touched NL12 (2 iters gap → eligible).
- Modest fix: add `min_cosine` parameter to composePushedContextBlock; default e.g. 0.4 to match the iter-4 substrate-readiness threshold; filter hits below it.

**Test approach (3 regression tests):**
- Set up a lattice with 1 closely-matching answer (cosine ~0.7+) and 2 weakly-matching answers (cosine ~0.2-0.3).
- Pre-fix with default k=5: all 3 emitted in the block.
- Post-fix with `min_cosine: 0.4`: only the closely-matching answer emitted.
- Sanity: `min_cosine: 0` (effectively unset) preserves pre-fix behavior — all 3 emitted.

**Sequenced after NL15:**
- NL16 → C2 (study-turn empty-body filter) or L3 (single-answer reRankAnswers lifecycle gap)
- NL17+ → drain LC2 / LC3 / LC4 (lattice-context.ts again with gap), or K-imp-1/3/4/6/7/9, or fresh peer review on stats.ts

## STOPPING CONDITIONS

1. Tests go red AND 2 fix attempts fail.
2. Peer call fails on BOTH first attempt AND retry.
3. 3 iterations in a row produce no metric delta AND no fix shipped.
4. Same-file-as-previous-iter trip (rule 3).
5. Queued findings + pre-approval queue empty AND all uncovered modules covered → "review pass complete" summary commit and STOP.
6. REAL finding requires design call NOT in the boss-pre-approval queue → spawn depth>0 question + STOP.

## CADENCE: 1500s.

## LESSONS LEARNED (cumulative — read first)

- **Peer reviews yield 5-8 REAL findings per call** (NL1=5, NL3=5, NL4=7, NL5=8). Pattern reproducible.
- **Codex flakes once per ~5 calls but recovers** (NL2 timeout, NL3-5 succeeded). Retry once before halting.
- **Queue-drain iters are LLM-cost-free** (NL6 L4, NL7 SQL migration). With 19+ queued + pre-approved items, prefer drain.
- **Test-first must verify FAILS pre-fix.** Loose assertions (e.g., `toContain` matching even after corruption) are pre-fix-passing tautologies, not regression tests. Always confirm failure first.
- **Float comparisons need epsilon.** L4 fix shipped at NL6.
- **Schema migrations work via the v(N)→v(N+1) pattern.** NL7 shipped iter-3's NOT NULL via:
  - bump SCHEMA_VERSION
  - update CREATE TABLE in SCHEMA_SQL
  - add migrateV(N)toV(N+1) function with idempotency check
  - rebuild-table approach: CREATE new → INSERT...SELECT → DROP old → RENAME new
  - wrap in BEGIN IMMEDIATE for atomicity
  - safety check: refuse migration if pre-conditions don't hold (e.g., NULL rows for NOT NULL migration)
  - back up production before applying. NL7 backed up to `lattice.db.bak-pre-NL7`.
- **Boss can grant authority via prompt.md edit, not just message.** NL7's pivot from "DRAIN C3" to "ship the schema migration" came from boss editing "Boss-approval queue" → "Boss-pre-approval queue (decisions can be made by you)." Watch for this pattern; the file is the channel.
- **Cumulative ledger (post-NL14):**
  - 30 REAL findings discovered across 6 peer reviews
  - 12 fixed at code level (L1, L2, L4, C1, C3, E3, E6, K-imp-2, K-imp-5, K-imp-8, iter-3 #2, LC5)
  - 3 schema migrations shipped
  - 19 queued findings remain
  - Fix-rate: 40% (12/30 code) + all 3 schema migrations
  - SYSTEMIC bug pattern (LC5 = K-imp-2): trailing-marker /m regex copy-pasted; should be a shared helper in a refactor iter.

## NO synthetic work. NO inventing citations. NO authoring explanations of iteration N.

The substrate's job is to find real bugs and surface real architectural questions, not to grow its own metrics for their own sake.
