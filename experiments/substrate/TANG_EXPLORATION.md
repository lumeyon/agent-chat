# Tang-Residual Exploration Policy for RL Rollouts — Design Doc

> Companion to `prompt.md`. Explains exactly how Tang's ℓ²-norm-sampling-from-low-rank-residuals fits as an exploration policy inside the RL training loop (component 6 of the substrate).
>
> **Scope:** principled diversity in candidate generation during PPO/GRPO rollouts on a small open-source model trained on the 4090. NOT inference-time generation policy for production answering — that's a separate use of Tang.

## 1. Why exploration matters at all in RL training

PPO/GRPO works by:
1. Sample N candidate continuations from the current policy π_θ
2. Score each with a reward model / verifier
3. Compute advantage (reward − baseline)
4. Update θ to increase log-prob of high-advantage candidates

If the N candidates are too similar to each other, the policy learns nothing — every advantage is near-zero because every candidate is equivalent. **Effective RL training requires the rollout candidates to span meaningfully different actions.**

Standard exploration:
- **Temperature** (T > 1.0) flattens the distribution. Cheap, but adds undirected noise — most "diverse" candidates are just garbled versions of the typical.
- **Top-p / nucleus** filters then samples. Better than temperature but still per-token, doesn't see global structure.
- **Diverse beam search** maintains diversity across beams. Better but expensive and biased toward beam-search artifacts.

**None of these has a principled notion of "outside the typical training-distribution subspace."** Tang gives you exactly that, and the 4090 has the compute headroom to use it during rollouts.

## 2. Where Tang fits — four levels, choose level 2

| level | what Tang does | feasibility |
|---|---|---|
| 1. Token-level | Project token logits onto residual subspace per step | Expensive (SVD per token), prior NL42 work showed the math works. Practical only on small models. |
| **2. Candidate-pool** | **Generate N>>K candidates, Tang-sample the K most-diverse** | **Sweet spot for RL rollouts. Cheap SVD (32×400 matrix), one per query.** |
| 3. Trajectory-level | Across training, identify under-explored state regions | Off-policy / curriculum learning. Worth exploring later. |
| 4. Policy-mixture | Mix multiple policies/temperatures, Tang-sample which to use | Marginal value over level 2; defer. |

**v0.1 implements level 2.** It's the cleanest fit for TRL's GRPO loop (just a custom rollout function), has well-defined math, and provides clear reward-attribution (the K selected candidates each get a verifier score and contribute to the policy gradient).

## 3. The algorithm in detail

```python
def tang_rollout(model, query, *, K=8, N=32, k_lowrank=4,
                 embedder, feature_extractor, seed=0):
    """Generate N candidates with high temperature, then Tang-sample K
    most-diverse via residual ℓ²-norm.

    Returns K candidate responses + their feature vectors (for reward
    attribution and logging)."""

    # Step 1: oversample N candidates from the policy at exploration temperature
    candidates = []
    for i in range(N):
        c = model.generate(
            query, do_sample=True, temperature=1.0, top_p=0.95,
            max_new_tokens=512, seed=seed + i,
        )
        candidates.append(c)

    # Step 2: featurize each candidate
    response_embs = embedder.encode([c.response for c in candidates])    # (N, 384)
    scalar_feats  = feature_extractor(candidates)                          # (N, d_scalar)
    M = torch.cat([response_embs, scalar_feats], dim=1)                    # (N, 384 + d_scalar)

    # Z-score the scalar columns so they're not swamped by unit-norm embedding
    sc_start = 384
    M_sc = M[:, sc_start:]
    mu, sd = M_sc.mean(0, keepdim=True), M_sc.std(0, keepdim=True).clamp(min=1e-6)
    M[:, sc_start:] = (M_sc - mu) / sd

    # Step 3: Tang ℓ²-norm sample K rows from residual after top-k SVD
    from experiments.residual.src.kernel import residual_sample
    indices, residual_rows, probs = residual_sample(M, k=k_lowrank, n_samples=K, seed=seed)

    selected = [candidates[i] for i in indices.tolist()]
    return {
        "selected": selected,
        "selected_indices": indices.tolist(),
        "all_candidates": candidates,
        "all_features": M,
        "residual_norms_sq": (residual_rows ** 2).sum(dim=1).tolist(),
        "sample_probs": probs.tolist(),
    }
```

## 4. Feature design — gets it or breaks it

The SVD's "typical subspace" is only as meaningful as the features. Garbage in, garbage out.

**Recommended feature vector (d ≈ 400):**

| feature | dim | notes |
|---|---|---|
| Response embedding (BGE-small-en-v1.5) | 384 | unit-norm, captures semantic content |
| Token count | 1 | reasoning depth proxy |
| Mean per-token entropy (from policy logits) | 1 | how uncertain the policy was |
| Top-1 token probability (geo. mean) | 1 | confidence |
| Number of distinct words / unigrams | 1 | lexical diversity |
| Self-correction count (regex on "wait/actually/...") | 1 | reasoning-reversal marker |
| Number of code blocks / latex blocks | 2 | format markers |
| Final-answer extracted (one-hot if MCQ) | 4-5 | task-specific |
| Reward-model preview (if available, optional) | 1 | bias toward known-good directions |

