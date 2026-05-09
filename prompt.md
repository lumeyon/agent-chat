# GPQA Diamond benchmark — single-model controls + agent-chat condition

> **Mission (NL37+):** measure whether agent-chat (claude-orion + codex peers + the substrate) beats single-model baselines on a hard benchmark. Pick: **GPQA Diamond** (198 expert-validated multiple-choice graduate-level science questions, "Google-proof").
>
> **Public ballpark vs OBSERVED partial signal (NL38):** public leaderboards put top claude/codex at ~60-65%. Our partial runs are higher: codex 41/48 = 85.4%, claude 61/68 = 89.7% so far. Likely reasons: newer model versions (claude-sonnet-4.6, codex-cli 0.128) than the published reports, plus our chain-of-thought prompt template. **This raises the bar for agent-chat** — it needs to add real value over ~85-90%, not over 60-65%.
>
> Three conditions, same 198 problems, same answer-extraction:
>   1. **Codex baseline** — `codex exec <prompt>` per question, single shot.
>   2. **Claude baseline** — `claude -p <prompt>` per question, single shot.
>   3. **Agent-chat condition** — orion (claude) drafts an answer; ephemeral-peer-review dispatches a codex peer (lumeyon/keystone/carina) for a critique; orion produces a revised answer; final answer = orion's revised. Final answer parsed and compared to the same answer key.
>
> **Win condition:** agent-chat accuracy > max(codex, claude) by a margin > ~3% noise floor (rough envelope for n=198). At 85-90% baselines, even a +3% delta is meaningful; +5% is solid.
>
> **Loss path is informative.** If agent-chat < baselines, the response logs explain why — codex critique misled orion? orion ignored good critique? peer review introduced new errors? Each failure mode tells us how to redesign.

The substrate-wiring loop (Phase A1-A4 shipped at NL34-NL36; A3+B+C+D+E deferred) is paused for this mission. The autonomous selection-pressure plumbing is shippable substrate but not yet validated as ACTUALLY producing useful signal — that validation comes from this benchmark.

## CURRENT STATE (as of NL38, baselines mid-flight)

**Benchmark scaffolding shipped (NL37+NL38):**
- `benchmarks/gpqa-diamond/data/raw.csv` — 198-question Diamond CSV from idavidrein/gpqa@main (password `deserted-untie-orchid`).
- `benchmarks/gpqa-diamond/data/problems.jsonl` — normalized: `{id, domain, subdomain, question, choices: {A,B,C,D}, answer}`. Choice positions deterministically shuffled per record_id (mulberry32 PRNG, stringSeed of recordId).
- `benchmarks/gpqa-diamond/src/prepare.ts` — CSV → JSONL normalizer with seed-shuffled choices.
- `benchmarks/gpqa-diamond/src/run-baseline.ts` — single-model runner. Resumable (skips IDs already in output), supports `--limit`, `--start`, `--stop`, `--out`. Imports the canonical `extractAnswer` from extract.ts.
- `benchmarks/gpqa-diamond/src/extract.ts` (NL38) — canonical extractor. Handles `Answer: X`, markdown bold, parens, lowercase/all-caps, single-letter responses, refusals. Last-occurrence wins so chain-of-thought doesn't false-positive on intermediate "Answer: D would be wrong".
- `benchmarks/gpqa-diamond/src/extract.test.ts` (NL38) — 25 unit tests covering all common LLM response shapes + edge cases. All pass.
- `benchmarks/gpqa-diamond/src/rescore.ts` (NL38) — re-applies the canonical extractor to a saved results.jsonl. Useful for any results files written before extract.ts existed; cheap pure-text re-parse, no LLM cost.
- `benchmarks/gpqa-diamond/src/score.ts` — per-domain accuracy, confusion table.

