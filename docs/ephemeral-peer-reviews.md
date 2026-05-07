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
| `scripts/lattice/types.ts` | lumeyon (codex) | 2026-05-07 | reviewed | 9 raised: #1 quality-tier doc inversion (REAL, queued for iter 2), #2 explanation nullable type-hole (REAL, queued for iter 2), #3 status/best_answer_id consistency (REAL, queued for iter 2) | #4 depth-vs-DAG (design call), #5 Question lacks tier (design call), #6 Answer.cites missing (design call), #7 first-class Explanation type (refactor preference), #8 Question.embedding (design call), #9 branded ID types (refactor preference) | (smoke) b08e63f |

## Notes

- Petersen routing constraint: orion's only direct neighbors are
  lumeyon, keystone, and carina. Reviews requested via the routing
  table (`vanguard` for performance) are routed to the closest
  available neighbor with a journal entry explaining the substitution.
- Per-iteration peer-call budget: 3 max (1 review + 2 follow-ups).
- Per-module duplicate reviews allowed only when the module has been
  modified since the prior review (delta justifies a fresh look).