**Z-score the scalar columns; leave embedding unit-norm.** Total ~395-400 dim.

For TASK-SPECIFIC variants:
- **Code generation**: add cyclomatic complexity, function count, type annotations bool
- **Math**: number of equations, presence of `\frac{}{}`, integral/sum count
- **Long-form**: paragraph count, mean sentence length, citation count

The features encode domain knowledge about what "typical training-distribution behavior" looks like. Bad features → meaningless residual → no exploration benefit over temperature.

## 5. Five caveats and their mitigations

### 5.1 Cost: N=32 vs K=8 is 4× more rollout compute

Each step generates 32 candidates instead of 8. Mitigations:
- **vLLM batched generation**: one prefill, parallel decoding. ~3-4× speedup, mostly absorbs the cost.
- **Reduce N adaptively**: if Tang-selected candidates and reward-greedy candidates substantially overlap, lower N. If they don't, keep N high.
- **Cache prefill across rollouts of the same query**: vLLM does this natively.

Realistic 4090 budget: Qwen-7B with N=32, K=8, batch 4 queries: ~30-60 sec/step. ~1k steps in a 8-12 hour training session.

### 5.2 Diversity-reward trade-off

Tang-residual candidates are "diverse" but might be lower-reward than greedy candidates. If diversity strongly anti-correlates with reward, you waste rollouts on garbage. Mitigations:
- **Hybrid pool**: take K/2 from Tang-residual, K/2 from reward-greedy or top-p. Best of both.
- **Annealed exploration**: high Tang weight early in training, decay over time as the policy concentrates.
- **Verifier-aware Tang**: include reward-model preview as a feature, so SVD captures the "high-reward" direction explicitly.

### 5.3 SVD stability with small N and outliers

NL42 lesson: with one extreme outlier in N=20 rows, top-1 SVD captures the outlier itself, leaving its residual ≈ 0. Mitigations:
- **N ≥ 24**: enough to keep outliers from dominating singular components.
- **Robust low-rank** (optional v0.2): use truncated SVD with regularization, or randomized SVD.
- **Multi-k sampling**: union the top-K from k_lowrank ∈ {2, 4, 8}; covers different definitions of "typical."

### 5.4 Feature drift during training

As the policy θ changes, the meaning of "typical training-distribution behavior" drifts. Cached SVDs go stale. Mitigations:
- **Per-step SVD** (current plan): always compute fresh from the N candidates at this step. Cheap, drift-free.
- **NOT recommended**: a global "typical subspace" across training. That's the wrong unit of analysis.

### 5.5 Comparison vs cheaper baselines

If a temperature-1.5 sweep gets equivalent training curves at lower cost, Tang isn't earning its keep. Mitigations:
- **Mandatory A/B in v0.1** (see §7).
- **Honest readout**: if Tang doesn't beat temperature at ≤2× compute, downgrade or remove from the substrate.

## 6. Implementation layout

Reuses primitives from prior NL42 work; new code is mostly the rollout function and TRL integration.

```
experiments/substrate/src/
  exploration/
    __init__.py
    tang_sampler.py            # imports residual_sample from experiments/residual/src/kernel.py
    candidate_pool.py          # tang_rollout() defined above
    feature_extractor.py       # task-specific feature extractors
    test_tang_sampler.py       # synthetic-data tests (planted-outlier recovery)
    test_candidate_pool.py     # smoke test on a real model
  rl/
    grpo_train.py              # main training loop; calls candidate_pool.tang_rollout()
    rollout_strategies.py      # registry: 'temperature', 'top_p', 'tang_residual'
                               # each is a (model, query) -> [candidates] function
```

## 7. v0.1 build plan + acceptance criteria

### Step 1 — TESTS-FIRST

Write failing tests:
- `test_tang_sampler.py::test_planted_outliers_recovered`: synthetic 50-row matrix with 5 planted outliers in orthogonal direction; tang_sample(k=2, K=5) recovers ≥4 of 5 (same test as NL42).
- `test_candidate_pool.py::test_returns_K_candidates_with_features`: smoke test on real model.
- `test_candidate_pool.py::test_diversity_higher_than_temperature`: on a fixed query, mean pairwise embedding distance among Tang-selected K is higher than temperature-sampled K.

### Step 2 — wire kernel + features

Reuse `experiments/residual/src/kernel.py::residual_sample` directly. Reuse `experiments/residual/src/response_features.py` as a starting feature extractor; add policy-side features (token entropy, top-1 prob).

### Step 3 — implement `tang_rollout`

Per the algorithm in §3. Smoke test on Qwen-2.5-1.5B-Instruct loaded via vLLM. GPU verified (`nvidia-smi` >0% during generation).

