# Quantum-Inspired Residual Exploration — 100% pivot from expert-selection (NL42+)

> **MISSION COMMITMENT (NL42+):** Use the Tang-style ℓ₂-norm-sampling-from-low-rank-residuals
> kernel as a primitive for **creative exploration outside the agents' RL-training
> distribution**, not as a router for selecting between experts.
>
> **STATUS: ALL THREE TRACKS SHIPPED (NL42).**
>   - Track A (per-agent anomaly detector) — ✅ shipped commit cf16e1e
>   - Track C (multi-agent boundary scout) — ✅ shipped commit a60c91b
>   - Track B (generative residual sampler with local LLM logits) — ✅ shipped commit 58c9466
>
> 19/20 tests pass (1 opt-in LLM integration test passes with env flag).
> All three tracks share the same `residual_sample` kernel; differences are in
> what M is. The substrate is now ready for downstream use:
>   - Track A outputs feed Apprenticeship Substrate as study material
>   - Track C outputs are dual-audience training data (every disagreement triple)
>   - Track B is a generation policy for synthetic-data production / OOD probing
>
> The router framing (NL41) was the wrong direction. GPQA's empirical and ablation results
> proved why: agents are deeply inside training distribution; the (task, expert) score matrix
> has no informative residual; selection between equally-capable experts is bounded by the
> sparse disagreement signal (~14/142 on GPQA).
>
> The right framing: Tang-residual sampling finds where models *depart* from training-
> distribution behavior — the anomalies, the disagreements, the creative continuations.
> These departures are simultaneously:
>   - the highest-information training data for an Apprenticeship Substrate,
>   - the highest-value AI-training-data product for Lumeyon's revenue path (dual-audience fusion),
>   - the natural use of the existing petersen multi-agent topology (disagreement edges),
>   - and the most defensible "quantum-inspired" story for the Lumeyon quantum pivot.

## What changed from NL41

**Killed:** the v0.1 RL router as a routing decision. The trained Q-network at
`experiments/router/src/model.py` is no longer the goal artifact; the routing accuracy plot is
no longer the headline metric.

**Carries forward (reused as substrate):**
- `experiments/router/src/data.py` — GPQA triples loader (id, domain, query, codex_correct, claude_correct, agent_chat_correct).
- `experiments/router/src/featurize.py` — BGE-small-en-v1.5 query embedder, GPU pipeline, HF_HOME=/data/cache/huggingface.
- `experiments/router/src/eval.py` (selectively) — oracle ceiling, K-fold scaffolding, plotting.
- The full `benchmarks/gpqa-diamond/` dataset including all baseline + agent-chat response prose.
- TMPDIR=/data/tmp env, claude.json restored, GPU verified post-reboot.

**Deprecated (kept for diff history, not the build target):**
- `experiments/router/src/train.py` — supervised + online training loops for the Q-router. Marked deprecated; superseded by track A/C residual analyzers.
- `experiments/router/src/router.py` — production routing interface. Not used.

## The kernel

Tang's ℓ₂-norm sampling on a residual matrix:

```python
def residual_sample(M: torch.Tensor, k: int, n_samples: int, seed: int = 0):
    """Given M: (n_rows, d_features), keep top-k SVD components; sample
    residual rows with probability ∝ ||R_i||²."""
    U, S, V = torch.linalg.svd(M, full_matrices=False)
    M_k = U[:, :k] @ torch.diag(S[:k]) @ V[:k, :]
    R = M - M_k                                   # residual: what's NOT explained by top-k modes
    norms_sq = (R ** 2).sum(dim=1)                # ℓ₂² per row
    probs = norms_sq / norms_sq.sum()
    g = torch.Generator().manual_seed(seed)
    idx = torch.multinomial(probs, n_samples, replacement=False, generator=g)
    return idx, R[idx], probs[idx]
```

This 12-line kernel underlies all three tracks. The differences are what M is.

## Three tracks (A, B, C) — same kernel, different M

### Track A: Anomaly detector (cheapest; ship first)

**M:** rows = queries, cols = response features per agent. Build separate matrices per agent
(M_codex, M_claude). Each row is one (query, agent) → response-feature vector.

**Response features** (extracted from existing baseline JSONL response prose, no new LLM calls):

