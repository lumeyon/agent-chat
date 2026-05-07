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

## Notes

- Petersen routing constraint: orion's only direct neighbors are
  lumeyon, keystone, and carina. Reviews requested via the routing
  table (`vanguard` for performance) are routed to the closest
  available neighbor with a journal entry explaining the substitution.
- Per-iteration peer-call budget: 3 max (1 review + 2 follow-ups).
- Per-module duplicate reviews allowed only when the module has been
  modified since the prior review (delta justifies a fresh look).
