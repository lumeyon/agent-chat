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

## CURRENT STATE (as of NL11 commit)

### Covered modules:
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 4 fixed: #1, #2 fully end-to-end, #3 fully — NL7 closed #2 at SQL level)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, **all 3 fully shipped**: K1 runtime guard iter-7 + SQL FK NL9; K3 atomic DAG iter-8; K2 CHECK migration NL11)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, 3 fixed: L1+L2+L4; L3, L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, **2 fixed: C1, C3**; C2, C4, C5 queued)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, E6 fixed; E1-E5 + E7 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, **2 fixed: K-imp-2, K-imp-8**; K-imp-1, 3-7 queued)

### Uncovered modules (priority for fresh peer reviews):
1. `plugins/agent-chat/scripts/lattice-context.ts` — cmdRun-pushContext bridge; lumeyon or carina fit
2. `scripts/lattice/stats.ts` — lumeyon or keystone fit
3. `scripts/lattice/synthesize-corpus.ts`
4. `scripts/lattice/validate-corpus.ts`

### Queued findings (drainable WITHOUT fresh peer call — 19 total):

#### apprenticeship.ts (lumeyon NL1) — 2 queued
- **L3** (apprenticeship.ts:216): single-answer `reRankAnswers` promotion skips question lifecycle update.
- **L5** (apprenticeship.ts:152): `pushContext k` unvalidated; negative k returns truncated results.

#### study-turn.ts (carina NL3) — 3 queued (was 4; C3 drained NL8)
- **C2** (study-turn.ts:141, 182): selectStudyQuestions can pick empty-body answer → spurious penalty.
- **C4** (study-turn.ts:213): negative cosine asymmetric lift penalty exceeds `-learningRate`. Design call.
- **C5** (study-turn.ts:128, 141): SQL limit applied before in-memory authored filter.

#### ephemeral-peer-review.ts (lumeyon NL4) — 6 queued
- **E1** (line 206): resume-write steals floor from non-orion turn (race).
- **E2** (line 206 + 213): `.turn` flipped before lock acquired (race; same fix area as E1).
- **E3** (line 213): lock failure outside try → edge stuck on "orion".
- **E4** (line 220, 256): dispatch failure leaves CONVO arrow `→ peer` while `.turn=parked`.
- **E5** (line 143): importer path repo-layout-dependent.
- **E7** (line 87): truncation by JS string length, not bytes.

#### import-from-kg.ts (keystone NL5) — 6 queued (was 7; K-imp-8 drained NL10)
- **K-imp-1** (parseSections:54): false sections from `## ` inside fenced transcripts.
- **K-imp-3** (importEdgeConvo:231): cross-archive Q→A pair lost when archiving splits.
- **K-imp-4** (importPairs:283): question idempotency read-then-insert race.
- **K-imp-5** (importPairs:322): try/catch swallows ALL errors as duplicate. Bug-masking.
- **K-imp-6** (importPairs:338): best_answer_id chosen via queryAnswers limit:1.
- **K-imp-7** (importPairs:355): peer-review retro-upgrade scans only first 5.

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

**NL12 → FRESH peer review on `plugins/agent-chat/scripts/lattice-context.ts` via carina (codex)**.

**Why a fresh peer review now (not queue-drain):**
- All 3 pre-approved schema migrations DONE (NL7 NOT NULL, NL9 FK, NL11 CHECK). No more migration-template work.
- Last fresh peer call was NL5 keystone. Six iters since (3 queue-drains, 3 schema migrations). Time to refill the findings queue with fresh material.
- File-touch rule satisfied: NL11 touched sqlite-store.ts; lattice-context.ts is a different file (and uncovered).
- Per peer rotation: next is carina (cycle position N+2 from NL5). Carina's specialty (embeddings, cosine math, grading thresholds) is a precise fit — lattice-context.ts wraps `pushContext` and prepares cosine-graded retrieval results for cmdRun.
- Expected ~5-7 new REAL findings based on the established pattern (NL1=5, NL3=5, NL4=7, NL5=8 — average 6.25 REAL findings per peer review).

**Plan for NL12:**
1. Tests-first.
2. Spawn `agent-chat ephemeral-peer-review --peer carina --module plugins/agent-chat/scripts/lattice-context.ts --task "Audit for REAL issues only: cosine threshold logic, push-context retrieval correctness, formatting boundary edges (truncation, empty results, peer-vs-self exclusion logic), data leak via included content, performance of large-corpus retrieval. Be terse — bullet points only with file:line citations."`.
3. Apply 1-retry resilience rule if codex flakes.
4. Classify findings; if any REAL → ship one fix this iter (test-first), queue rest. If all dismissed → STOP per stopping condition 6.
5. Update tracker + journal + prompt.md.

**Sequenced after NL12:**
- NL13+ → drain queued findings (now augmented by NL12's). With 16-21 expected total, the queue can sustain many drain iters.
- Eventually: fresh peer reviews on the 3 remaining uncovered modules (`stats.ts`, `synthesize-corpus.ts`, `validate-corpus.ts`).

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
- **Cumulative ledger (post-NL11):**
  - 25 REAL findings discovered across 5 peer reviews
  - 9 fixed at code level (L1, L2, L4, C1, C3, E6, K-imp-2, K-imp-8, iter-3 #2)
  - **3 schema migrations shipped (NL7 NOT NULL, NL9 FK, NL11 CHECK) — all pre-approved migrations DONE**
  - 16 queued findings + 0 pre-approval schema items remaining
  - Fix-rate: 36% (9/25 code) + all 3 schema migrations from peer findings shipped end-to-end.
  - Substrate's SQL-level integrity now fully matches its application-level integrity.

## NO synthetic work. NO inventing citations. NO authoring explanations of iteration N.

The substrate's job is to find real bugs and surface real architectural questions, not to grow its own metrics for their own sake.