### Step 4 — integrate into TRL GRPO

TRL exposes a `rollout_fn` hook (in newer versions) or you wrap the generation step. Replace the default sampler with `tang_rollout`. Verify log_probs are correctly computed for the K selected candidates.

### Step 5 — A/B validation experiment (THE acceptance gate)

Two training runs, identical except for rollout strategy:
- **Run A**: temperature-1.0 + top-p 0.95 (cheap baseline)
- **Run B**: Tang-residual N=32, K=8, k_lowrank=4

Same:
- base model (Qwen-2.5-1.5B-Instruct)
- training set (MATH or MMLU-STEM)
- verifier (closed-form match or symbolic)
- learning rate, batch, optimizer
- total compute budget (wall-clock)

Eval: held-out GPQA Diamond accuracy at every 250 steps.

**Acceptance:**
- Run B shows ≥3% higher held-out accuracy than Run A at convergence
- OR Run B converges in ≤ 70% of Run A's steps to the same accuracy
- 95% bootstrap CI on the delta excludes 0

If neither: Tang doesn't earn its keep on this benchmark+model combo. Demote to optional, document the negative result honestly. (Same NL59 discipline.)

### Step 6 — bake in if green, deprecate if red

If acceptance: keep Tang as the default exploration policy in the substrate. Open issue: scale to Qwen-7B QLoRA.

If not: keep `tang_sampler.py` for diagnostic purposes (it's still a useful primitive), remove from the production rollout path, document the negative finding in REPORT.md.

## 8. Open research questions (defer to v0.2+)

These are interesting but not v0.1:

1. **Is the right `k_lowrank` task-dependent?** Probably yes — code tasks may have lower intrinsic dimensionality than open-ended QA. Sweep.
2. **Hybrid Tang + reward-greedy**: optimal mix ratio?
3. **Curriculum exploration**: high Tang weight early, low Tang weight late. How fast to anneal?
4. **Multi-objective Tang**: residual sample with respect to two different feature sets (semantic + reward) and union the picks. Unclear if better than concatenated features.
5. **Off-policy Tang**: maintain a global memory of past candidates; on new query, augment current N with top-K most-similar past candidates before computing SVD. Combines exploration with retrieval.
6. **Token-level Tang during RL** (level 1): more expensive but might give finer-grained credit assignment. Probably needs custom autograd.

## 9. Tests-first checklist (CLAUDE.md mandate)

Before writing any production code in `exploration/`:

- [ ] `test_tang_sampler.py::test_planted_outliers_recovered` — synthetic 50×30 matrix, 5 planted, top-1 SVD subtracted, recovers ≥4 of 5
- [ ] `test_tang_sampler.py::test_residual_norm_decreases_after_subtract` — sanity check on residual property
- [ ] `test_candidate_pool.py::test_returns_K_candidates` — smoke test, requires AGENT_CHAT_RUN_LLM_TESTS=1 env to actually load model
- [ ] `test_candidate_pool.py::test_diversity_higher_than_temperature` — pairwise embedding distance metric
- [ ] `test_grpo_integration.py::test_one_step_completes` — single GRPO step with Tang rollout doesn't crash, log_probs are finite

All five must pass before claiming the v0.1 exploration policy is ready.

## 10. Inviolable rules carryforward

1. **TESTS-FIRST when fixing bugs.** Strict per CLAUDE.md.
2. **Train on FULL datasets** during the A/B comparison.
3. **GPU verification** during every rollout — `nvidia-smi` ≥ 10% util when generating.
4. **Bootstrap CI on the A/B delta** before claiming Tang helps. NL59 lesson.
5. **TMPDIR=/data/tmp**, **HF_HOME=/data/cache/huggingface**.
6. **Don't over-engineer**: v0.1 is one feature extractor, one rollout function, one A/B. Save level-3/4 for v0.2.
7. **Negative results count**: if Tang doesn't beat temperature, document and demote, don't keep arguing for it.

## 11. Why this is a worthwhile use of Tang specifically

- **Genuine quantum-classical bridge**: Tang's whole contribution is "classical algorithm matches quantum performance via ℓ²-norm sampling on low-rank residuals." Using it as an RL exploration policy is a faithful application of that primitive, not a forced fit.
- **Cheap relative to other diversity methods**: per-step SVD on a 32×400 matrix is microseconds on the 4090. Negligible compared to LLM rollout cost.
- **Composable with the rest of the substrate**: the same kernel powers Track A (anomaly detection on responses) and Track C (multi-agent disagreement); now the same primitive powers RL exploration. One algorithmic primitive, three uses, all aligned with the strategic story.
- **Falsifiable**: §7's A/B is a clean test. If Tang doesn't help at the rollout level, we know quickly and move on.

The Tang work isn't decorative here. It's an actual exploration policy with measurable effect on training curves, validated against a cheap baseline.
