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

## CURRENT STATE (as of NL24 commit)

### Covered modules:
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 4 fixed: #1, #2 fully end-to-end, #3 fully — NL7 closed #2 at SQL level)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, **all 3 fully shipped**: K1 runtime guard iter-7 + SQL FK NL9; K3 atomic DAG iter-8; K2 CHECK migration NL11)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, **4 fixed: L1+L2+L4+L3**; L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, **4 fixed: C1, C2, C3, C5**; C4 queued — design call)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, **5 fixed: E6, E3, E1, E2, E7**; E4, E5 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, **5 fixed: K-imp-2, K-imp-5, K-imp-8, K-imp-4, K-imp-6**; K-imp-1, 3, 7 queued; K-imp-9 added NL12 observation)

### Uncovered modules (priority for fresh peer reviews):
1. `scripts/lattice/stats.ts` — lumeyon or keystone fit
2. `scripts/lattice/synthesize-corpus.ts`
3. `scripts/lattice/validate-corpus.ts`

### Covered (added NL12):
- `plugins/agent-chat/scripts/lattice-context.ts` — carina NL12 (5 findings, **4 fixed: LC1, LC2, LC4, LC5**; LC3 partially-addressed-by-LC2-fix-when-exclude_agent-set)

### Queued findings (drainable WITHOUT fresh peer call — 8 total):

#### apprenticeship.ts (lumeyon NL1) — 1 queued (L3 drained NL17)
- **L5** (apprenticeship.ts:152): `pushContext k` unvalidated; negative k returns truncated results.

#### study-turn.ts (carina NL3) — 1 queued (C2 drained NL16, C5 drained NL20)
- **C4** (study-turn.ts:213): negative cosine asymmetric lift penalty exceeds `-learningRate`. Design call.

#### ephemeral-peer-review.ts (lumeyon NL4) — 2 queued (E3 drained NL14, E1+E2 drained NL21, E7 drained NL24)
- **E4** (line 220, 256): dispatch failure leaves CONVO arrow `→ peer` while `.turn=parked`.
- **E5** (line 143): importer path repo-layout-dependent.

#### import-from-kg.ts (keystone NL5) — 4 queued (K-imp-5 drained NL13, K-imp-4 drained NL18, K-imp-6 drained NL22)
- **K-imp-1** (parseSections:54): false sections from `## ` inside fenced transcripts.
- **K-imp-3** (importEdgeConvo:231): cross-archive Q→A pair lost when archiving splits.
- **K-imp-7** (importPairs:355): peer-review retro-upgrade scans only first 5. (Same shape as K-imp-6; same fix template.)
- **K-imp-9** (NL12 observation): pairSections may over-eagerly split bulleted peer-review responses into many Q/A pairs. carina's NL12 review yielded 6Q/9A vs typical 1Q/1A. Investigate.

#### lattice-context.ts (carina NL12) — 1 queued (LC1 drained NL15, LC2 drained NL19, LC4 drained NL23)
- **LC3** (lattice-context.ts:71): null best_answer survives exclude_agent filter — header-only block. **NOTE:** partially-addressed by LC2 fix when exclude_agent is set (pushContext now skips null-best_answer hits in walk loop). Remaining concern: header line "top-K" lying when exclude_agent unset.

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

**NL25 → DRAIN K-imp-7** (importPairs:355 peer-review retro-upgrade scans only first 5 — same template as K-imp-6).

**Why K-imp-7:**
- Same SHAPE as K-imp-6 (NL22): SQL `limit: 5` followed by in-memory `find()` to locate a specific answer (the freshly-imported peer-review one). If the target answer is at rank 6+ in the predictive_lift ordering, it's silently unreachable, and the retroactive upgrade (auto-imported tier-5 placeholder explanation → peer-review tier-3 authored explanation) doesn't fire.
- import-from-kg.ts last touched NL22 (3 iters gap at NL25 → file-touch rule satisfied; NL24 touched ephemeral-peer-review.ts and lattice-context.ts → different file).

**Read first:** `scripts/lattice/import-from-kg.ts` lines 350-365 (peer-review retro-upgrade block, the catch path of the recordAnswer try-catch).