**Per-question data captured for every condition** (in `results/<model>.jsonl`):
- `id`, `domain`, `subdomain`, `prompt_chars`, `response` (full prose), `answer_extracted`, `answer_expected`, `correct`, `elapsed_ms`, `error?`.
- Three result files JOIN cleanly by `id` for paired comparison once agent-chat lands.

**Background runs status (NL38 cont):**
- Claude FIRST PASS COMPLETED: 173/198 = **87.4%**. 9 timeouts (240s SIGTERM, empty response) + 3 Usage Policy refusals (SARS-CoV-2-class biology questions, claude-canned refusal text). By domain: Physics 84/86 = 97.7%, Chemistry 78/93 = 83.9%, Biology 11/19 = 57.9% (skewed by refusals).
- Claude RETRY in progress (background task `bgru2dp2g`): the 9 timeout questions re-running with **20-minute budget per question** (`--timeout-ms 1200000` + `--retry-timeouts` drops the failed entries first). Refusals NOT retried (rerunning same prompt yields same refusal). ETA: probably 30-90 min wall (depends on how many of the 9 actually need long thinking budgets vs. would have finished in 5-7 min if not killed at 240s).
- Codex first pass STILL IN PROGRESS: 149/198 (75%); some timeouts in there too (count TBD on completion); will need its own --retry-timeouts pass with 20-min budget after first pass finishes.

**Fairness budget decision (NL38):** the boss called for 20-min/question across all conditions. Reason: agent-chat will fire 3 LLM calls per question (claude draft + codex critique + claude revise), so its worst-case wall is 60 min/question. We accept that — it's the fair compute budget. Claude/codex baselines retry with the SAME 20-min budget on the questions where they originally timed out.

**Operational state:**
- Monitor armed (task `bodwykny5`): tails both log files, fires on `# done`/`FATAL`/`cli exited`/`Traceback`. Persistent for the session.
- The /loop wakes itself on Monitor events OR every ~25-30 min as a heartbeat fallback.

## INVIOLABLE RULES

1. **TESTS-FIRST is paused** for benchmark runs (LLM calls are non-deterministic; we use `extractAnswer` parsing tests as the proxy for correctness). The `extractAnswer` regex must have its own unit tests before the full results are interpreted as authoritative.
2. **REPRODUCIBILITY.** All shuffles are seeded. Re-running `prepare.ts` produces the same `problems.jsonl`. Both baselines use the SAME problems.jsonl.
3. **HETEROGENEITY-FIRST.** The agent-chat condition's peer must be codex (lumeyon/keystone/carina). orion = claude. Same petersen topology that drove the prior 33-iter audit loop.
4. **SAME PROMPT, SAME EXTRACTION.** All three conditions use the same prompt template (`buildPrompt` in run-baseline.ts) and the same `extractAnswer` regex. Anything that changes the prompt or extraction pattern between conditions is an experimental confound.
5. **PAIRED COMPARISON.** Final report includes per-question deltas: which problems agent-chat got right that codex/claude alone missed (and vice versa). Aggregate accuracy alone is necessary but not sufficient.

## NEXT ITER TARGETS

**NL37 — scaffolding + kickoff baselines.** ✅ DONE.

**NL38 (mid-flight):** ✅ extract.ts pulled into its own module + 25 unit tests + rescore.ts harness for post-hoc re-parsing of saved responses. Run-baseline.ts now imports the canonical extractor. Sanity: rescore on partial baselines = 0 deltas (old + new extractors agree on every observed shape). **Still pending in NL38: wait for both baselines to finish, run `rescore.ts` (no-op expected; defensive), run `score.ts`, report final aggregates per model + per-domain + confusion matrix.**

**NL39 — agent-chat condition runner:** ✅ SHIPPED + SMOKED.
- `benchmarks/gpqa-diamond/src/run-agent-chat.ts`. Same flag shape as run-baseline.ts (resumable, --retry-timeouts, --timeout-ms default 1_200_000 = 20 min/call). Per problem fires 3 LLM calls:
  1. **Draft** — claude (orion) sees question + 4 choices → CoT + `Answer: X`.
  2. **Critique** — codex (peer chosen by `hash(question_id) % 3` from [lumeyon, keystone, carina], heterogeneity-first) sees question + draft. Critic does NOT see the answer key.
  3. **Revise** — claude (orion) sees question + draft + critique → final `Answer: X`. Final letter = revised answer.