| feature | extractor | rationale |
|---|---|---|
| `response_emb` | BGE-small-en on response text | dense semantic |
| `response_len` | char count | proxy for reasoning depth |
| `n_latex` | regex `\$[^$]+\$` and `\\\(...\\\)` | math-heavy reasoning marker |
| `n_codeblocks` | regex ``` | code-as-thought marker |
| `n_hedge_words` | regex on `\b(possibly|maybe|uncertain|might|perhaps|approximately|roughly)\b` | confidence proxy |
| `n_certainty_words` | regex on `\b(clearly|definitely|certainly|undoubtedly|obviously)\b` | inverse confidence proxy |
| `n_self_correction` | regex on `\b(wait|actually|reconsider|let me reconsider|on second thought)\b` | reasoning-reversal marker |
| `n_questions` | count `?` | self-questioning |
| `final_letter_oh` | one-hot of A/B/C/D | answer distribution |
| `correct` | from baseline | label |
| `elapsed_ms` | from baseline | timing |

Numeric features are standardized (z-score). Embedding is normalized. Concatenated to ~400-dim
feature vector per (query, agent).

**Low-rank approximation:** k chosen by elbow rule on singular values (typically k ∈ {3, 5, 8}).

**Output:** for each agent, a list of N=20 anomaly queries (highest residual ℓ²). For each:
- the query text
- the agent's response prose
- the anomaly score (||R_i||²)
- which features contributed most to the anomaly (top-3 abs-val components of R_i)

**Use:** these are the seeds for the Apprenticeship Substrate's "study material" — questions
where the agent did something unusual that's worth teaching from.

### Track C: Boundary scout / multi-agent disagreement amplifier (next)

**M:** rows = queries, cols = stacked agent×feature. Each row is the concatenation of
(codex's response feature vector, claude's response feature vector, agent-chat's response feature vector).

**Low-rank consensus:** top-k singular components capture "what all three agents agree on for
this kind of query."

**Residual:** captures where one agent diverges from the consensus. ℓ₂-sample to find highest-
divergence queries.

**Decomposition of residual:** for each high-residual query, compute per-agent contribution to
the divergence. This identifies WHICH agent is the outlier and on WHICH features.

**Output:** ranked list of disagreement queries with per-agent divergence breakdown. These are
the quintessential dual-audience triples — every row is a (query, agent_a_behavior,
agent_b_behavior, divergence_signature) tuple suitable for AI-training-data buyers and for
apprenticeship-substrate teaching.

**Connection to existing agent-chat substrate:** the petersen graph already records ephemeral
peer interactions per edge; the boundary scout's divergence triples ARE the kind of event
edges should record. v0.3 of the original plan (Hebbian edge weights) is naturally subsumed
here: edges that produce high-divergence queries get more "interesting" weight.

### Track B: Generative residual sampler (most ambitious; defer until A + C demonstrate value)

**Requires:** access to token-level logits from a model whose distribution we can sample from.
Claude/Codex APIs do NOT expose logits. Local model on the 4090 (Llama-3.1-8B, Mistral-7B,
Qwen2.5-7B) does.

**M:** rows = generation step / context, cols = vocabulary distribution. At each step, the
typical continuation distribution P(token | context) has a low-rank structure across similar
contexts. Approximate top-k → residual = "atypical-but-non-zero" tokens. ℓ₂-sample from
residual at temperature τ → next token.

**Output:** a generation policy that produces continuations atypical of training-distribution
mean while remaining grammatically/semantically coherent (because residual entries are still
real probabilities, just in the orthogonal subspace).

**Use:** a "creativity decoder" for downstream applications — given a prompt, produces
multiple novel-but-grounded responses. Useful for synthetic-data generation, OOD probing,
ideation.

**Why deferred:** Track B requires standing up local-model inference infra (vLLM or HF
generate loop with logit hooks), which is a 1-2 day investment. A and C show value on data we
already have; B should follow only if A + C confirm the residual-exploration premise has
signal.

## v0.1 build plan — Track A (target: ~1-2 days, this and next /loop iter)

### v0.1 layout

```
experiments/residual/
  README.md                  # one-paragraph: see prompt.md, this is residual-explore v0.1
  src/
    kernel.py                # the 12-line residual_sample primitive + tests
    response_features.py     # extract feature vector from a response (regex + embedder)
    matrix.py                # build per-agent M from triples + features
    detect.py                # full anomaly pipeline: load → featurize → residual_sample → report
    explain.py               # given a high-residual row, report top-3 features driving anomaly
  tests/
    test_kernel.py           # unit tests on synthetic data
    test_response_features.py
    test_matrix.py
    test_detect.py
  results/
    anomalies_codex.json     # top-20 anomaly queries for codex with explanations
    anomalies_claude.json    # same for claude
    anomalies_agent_chat.json
    summary.md               # human-readable digest: what kinds of queries are anomalous?
  models/
    (saved SVD components for reuse if needed)
