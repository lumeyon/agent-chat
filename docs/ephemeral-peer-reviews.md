# Ephemeral peer reviews — coverage tracker

The autonomous /loop drives orion to spawn ephemeral peer agents (lumeyon,
keystone, carina) to peer-review the agent-chat plugin's substrate code,
one module per iteration. This document tracks which modules have been
reviewed, by whom, with what outcome.

A module gets a row when at least one peer has reviewed it. Modules with
no row are eligible targets for the next "category A" iteration.

## Coverage

| Module | Peer | Date | Status | Issues filed | Dismissed | Commit |
|---|---|---|---|---|---|---|
| `scripts/lattice/types.ts` | lumeyon (codex) | 2026-05-07 | reviewed | 9 raised: #1 quality-tier doc inversion (FIXED iter 2), #2 explanation nullable type-hole (FIXED iter 3 — TS type + putAnswer guard; SQL NOT NULL pending boss approval), #3 status/best_answer_id consistency (FIXED iter 5 — joint invariant enforced at putQuestion + setQuestionStatus, importer rewritten, 2 production violations cleaned, 6 regression tests, 5 test files updated) | #4 depth-vs-DAG, #5 Question lacks tier, #6 Answer.cites missing, #7 first-class Explanation type, #8 Question.embedding, #9 branded ID types (all design calls or refactor preferences) | b08e63f, iter-2, iter-3, iter-5 |
| `scripts/lattice/sqlite-store.ts` | keystone (codex) | 2026-05-07 | reviewed | 3 raised: K1 best_answer_id not FK-validated (FIXED iter 7 — runtime guard at setQuestionStatus; schema FK migration pending boss approval); K2 CHECK quality_tier BETWEEN 1 AND 5 allows fractional — schema migration pending boss approval; K3 DAG cycle check race (FIXED iter 8 — BEGIN IMMEDIATE wraps check+insert in addCitation and addQuestionParent; 2 multi-connection regression tests added) | none — keystone returned all 3 as REAL findings, no nitpicks | iter-6, iter-7, iter-8 |
| `scripts/lattice/apprenticeship.ts` | lumeyon (codex) | 2026-05-08 | reviewed | 5 raised: L1 pushContext bypasses quality_tier_min / predictive_lift_min on best_answer_id path (FIXED new-loop iter 1); L2 pushContext treats best_answer_id as authoritative even when stale (null/superseded) (FIXED new-loop iter 1, same fix); L3 single-answer reRankAnswers promotion skips question lifecycle update (queued); L4 reRankAnswers exact-margin float comparison fails on `0.30 - 0.25 < 0.05` (FIXED iter NL6 — epsilon tolerance; 3 regression tests covering 0.30-0.25 case, 0.45-0.40 case, and the regression-prevention 0.50-0.48 below-margin case); L5 pushContext k unvalidated; negative k returns truncated results (queued) | none — all 5 returned as REAL findings | iter-NL1, iter-NL6 |
| `scripts/lattice/import-from-kg.ts` | keystone (codex) | 2026-05-08 | reviewed (NL5 retry succeeded) | 8 raised: K-imp-1 parseSections splits before validating headers — false sections from `## ` inside fenced transcripts (queued); K-imp-2 trailing-marker stripper used /m flag — internal `---` and `→ name` lines stripped from body content (FIXED iter NL5 — removed /m; 2 regression tests); K-imp-3 cross-archive Q→A pair lost when archiving splits between sections (queued); K-imp-4 question idempotency uses read-then-insert race instead of OR IGNORE (queued — same shape as iter-8 K3); K-imp-5 recordAnswer try/catch swallows ALL errors as "already imported" — masks non-PK failures (queued); K-imp-6 best_answer_id chosen via queryAnswers limit:1 instead of recordAnswer return (queued); K-imp-7 peer-review retro-upgrade only scans first 5 accepted answers — outside-window matches missed (queued); K-imp-8 Date.parse accepts non-UTC strings despite protocol — silent timestamp shift (queued) | none — all 8 returned as REAL findings | NL2 (timeout), NL5 (success after retry) |
| `scripts/lattice/study-turn.ts` | carina (codex) | 2026-05-08 | reviewed | 5 raised: C1 empty predictor output → cosine=0 → spurious lift penalty (FIXED iter NL3 — added `gradable` field to GradeResult; runStudyTurn skips applyGradeToLift when ungradable; 2 regression tests); C2 selectStudyQuestions can pick answer with empty body → same spurious penalty (queued); C3 NaN cosine propagates to predictive_lift (queued); C4 negative cosine asymmetric lift penalty exceeds learningRate (queued — design call); C5 SQL limit applied before in-memory authored filter — eligible answer rank≥6 silently unreachable (queued) | none — all 5 returned as REAL findings | iter-NL3 |
| `plugins/agent-chat/scripts/ephemeral-peer-review.ts` | lumeyon (codex) | 2026-05-08 | reviewed | 7 raised: E1 resume-write steals floor from any non-orion turn (queued — race condition); E2 .turn flipped before lock acquired — concurrent cmdRun race (queued — same fix area as E1); E3 lock failure outside try — edge stuck on orion if lock fails (queued); E4 dispatch failure leaves last CONVO arrow as "→ peer" while .turn=parked (queued — protocol invariant gap); E5 importer path repo-layout-dependent — silent null in packaged plugin layout (queued — portability); E6 --review-cap-bytes accepted NaN/negative (FIXED iter NL4 — explicit positive-integer validation; 3 regression tests); E7 truncation by JS string length not bytes — UTF-16 vs UTF-8 mismatch (queued — niche edge case) | none — all 7 returned as REAL findings | iter-NL4 |

## Notes

- Petersen routing constraint: orion's only direct neighbors are
  lumeyon, keystone, and carina. Reviews requested via the routing
  table (`vanguard` for performance) are routed to the closest
  available neighbor with a journal entry explaining the substitution.
- Per-iteration peer-call budget: 3 max (1 review + 2 follow-ups).
- Per-module duplicate reviews allowed only when the module has been
  modified since the prior review (delta justifies a fresh look).
