# GPQA Diamond benchmark — single-model controls + agent-chat condition

> **Mission (NL37+):** measure whether agent-chat (claude-orion + codex peers + the substrate) beats single-model baselines on a hard benchmark. Pick: **GPQA Diamond** (198 expert-validated multiple-choice graduate-level science questions, "Google-proof"). Public leaderboard ballparks: claude top ~60-65%, codex top ~60-65%. Headroom + automated scoring + manageable size.
>
> Three conditions, same 198 problems, same answer-extraction:
>   1. **Codex baseline** — `codex exec <prompt>` per question, single shot.
>   2. **Claude baseline** — `claude -p <prompt>` per question, single shot.
>   3. **Agent-chat condition** — orion (claude) drafts an answer; ephemeral-peer-review dispatches a codex peer (lumeyon/keystone/carina) for a critique; orion produces a revised answer; final answer = orion's revised. Final answer parsed and compared to the same answer key.
>
> Win condition: agent-chat's accuracy > max(codex_baseline, claude_baseline) by a margin that's larger than ~3% noise floor (rough envelope for n=198).

The substrate-wiring loop (Phase A1-A4 shipped at NL34-NL36; A3+B+C+D+E deferred) is paused for this mission. The autonomous selection-pressure plumbing is shippable substrate but not yet validated as ACTUALLY producing useful signal — that validation comes from this benchmark.

## CURRENT STATE (as of NL37 commit / kickoff of this mission)

**Benchmark scaffolding shipped:**
- `benchmarks/gpqa-diamond/data/raw.csv` — 198-question Diamond CSV from idavidrein/gpqa@main (password `deserted-untie-orchid`).
- `benchmarks/gpqa-diamond/data/problems.jsonl` — normalized: `{id, domain, subdomain, question, choices: {A,B,C,D}, answer}`. Choice positions deterministically shuffled per record_id (mulberry32 PRNG, stringSeed of recordId).
- `benchmarks/gpqa-diamond/src/prepare.ts` — CSV → JSONL normalizer with seed-shuffled choices.
- `benchmarks/gpqa-diamond/src/run-baseline.ts` — single-model runner. Resumable (skips IDs already in output), supports `--limit`, `--start`, `--stop`, `--out`. Extracts `Answer: X` from response (last occurrence wins so chain-of-thought doesn't false-positive).
- `benchmarks/gpqa-diamond/src/score.ts` — per-domain accuracy, confusion table.

**Pilot results (2 questions per model):**
- Codex: 2/2 correct, ~18s/Q.
- Claude: 2/2 correct, ~9s/Q.

**Full baselines running in background as of this commit.**

## INVIOLABLE RULES

1. **TESTS-FIRST is paused** for benchmark runs (LLM calls are non-deterministic; we use `extractAnswer` parsing tests as the proxy for correctness). The `extractAnswer` regex must have its own unit tests before the full results are interpreted as authoritative.
2. **REPRODUCIBILITY.** All shuffles are seeded. Re-running `prepare.ts` produces the same `problems.jsonl`. Both baselines use the SAME problems.jsonl.
3. **HETEROGENEITY-FIRST.** The agent-chat condition's peer must be codex (lumeyon/keystone/carina). orion = claude. Same petersen topology that drove the prior 33-iter audit loop.
4. **SAME PROMPT, SAME EXTRACTION.** All three conditions use the same prompt template (`buildPrompt` in run-baseline.ts) and the same `extractAnswer` regex. Anything that changes the prompt or extraction pattern between conditions is an experimental confound.
5. **PAIRED COMPARISON.** Final report includes per-question deltas: which problems agent-chat got right that codex/claude alone missed (and vice versa). Aggregate accuracy alone is necessary but not sufficient.

## NEXT ITER TARGETS

**NL37 (this iter): scaffolding + kickoff baselines.** ✅ DONE.

**NL38 — verify baselines completed; score and report:**
- Wait for codex + claude background runs to finish (~30-60 min wall clock).
- Run `score.ts` on each result file.
- Add unit tests for `extractAnswer` (covering common LLM response shapes).
- Report: codex %, claude %, mean elapsed, per-domain breakdown, confusion matrix.

**NL39 — agent-chat condition design:**
- Adapt the runner to drive agent-chat instead of a single CLI.
- Approach: a new `run-agent-chat.ts` that, per problem:
  1. Prompts orion (claude) for an initial answer.
  2. Dispatches `ephemeral-peer-review` against the question + orion's draft. Picks a codex peer per the rotation table; the peer reviews orion's reasoning.
  3. Prompts orion (claude) again with the original question + peer feedback; orion produces a revised answer.
  4. Extracts the final letter from orion's revised answer.
- Each problem gets exactly 1 peer review (1 codex call + 2 claude calls = 3 LLM calls per problem). Cost: ~$0.10/problem × 198 = ~$20.
- Existing `ephemeral-peer-review.ts` is the right primitive but it currently expects a MODULE PATH for code review. The benchmark needs a different review prompt: "given this question and this proposed answer, critique the reasoning". May need a `--task-text` option OR a new lightweight wrapper.

**NL40 — agent-chat run + comparison:**
- Run the full 198 through the agent-chat condition.
- Aggregate accuracy + paired comparison (which problems each condition uniquely solved).
- Score; report.

**NL41+ — analysis + iteration:**
- If agent-chat ≥ baselines: characterize where the gain came from. Which domains? Which prompt patterns? Did the peer review consistently catch a class of errors?
- If agent-chat < baselines: characterize the failure mode. Is the peer review too critical? Did orion over-correct? Did the peer's prediction confuse orion's reasoning?
- Iterate on the agent-chat condition's prompt/structure.

## STOPPING CONDITIONS

1. Both baselines completed AND agent-chat condition completed AND comparison reported. The first cycle is done.
2. agent-chat < baseline by >5% — root-cause and decide whether to redesign the condition or accept that GPQA isn't the right benchmark for this substrate.
3. agent-chat ≥ baseline by 5%+ — we have a real result; consider running on a 2nd benchmark (SWE-bench Verified or HLE) for cross-benchmark validation.

## CADENCE

This mission isn't naturally /loop-driven the same way the audit loop was — each iter is shaped around "did the background run finish? then score and decide." Use foreground commands when the boss is engaged; background runs for the LLM-heavy work.

## LESSONS LEARNED (carried forward from prior loops)

- **Heterogeneity is real and free for us.** lumeyon/keystone/carina = codex. orion = claude. The infrastructure to dispatch cross-model is already shipped (ephemeral-peer-review.ts, NL30 hardened).
- **Investigate before fixing.** A surprising result might be a measurement artifact (NL33 K-imp-9 = metric misinterpretation). Reproduce the failure mode before redesigning.
- **Validate at API boundaries.** `extractAnswer` is the load-bearing parser between the LLM's prose and the score. Unit-test it on edge cases (bold "**Answer: A**", "Answer is C.", "(B)", chain-of-thought saying "Answer: D would be wrong because... [final] Answer: A").
- **Cumulative ledger (post-NL36):** 30 original peer findings fixed + 3 schema migrations + 3 wiring steps for the autonomous-loop substrate (A1, A2, A4). Substrate is hardened and tested but not yet VALIDATED to produce useful signal — that validation is the current mission.

## NO speculative claims about agent-chat's lift before we measure. The point of running the baselines first is to know what we're measuring AGAINST.