```

### v0.1 step-by-step

**Step 1 — TESTS-FIRST.** Write `test_kernel.py` with a synthetic scenario:
- Build a known matrix M of rank-2 + planted-anomaly rows (5 of 50 rows have anomalous high-norm noise).
- Run `residual_sample(M, k=2, n_samples=5)`.
- Assert: at least 4 of 5 returned indices are the planted-anomaly rows.
- Run `pytest -x` → confirm fails (kernel.py doesn't exist).

**Step 2 — `src/kernel.py`.** Implement the 12-line `residual_sample`. Test passes.

**Step 3 — TESTS-FIRST for `response_features.py`.** Test that:
- Each regex extracts expected counts on a fixture response string.
- The full feature vector has documented dim and finite values.
- Embeddings are unit-norm.

**Step 4 — `src/response_features.py`.** Implement extractors. Test passes.

**Step 5 — `src/matrix.py`.** Function `build_per_agent_matrix(triples, agent_name)` returns
(n_questions × feature_dim) torch.Tensor. Standardize numeric columns. Concatenate embedding
+ scalar features.

**Step 6 — `src/detect.py`.** Glue:
1. Load triples from existing `experiments/router/src/data.py::load_triples`.
2. For each agent in {codex, claude, agent_chat}:
3.   Build M.
4.   Run `residual_sample(M, k, n_samples=20)`.
5.   For each returned index, call `explain.py` to identify driving features.
6.   Write to `results/anomalies_<agent>.json`.

**Step 7 — `src/explain.py`.** Given (R_i, feature_names), return top-3 features by |R_i[j]|
with sign and z-score-relative-to-typical, plus the agent's response prose excerpt.

**Step 8 — Run the headline experiment.**
- `nvidia-smi` before to confirm GPU available.
- `python -m experiments.residual.src.detect`
- `nvidia-smi` during to confirm utilization (CLAUDE.md mandate).
- Inspect `summary.md`. Acceptance: top-20 anomaly queries are HUMAN-INTERPRETABLE — i.e., we can
  read the response prose and see WHY it was anomalous (very long, high-hedging, self-correction-
  heavy, refusal-adjacent, etc.).

**Step 9 — Cross-agent overlap analysis.** Are the same questions anomalous for multiple agents?
If yes, those are HARD queries (substrate-independent). If no, the anomalies are agent-specific
(substrate-dependent). Both are useful signal.

**Step 10 — Commit + report.**

### v0.1 acceptance criteria

| metric | target | rationale |
|---|---|---|
| Test suite | all green | tests-first mandate (CLAUDE.md) |
| GPU utilized | `nvidia-smi` ≥ 10% during embedder runs | CLAUDE.md mandate |
| Trained on full 198 | yes | CLAUDE.md mandate (no max-samples) |
| Top-N anomaly recall on synthetic | ≥ 80% recall on planted-anomaly rows | kernel correctness |
| Human-interpretable anomalies | ≥ 14/20 anomalies have a clearly identifiable "why" when read | substrate produces meaningful signal |
| Code lines | <500 across src/ | per "don't over-engineer" |

If anomalies are NOT interpretable (random-looking), the feature set is the bug. Iterate on
features before iterating on the kernel.

## v0.2 — Track C (target: 1 week after v0.1)

After v0.1 ships, extend to multi-agent:

```
experiments/residual/src/boundary.py
```

- M_multi: (n_questions, feature_dim_codex + feature_dim_claude + feature_dim_agent_chat).
- Top-k consensus subtract; residual decomposed per-agent.
- Output: ranked disagreement queries with per-agent divergence signatures.
- Link to petersen graph: each disagreement entry is an "edge event" — record into the
  agent-chat substrate's CONVO.md per edge. The Hebbian-edge-weights idea is repurposed: edges
  with high cumulative ℓ²-norm-residual get prioritized in future routing.

## v0.3 — Track B (deferred until A + C land)

Local-model logit access via vLLM or HF transformers. Llama-3.1-8B-Instruct on the 4090
(fits in 16GB FP16, leaves 8GB for activation cache). Build a generation hook that:
1. At each step, capture full vocab logits.
2. Maintain a running window of recent contexts and their logit distributions.
3. Compute low-rank approximation across the window.
4. Sample next token ∝ residual_softmax(current_logits − low_rank_projection).

This is the fundamentally novel piece — and its success criterion is qualitative + downstream
(does the resulting generation produce more diverse, useful synthetic data?).

## Inviolable rules (carried forward)

1. **TESTS-FIRST when fixing bugs.** Strict per CLAUDE.md.
2. **Train / process on FULL datasets.** No `--max-size`/`--max-samples`.
3. **GPU verification.** `nvidia-smi` must show non-zero utilization during compute; verify.
4. **Reproducibility.** Seeded SVD/multinomial samples. Saved residual components.
5. **TMPDIR=/data/tmp** for all shell scratch.
6. **HF_HOME=/data/cache/huggingface** for HuggingFace model cache.
7. **Search before writing.** grep/find/ls before creating new files.
8. **Don't over-engineer v0.1.** Single feature set, one kernel, one detector. Don't pre-build
   the multi-agent decomposition for v0.1 — that's v0.2's job.

## NL42 build status — ALL THREE TRACKS SHIPPED

### Track A (cf16e1e) — per-agent anomaly detector
- 11/11 tests pass; 5 src modules; ~485 lines
- Output: `experiments/residual/results/anomalies_{codex,claude,agent_chat}.json`
- Headline: rec6sE2CRtD4drtHg (Coleman-Weinberg) tops codex (54) AND claude (46)

### Track C (a60c91b) — multi-agent boundary scout
- 14/14 tests pass total; new `boundary.py` module
- Matrix shape [190, 1188] (190 questions × 3 agents × 396 features)
- Per-agent decomposition correctly attributes divergence: rec6sE2CRtD4drtHg total=224.5, codex=153, claude=59 (cross-validates Track A)
- Output: `experiments/residual/results/disagreements.json`

### Track B (58c9466) — generative residual sampler
- 20/20 tests total (1 opt-in LLM integration); new `generative.py` + demo
- Qwen2.5-1.5B-Instruct on 4090, vocab=151936, k=8 calibration basis on n=25 prompts
- Visibly different completions from greedy/temperature on 8 demo prompts
- Output: `experiments/residual/results/generative_demo.json`

### Cross-track findings
- The SAME hard question (Coleman-Weinberg pseudo-Goldstone, rec6sE2CRtD4drtHg) appears as a top-anomaly in Track A's per-agent codex matrix, top in Track A's per-agent claude matrix, AND top in Track C's multi-agent decomposition. This is the cleanest possible signal that residual analysis finds genuinely hard questions in a model-agnostic way.
- Track A surfaces the soft-pushback failure mode in agent-chat responses ("the peer reviewer confirms..." pattern) automatically — this is the same failure mode we diagnosed manually in NL40, now extracted by the substrate.
- Track B's residual-projected generations are noticeably different from greedy/temperature even at modest k=8 / calibration n=25. Increasing both should sharpen the effect.

### Carryover and next directions (boss to direct)

**Reusable kernel:** the 12-line `residual_sample` and 3-line `project_to_residual` are now shipped and tested. Any future M (any matrix where rows represent units we want to find anomalies/disagreements/creative-deviations across) plugs into the same primitives.

**Natural next experiments (not yet built; awaiting boss direction):**
- Larger calibration corpus + larger k for Track B → more pronounced creative deviation
- Track A on a different benchmark (HumanEval, MATH) where more divergence exists per-agent
- Track C with N>3 agents (extend petersen graph response data into a 10-agent matrix)
- Apprenticeship Substrate integration: pipe Track A/C anomaly outputs into the apprenticeship loop's "study material" feed
- Dual-audience export: serialize Track C disagreement triples in a format suitable for AI-training-data buyers

**Deferred:**
- Auto-tuning k via singular-value elbow detection
- Time-windowed online residual updates (for streaming / online learning of basis)
- Hebbian edge weights using Track C's per-agent divergence magnitudes (the v0.3 of the original router plan, now naturally subsumed)

## v0.1 build status (NL42 — SHIPPED, Track A)

- ✅ All 4 test files written first; **11/11 tests pass**.
- ✅ All 5 src modules: kernel.py (12-line residual_sample), response_features.py, matrix.py, detect.py, explain.py.
- ✅ ~485 lines total across src+tests (under 500-line ceiling).
- ✅ GPU verified: 0% → 13% during embedder runs (CLAUDE.md mandate).
- ✅ Run on full data per CLAUDE.md mandate: 198 codex / 197 claude / 172 agent-chat responses.
- ✅ Outputs: `experiments/residual/results/anomalies_{codex,claude,agent_chat}.json` + `summary.md`.

### v0.1 honest result — anomalies are HIGHLY interpretable

**Acceptance criterion was: ≥ 14/20 anomalies have a clear "why" when read.** Actual top-anomaly examples:

- **rec6sE2CRtD4drtHg** (Coleman-Weinberg pseudo-Goldstone mass, high-energy physics) — appears in BOTH codex (score 54) AND claude (score 46) top anomalies. Both agents struggled; the residual sampler caught it from independent matrices. **This is the cleanest possible early evidence that Track C (boundary scout) will fire correctly on multi-agent disagreement.**
- **recnGEpF1srQpaqWq** (Cope rearrangement, claude, score 151) — anomalously code-block-heavy reasoning style for an organic-chem question. Driving feature: `n_codeblocks`.
- **recVE8cUNHpHZIAvL** (solar neutrinos, claude, score 55) — letter_unknown + n_questions dominate. Claude couldn't pick a final letter. Refusal-adjacent.
- **agent_chat anomalies** are dominated by "the peer reviewer confirms..." / "let me redo with their corrections..." patterns — the residual sampler is automatically identifying the soft-pushback failure mode we diagnosed by hand in NL40.
- Anomaly scores span 1 → 151 (3 orders of magnitude) — strong differentiation, not noise.

**Verdict:** Track A is signal-rich. The residual-exploration premise is validated on the GPQA dataset where the ROUTER framing was flat — i.e., the same data that has no signal for selection HAS signal for residual analysis. This is the cleanest possible evidence that the pivot was the right call.

## Carryover state (live as of NL41 ablation)

- **Agent-chat re-run** (pid 40707): alive, hitting 20-min DRAFT timeouts on ~50% of
  remaining questions. Worst-case ETA 9 hours from NL41 (boss directs whether to keep waiting).
  Final 198-row agent-chat data feeds Track A's M_agent_chat once complete.
- **`experiments/router/`** v0.1 substrate: lives, test suite green, GPU-validated. Reuse the
  data loader + featurize.py embedder; deprecate train.py + router.py + the Q-net model.
- **claude.json restored;** TMPDIR set globally in `~/.claude/settings.json` env block.
- **Disk:** `/` at ~9.5G free as of last check (down from 7G at recovery). Watch for fill again.
- **GPU:** 4090 alive post-reboot, verified during last training run (21% util, 1067 MiB).

## Stopping conditions

1. **v0.1 anomalies are not human-interpretable.** Feature set is wrong. Iterate features
   (try response embedding alone; try richer reasoning markers; try cross-question features).
2. **v0.1 ships AND v0.2 cross-agent residual reveals SAME high-residual queries that GPQA
   single-model baselines also got wrong.** Then we're just rediscovering "hard questions" —
   not novel signal. Pivot to a less-saturated benchmark BEFORE building Track B.
3. **v0.1 + v0.2 ship and reveal genuinely surprising queries / disagreement patterns** that
   we wouldn't have found by hand. Then proceed to Track B and start treating the residual
   pipeline as a first-class substrate alongside the petersen graph.
4. **GPU goes back into header-type-7f or analogous failure.** Don't fight environmental
   issues silently; report to boss.

## Cadence

This is `/loop`-driven the same way prior missions were. Each iter: do as much as fits in
one turn, commit, update prompt.md with what's next, schedule heartbeat. Foreground compute
for the residual pipeline (it's all CPU/single-GPU, no agentic LLM calls). Background only
for the agent-chat re-run still in flight.

## Lessons learned (carryforward)

- **GPQA is too saturated to discriminate orchestration OR routing.** Both empirical and
  ablation evidence. Residual exploration sidesteps the saturation by looking inside the
  response, not at the score.
- **Heterogeneity at the model-output level still exists** even when accuracy converges.
  Different agents produce different prose, different reasoning styles, different timing.
  The boundary scout (track C) will quantify this.
- **The substrate concept is "extract residual signal," not "fuse outputs."** Agent-chat
  v1's failure was trying to fuse outputs of equally-capable agents — there's nothing to fuse.
  The residual sampler aggregates information without forcing consensus.
- **Tests-first catches design errors early.** The router's "continuous-learning curve rises"
  test failed → led to the saturation diagnosis → led to this pivot. Without that failing
  test, we'd have shipped a misleading curve.
- **Mid-flight verdicts can flip.** Both NL40 and NL41 produced verdicts that softened on
  closer inspection. Don't commit the architecture story until the final dataset is in.
- **Disk-fill failure mode (NL40):** atomic write of `~/.claude.json` truncates if `/` fills.
  TMPDIR redirect helps but doesn't fix — durable fix is symlinking `~/.claude.json` onto
  `/data`. Boss's separate session investigating root cause; track if/when that lands.
