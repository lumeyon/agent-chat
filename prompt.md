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

## CURRENT STATE (as of NL23 commit)

### Covered modules:
- `scripts/lattice/types.ts` — lumeyon iter-1 (9 findings, 4 fixed: #1, #2 fully end-to-end, #3 fully — NL7 closed #2 at SQL level)
- `scripts/lattice/sqlite-store.ts` — keystone iter-6 (3 findings, **all 3 fully shipped**: K1 runtime guard iter-7 + SQL FK NL9; K3 atomic DAG iter-8; K2 CHECK migration NL11)
- `scripts/lattice/apprenticeship.ts` — lumeyon NL1 (5 findings, **4 fixed: L1+L2+L4+L3**; L5 queued)
- `scripts/lattice/study-turn.ts` — carina NL3 (5 findings, **4 fixed: C1, C2, C3, C5**; C4 queued — design call)
- `plugins/agent-chat/scripts/ephemeral-peer-review.ts` — lumeyon NL4 (7 findings, **4 fixed: E6, E3, E1, E2**; E4, E5, E7 queued)
- `scripts/lattice/import-from-kg.ts` — keystone NL5 (8 findings, **5 fixed: K-imp-2, K-imp-5, K-imp-8, K-imp-4, K-imp-6**; K-imp-1, 3, 7 queued; K-imp-9 added NL12 observation)

### Uncovered modules (priority for fresh peer reviews):
1. `scripts/lattice/stats.ts` — lumeyon or keystone fit
2. `scripts/lattice/synthesize-corpus.ts`
3. `scripts/lattice/validate-corpus.ts`

### Covered (added NL12):
- `plugins/agent-chat/scripts/lattice-context.ts` — carina NL12 (5 findings, **4 fixed: LC1, LC2, LC4, LC5**; LC3 partially-addressed-by-LC2-fix-when-exclude_agent-set)

### Queued findings (drainable WITHOUT fresh peer call — 9 total):

#### apprenticeship.ts (lumeyon NL1) — 1 queued (L3 drained NL17)
- **L5** (apprenticeship.ts:152): `pushContext k` unvalidated; negative k returns truncated results.

#### study-turn.ts (carina NL3) — 1 queued (C2 drained NL16, C5 drained NL20)
- **C4** (study-turn.ts:213): negative cosine asymmetric lift penalty exceeds `-learningRate`. Design call.

#### ephemeral-peer-review.ts (lumeyon NL4) — 3 queued (E3 drained NL14, E1+E2 drained NL21)
- **E4** (line 220, 256): dispatch failure leaves CONVO arrow `→ peer` while `.turn=parked`.
- **E5** (line 143): importer path repo-layout-dependent.
- **E7** (line 87): truncation by JS string length, not bytes.

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

**NL24 → DRAIN E7** (ephemeral-peer-review.ts:87 truncation by JS string length not bytes — same UTF class as LC4, just-fixed at NL23).

**Why E7:**
- Same SHAPE as LC4 (just fixed): module-source truncation in ephemeral-peer-review uses JS `.length` (UTF-16 code units), not UTF-8 bytes. For non-ASCII module content (e.g., comments with CJK, emoji in test fixtures) this under-counts.
- The fix template was just proven at NL23 — apply the SAME pattern (TextEncoder + boundary walk-back). Even better: lattice-context.ts now exports `truncateForBudget` which can be reused directly OR the helper can be extracted to a shared utility module.
- ephemeral-peer-review.ts last touched NL21 (3 iters gap → file-touch rule satisfied; NL23 touched lattice-context.ts → different file).

**Read first:** `plugins/agent-chat/scripts/ephemeral-peer-review.ts` lines 70-100 (composeReviewPrompt's module-source truncation). Confirm the exact truncation logic and whether the `--review-cap-bytes` arg is documented as bytes (it should be — "Bytes" is in the name).

**Fix approach options:**
- **Option A (reuse):** import `truncateForBudget` from lattice-context.ts. Quick but creates an awkward cross-plugin import (lattice-context belongs to the substrate; ephemeral-peer-review is a different concern).
- **Option B (extract):** create a small shared utility module (e.g., `scripts/utils/truncate-bytes.ts` or `plugins/agent-chat/scripts/utf8-truncate.ts`) that both modules import. Cleanest layering.
- **Option C (inline):** copy the implementation. Fastest, but creates the same systemic-pattern risk we already saw with LC5/K-imp-2.

Recommend **B** (extract to shared utility). Extraction is a one-time cost that benefits future iters (E7 alone, plus any other byte-truncation calls that show up).

**Test approach (parallel to LC4-a/-c/-d/-f):**
- Test 1: CJK module content over byte budget — truncated to ≤ budget bytes.
- Test 2: budget=0 → empty truncation.
- Test 3: sanity ASCII passthrough.
(Or just import the existing LC4 test pattern wholesale.)

**Sequenced after NL24:**
- NL25 → L5 (apprenticeship.ts pushContext k validation) — apprenticeship.ts last touched NL19, eligible at NL24 (5-iter gap). Could pick this for NL24 if E7 isn't ready.
- NL26 → K-imp-7 (peer-review retro-upgrade limit:5 — same template as K-imp-6).
- NL27+ → K-imp-1, K-imp-3, K-imp-9, E4, E5, LC3, C4 (design call).
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
- **Cumulative ledger (post-NL23):**
  - 30 REAL findings discovered across 6 peer reviews
  - 22 fixed at code level (L1, L2, L3, L4, C1, C2, C3, C5, E1, E2, E3, E6, K-imp-2, K-imp-4, K-imp-5, K-imp-6, K-imp-8, iter-3 #2, LC1, LC2, LC4, LC5)
  - 3 schema migrations shipped
  - 9 queued findings remain
  - Fix-rate: 73% (22/30 code) + all 3 schema migrations
  - **SYSTEMIC pattern (LC2 = C5 = K-imp-6) confirmed THIRD time:** SQL limit BEFORE selection logic → silent wrong-row pick. Fix template varies in surface (LC2/C5: push filter axis into queryAnswers; K-imp-6: capture the function's already-existing return value), but the root principle is the same: don't query for what you already have, or push the disambiguator into the SQL.
  - **SYSTEMIC pattern (LC4 = E7):** UTF-16 `.length` / `.slice` used for what is documented as a byte budget. NL23 fix established the TextEncoder + decode-at-boundary template; NL24 should apply the same template to E7 (or extract a shared helper module so future byte-truncation needs reuse it).
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