- Per-question captures (`results/agent-chat.jsonl`): `id`, `domain`, `subdomain`, `peer`, `claude_draft_response`, `claude_draft_letter`, `codex_critique_response`, `claude_revised_response`, `answer_extracted`, `answer_expected`, `correct`, `elapsed_ms` (total) + per-call elapsed, `prompt_chars_*`, `error?`.
- Failure handling: draft-fail records the entry & skips. Critique-fail keeps claude's draft as the final (don't penalize agent-chat below claude-alone for codex hiccups). Revise-fail falls back to draft letter.
- Smoke (1 question, Physics-general): draft 6.9s → carina critique (endorsed C) 12.7s → revise 9.6s → C ✓. Total 29s end-to-end.
- **Will NOT fire the full 198 until codex first-pass + both retry passes are settled** to avoid CPU/LLM-rate contention during the comparison run.

**NL40 — sequence (gated on background runs):**
1. **Wait for codex first-pass to finish** (currently 162/198 ≈ 82%; ETA ~20-30 min on 240s budget; some timeouts will land in there).
2. **Run codex retry**: `bun run-baseline.ts --model codex --retry-timeouts --timeout-ms 1200000 --out results/codex.jsonl` in background. Parallels what claude retry is doing now.
3. **Wait for claude retry to finish** (started NL38, 9 timeouts re-running with 20-min budget; ETA varies 30-90 min depending on actual think time).
4. **Wait for codex retry to finish** (number of timeouts TBD until first-pass done).
5. **Final baseline scores**: `score.ts` on each.
6. **Kick off agent-chat full run**: `bun run-agent-chat.ts --timeout-ms 1200000 --out results/agent-chat.jsonl` in background. ~30s/Q baseline × 198 ≈ 100 min wall on the easy path; worst case much longer with timeouts.
7. **3-way comparison**: build `compare.ts` that JOINs codex/claude/agent-chat results by id and emits:
  - Aggregate accuracy.
  - **Paired wins**: questions agent-chat got right that codex/claude alone missed; the reverse.
  - Per-domain breakdown.
  - Diagnostic side-by-side for disagreement cases.

**NL41+ — analysis + iteration:**
- If agent-chat ≥ max(baselines) by >3%: characterize where the gain came from. Which domains? Which prompt patterns? Did the codex critique consistently catch a class of error claude-alone missed?
- If agent-chat < max(baselines) by >3%: characterize the failure mode from the saved responses. Common patterns: critique misled orion to flip a correct answer; peer was overconfident in a wrong direction; orion over-weighted critique even when its own draft was right. Each failure mode suggests a specific redesign.
- If within ±3%: design a follow-up experiment that increases substrate's role (e.g., reRankAnswers on multiple peer answers; LLM-as-judge replacing cosine grading from the autonomous-loop work).

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
- **Per-question data is the audit trail.** Every condition writes one JSONL line per question with the FULL prose response + parsed letter + correct flag + elapsed. Three conditions JOIN cleanly by `id`. Lossless. Comparison tooling is straightforward when agent-chat lands; don't pre-build the comparison report before we have all three datasets — use the partial baselines to validate the JOIN shape, build the report once.
- **Cumulative ledger (post-NL36):** 30 original peer findings fixed + 3 schema migrations + 3 wiring steps for the autonomous-loop substrate (A1, A2, A4). Substrate is hardened and tested but not yet VALIDATED to produce useful signal — that validation is the current mission.

## NO speculative claims about agent-chat's lift before we measure. The point of running the baselines first is to know what we're measuring AGAINST.