**Fix approach options:**
- **Option A (cleanest, mirrors K-imp-6):** the answer's `id` is computable from `question_id + body + by_agent` (see `makeAnswerId` in sqlite-store.ts). Skip the queryAnswers + find() entirely; call `store.getAnswer(makeAnswerId(...))` directly.
- **Option B (LC2/C5 template):** raise the limit + push the disambiguator into the SQL filter. queryAnswers already supports `by_agent` and `body` (no — body isn't a filter axis). So adding a body axis or just raising the limit.
- Recommend A. The answer id is deterministic from the import inputs; computing it directly is the same trick we used at K-imp-6 ("USE the data you already have, don't re-query").

**Test approach (2 regression tests):**
- Test 1: seed a question with 6+ accepted answers where the target peer-review answer is at rank 6+ by predictive_lift. Re-import the same peer-review pair (PK conflict path triggers the retro-upgrade). Pre-fix: limit:5 doesn't see the target → upgrade doesn't fire → answer stays tier-5 with auto-imported explanation. Post-fix: getAnswer(id) finds it directly → upgrade applies → tier-3 + authored explanation.
- Test 2: simple-case sanity — single peer-review answer retro-upgrades correctly.

**Sequenced after NL25:**
- NL26 → L5 (apprenticeship.ts pushContext k validation — eligible after NL19+5=NL24 gap).
- NL27 → LC3 (header-only block when exclude_agent unset) — lattice-context.ts last touched NL24, eligible at NL27.
- NL28+ → K-imp-1, K-imp-3, K-imp-9, E4, E5, C4 (design call).
- Eventually: fresh peer review on stats.ts (next-cycle peer = carina by rotation; lumeyon or keystone fit).

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
- **Cumulative ledger (post-NL24):**
  - 30 REAL findings discovered across 6 peer reviews
  - 23 fixed at code level (L1, L2, L3, L4, C1, C2, C3, C5, E1, E2, E3, E6, E7, K-imp-2, K-imp-4, K-imp-5, K-imp-6, K-imp-8, iter-3 #2, LC1, LC2, LC4, LC5)
  - 3 schema migrations shipped
  - 8 queued findings remain
  - Fix-rate: 77% (23/30 code) + all 3 schema migrations
  - **SYSTEMIC pattern (LC2 = C5 = K-imp-6) confirmed THIRD time:** SQL limit BEFORE selection logic → silent wrong-row pick. Fix template varies in surface (LC2/C5: push filter axis into queryAnswers; K-imp-6: capture the function's already-existing return value), but the root principle is the same: don't query for what you already have, or push the disambiguator into the SQL. **K-imp-7 (queued) has the same shape**, with the same fix-template options.
  - **SYSTEMIC pattern (LC4 = E7) closed via shared helper extraction:** rather than copy-pasting the TextEncoder fix into a second file, NL24 extracted `plugins/agent-chat/scripts/utf8.ts` with `truncateToUtf8Bytes` + `utf8ByteLength` and refactored both LC4's truncateForBudget and E7's composeReviewPrompt to consume it. This is the COUNTER-PATTERN to LC5 = K-imp-2 (where the trailing-marker /m regex was copy-pasted across files): when the same bug shape shows up in a second file, EXTRACT the helper rather than re-applying the fix in two places.
  - **K-imp-6 lesson: when a function returns the data you need, USE the return value — don't re-query.** Pre-fix the importer dropped `recordAnswer`'s return and then re-queried for "which answer did I just insert?", introducing a tie-break dependency on SQLite's implementation-defined ordering. Post-fix uses the returned Answer directly. Audit other call sites that drop function returns and then re-query.
  - **LC4 lesson: when a unit is documented (bytes vs code units, ms vs s, decimal vs hex), enforce it at the boundary.** Pre-fix `body_budget_bytes` accepted a number called "bytes" and compared it to JS string length (UTF-16 code units) — silent unit mismatch. The compiler can't catch this; only documentation discipline and explicit conversion (TextEncoder, here) can. Audit other `*_bytes` and `*_ms` parameters across the codebase.
  - **E1+E2 lesson: races involving "guarantee state X before doing operation Y" are best fixed by reordering — Y first, then validate X under Y's protection.** Pre-fix the resume-write satisfied the lock-invariant by writing turn=self before the lock attempt, but that pre-lock write was the very thing that other actors could observe and race on. By moving the floor-stealing refusal upstream of the resume-write, we eliminated the corruption window without needing additional locking primitives. Audit other "satisfy invariant before lock" patterns in the codebase for the same race shape.
  - SYSTEMIC bug pattern (LC5 = K-imp-2): trailing-marker /m regex copy-pasted; should be a shared helper in a refactor iter.
  - **SYSTEMIC pattern (LC2 = C5):** SQL fetches a fixed limit, then in-memory filter drops candidates → silent truncation. Fix template (proven at NL19): push the missing filter axis into the data-layer query. Audit other queryAnswers callers for the same shape.
  - **L3 lesson: invariants need to be enforced in BOTH branches of a conditional.** Iter-5's joint-consistency invariant (status="answered" → best_answer_id non-null) was correctly enforced in setQuestionStatus AND in the multi-answer reRankAnswers branch — but the single-answer branch silently bypassed by calling the lower-level `setAnswerStatus` directly. Whenever a guard is added at the data-access layer, audit ALL call sites that could write inconsistent state, not just the obvious one.
  - **K-imp-4 lesson: race-safety belongs at the SQL primitive layer, not in app code.** Pre-fix, the importer did `getQuestion + putQuestion` and tried to be clever. Fix: introduce `tryPutQuestion` using `INSERT OR IGNORE`, and let SQL handle the atomicity. ANY ingest path that needs idempotent insert should use this primitive; never write check-then-act for uniqueness in app code. Audit other ingest paths (kg.ts, etc.) for the same anti-pattern.
  - **LC2 lesson: filtering AFTER a top-K slice is a silent-truncation antipattern.** Whenever a fixed-size buffer is followed by an in-memory filter, the filter can exhaust the buffer when the data distribution skews toward filtered-out items. Either (1) push the filter into the data layer, or (2) iterate-with-walk until enough eligible items are accumulated. Prefer (1) for SQL-friendly axes; (2) only when the filter logic doesn't fit SQL.
  - **Test design lesson: when refactoring a code path, regression tests should patch BOTH the pre-fix and post-fix call sites** so the test is robust across the transition. K-imp-4-a's monkey-patch handles both `getQuestion` (pre-fix path) and `tryPutQuestion` (post-fix path), enabling a single test that fails pre-fix and passes post-fix.

## NO synthetic work. NO inventing citations. NO authoring explanations of iteration N.

The substrate's job is to find real bugs and surface real architectural questions, not to grow its own metrics for their own sake.
