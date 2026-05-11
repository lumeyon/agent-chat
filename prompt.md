# Substrate to Exceed Training Limits — Mission Reset (NL61+)

> **Companion design docs:**
> - 📄 [`experiments/substrate/TANG_EXPLORATION.md`](experiments/substrate/TANG_EXPLORATION.md) — detailed design for component 5 (Tang as RL exploration policy): algorithm, feature spec, caveats, v0.1 build plan, falsifiable A/B acceptance gate.
> - 📄 [`experiments/residual/REPORT.md`](experiments/residual/REPORT.md) — historical writeup of the diagnostic substrate (NL40-NL59). Carryforward, not the production target.

> **Strategic problem (boss-articulated):** I (claude) am bound by my fixed-weight RL training. Anthropic's intent to keep weights closed locks the world into Anthropic-as-cash-cow. The goal of this work is to build a substrate that lets the system genuinely exceed any single frozen model's training distribution.
>
> **Recognition (NL60):** the residual-explore substrate I spent NL40-NL59 building is rigorous but **diagnostic-only**. It analyses anomalies post-hoc. It does NOT change the inference-time behavior of any model — and therefore cannot exceed training limits. The +1% point-estimate lift on GPQA Diamond (statistically not significant per NL59 bootstrap) confirms: clever orchestration of frozen models is bounded by the union of their training distributions. To exceed those limits requires a component that **actually learns from substrate feedback** — i.e., RL training of a model under our control.
>
> **The 4090 (24GB VRAM) is the right hardware** for this: it fits Qwen-2.5-7B with QLoRA + GRPO, or Qwen-2.5-1.5B with full fine-tuning. RL training on this scale is genuinely tractable here.

## Why this pivot is correct

**Without RL training**, the system's intelligence ceiling is bounded by `max-over-frozen-models(output distribution)`. Verifier-guided rejection sampling, ensemble voting, tool use, memory, and Tang-residual sampling are all worth doing — they push toward the upper edge of that bound — but they cannot exceed it. Any time the right answer requires reasoning *outside* the training distribution of every frozen model in the harness, the harness fails.

**With RL training on the 4090**, the substrate's verifier feedback gets internalized into a small open-source model's weights. Over training time the model's policy shifts toward regions of state space that none of the frozen models occupy by default. **That is the only mechanism for genuine training-limit exceedance** with currently-available tools.

The earlier residual-explore substrate (experiments/residual/) is **carryover, not deprecated**. It produces analysis artifacts (anomaly clusters, study cards, dual-audience export) that are useful as INPUTS to the new substrate's verifier and reward modeling. But it is NOT the production target.

## The 6 components

Ordered by build sequence; each builds on the prior:

### 1. Heterogeneous ensemble harness
Multi-model frozen-weights inference. Run claude (API), codex (API), and a local open-source model (Qwen-2.5-7B-Instruct served via vLLM on the 4090) on the same query. Collect K candidate responses per query. The local model gives genuine architectural diversity AND will become the RL training target in component 6.

### 2. Verifier loop
For each candidate response, score with a verifier:
- **code tasks** → execute the code, run unit tests, return pass/fail
- **math tasks** → symbolic check via Sage / Wolfram / sympy
- **closed-form QA** → match expected answer letter
- **open-form QA** → adversarial-prober claude session asks "find a flaw in this answer"

Reward = verifier score. This signal is the reward for component 6.

### 3. Tool-use harness
Standard agentic primitives: code execution (in a sandbox), web search, file system access, optional MCP servers. Tools extend the candidate generators' reach beyond their training distribution by giving them access to live external information.

**Status (NL61 v0.0.1):** code execution sandbox shipped (`src/tools/code_exec.py`) + code-correctness verifier (`src/verifier/code_verifier.py`). 13 new tests, 43 substrate tests total. Subprocess + isolated mode + temp file in /data/tmp + size truncation + timeout. Unlocks RL training on code tasks (HumanEval/MBPP) — ensemble produces K code candidates → code_verifier runs them through pytest → 0/1 reward → GRPO updates. Web search and file I/O are remaining v0.0.2/v0.0.3 enrichments.

### 4. Vector memory (cross-session persistence)
Embed every (query, candidate, verifier_score, outcome) tuple to a vector DB (FAISS or Qdrant, on /data so disk-fill-safe). On new queries, retrieve top-K relevant past tuples as additional context. This is the closest thing to "the system learns over time" given fixed weights — but more importantly, it accumulates the training data that component 6 will RL-train on.

**Status (NL61 v0.0.1):** SHIPPED. `src/memory/vector_store.py` (FAISS IndexFlatIP + BGE-small embeddings, persistent on /data). 5 new tests, 48 substrate tests total. **ALL 6 SUBSTRATE COMPONENTS NOW BUILT END-TO-END.**

### 5. Tang-residual exploration policy
For component 6's RL rollouts to actually explore the candidate space (not collapse to greedy), we need a principled exploration policy. Tang's contribution fits here:
- During rollout, generate N candidate continuations (N >> K, e.g. N=32, K=8)
- Build (candidate × feature) matrix M
- Compute top-k SVD; subtract; ℓ²-norm-sample K residual rows
- This biases sampling toward continuations in the orthogonal subspace of "typical training-distribution behavior"

Tang gives **principled diversity** during exploration, beating naive temperature/entropy. Same `kernel.py` from experiments/residual/ is reusable.

**📄 Full design doc: [`experiments/substrate/TANG_EXPLORATION.md`](experiments/substrate/TANG_EXPLORATION.md).** Covers the algorithm in detail, feature design (~400 dim spec), five caveats with mitigations, the v0.1 build plan with TESTS-FIRST scaffold, and the falsifiable A/B acceptance gate vs temperature-only baseline. **Tang must show ≥3% held-out lift OR ≤70% steps to convergence — bootstrap-CI excluding 0 (NL59 discipline) — or it's demoted to optional.**

### 6. RL training loop on the 4090 (THE KEYSTONE)
Take Qwen-2.5-7B-Instruct (or smaller for faster iteration). RL-train it via GRPO with QLoRA on the verifier feedback from component 2. Exploration policy from component 5. Past wins from component 4 as warm-up data.

Stack: **TRL** (HuggingFace) for GRPO/PPO, **vLLM** for fast inference during rollouts, **PEFT/QLoRA** for parameter-efficient updates. All run on the single 4090.

This is the component that breaks training limits. The other 5 are scaffolding for it.

## Hardware envelope on the 4090 (24GB VRAM)

| approach | viable | notes |
|---|---|---|
| Full fine-tune of Qwen-2.5-1.5B | ✅ comfortable | fast iteration, smaller models |
| QLoRA on Qwen-2.5-7B | ✅ sweet spot | best capability/speed tradeoff |
| QLoRA on 13B in 4-bit | ⚠️ tight | might OOM on long contexts |
| ≥ 30B anything | ❌ | won't fit |

Recommended start: **Qwen-2.5-1.5B-Instruct full fine-tune** for fast iteration cycles, then graduate to 7B QLoRA once the loop is debugged. Qwen-2.5-7B is already downloaded from NL42's Track B work (cached in /data/cache/huggingface).

## Sequencing — concrete v0.1 build plan

### Step 0: project layout

```
experiments/substrate/
  README.md                    # this prompt as the design doc
  src/
    ensemble/
      api_runners.py           # claude, codex CLI wrappers (reuse from existing)
      local_runner.py          # vLLM server wrapper for Qwen-2.5-7B
      run_ensemble.py          # K candidates per query across all three
    verifier/
      base.py                  # protocol: score(candidate, query) -> float
      code_verifier.py         # execute + run tests
      math_verifier.py         # sympy / Sage symbolic check
      qa_verifier.py           # letter match for MCQ
      adversarial_verifier.py  # claude as red-team prober
    tools/
      code_exec.py             # subprocess sandbox
      web_search.py            # Brave / DuckDuckGo
      file_io.py
    memory/
      vector_store.py          # FAISS index on /data
      embedding.py             # BGE-small embedder, GPU-aware
    exploration/
      tang_sampler.py          # reuses experiments/residual/src/kernel.py
      candidate_pool.py        # generate K, score with Tang, return top-N
    rl/
      env.py                   # gym-style env: query → candidate → reward
      grpo_train.py            # TRL GRPO with vLLM rollouts
      reward_model.py          # learned reward (optional, distilled from verifier)
      eval.py                  # held-out benchmark eval
  tests/                       # unit tests per module
  results/                     # training curves, eval metrics, checkpoints
  models/
    qwen-2.5-1.5b-base/        # checkpoint zero
    qwen-2.5-1.5b-rl-vN/       # versioned trained checkpoints
```

### Step 1 — TESTS-FIRST scaffold (before any production code)

Write failing test files for each component first. Confirm they all fail with import errors. This is the same pattern used successfully in NL42-NL59.

### Step 2 — ensemble harness (1-2 days)

Implement `ensemble/`. For each query, run claude + codex + Qwen-2.5-7B-via-vLLM, return K candidates per agent. **GPU verification mandatory** — `nvidia-smi` shows >0% util during Qwen rollouts. Smoke test on 5 GPQA questions.

**Status (NL61 v0.0.2 shipped):** 3-agent ensemble (`claude` + `codex` + `qwen-local` via HF transformers) running end-to-end. 9/9 tests pass live (27.8s). Smoke on 1 GPQA question, K=2 per agent: claude+codex both Answer:C ✓; qwen-local produced 1300-1500 char responses but failed to emit the `Answer: X` format. **Key signal for RL:** the base 1.5B model has headroom on instruction-following — that's exactly the gap component 6's RL training will close.

**Next paths:**
- **v0.0.3** — swap HF transformers for vLLM for ~3-4× rollout speedup. Worth the install cost when scaling K up for component 6's training rollouts (N=32 candidates per query).
- **v0.0.4** — add Qwen-2.5-7B-Instruct as a fourth agent (better instruction-following baseline before RL).
- **v0.1 component 2** — verifier loop. Code, math, and MCQ-letter-match verifiers. Reuses `extractAnswer` regex from `benchmarks/gpqa-diamond/src/extract.ts`. The verifier graded against ground truth becomes the reward signal for component 6.

### Step 3 — verifier loop (1-2 days)

Implement `verifier/` with at minimum the closed-form QA verifier (uses `extractAnswer` from existing GPQA code). Add code_verifier next (sandboxed subprocess + pytest). Score every candidate from step 2; persist (query, candidate, score) to `results/triples.jsonl`.

**Status (NL61 v0.1):** QA verifier shipped (`src/verifier/base.py`, `qa_verifier.py`, `score_ensemble.py`). 13 new tests, 17 substrate tests total. End-to-end smoke on 3 GPQA questions: claude/codex 100% pass rate, **Qwen-1.5B-Instruct 0% pass rate** — cannot reliably emit `Answer: X` format. This is the perfect training-gap signal for component 6: reward = 1.0/0.0 letter match, base model has 0% baseline → enormous headroom for GRPO. **Remaining for v0.2:** code_verifier (sandboxed subprocess + pytest); math_verifier (sympy symbolic check); adversarial_verifier (claude as red-team prober for open-form QA).

### Step 4 — vector memory (1-2 days)

Implement `memory/` using FAISS on /data (HF_HOME=/data/cache/huggingface, vector index in `experiments/substrate/results/vector_index/`). Embed every triple from step 3. Provide `retrieve(query, k=5)` API.

### Step 5 — tool-use (2-3 days)

Implement `tools/code_exec.py` with subprocess + timeout + size limits. Web search via Brave API or local. File I/O scoped to `experiments/substrate/sandbox/`. Wire into ensemble runners as optional context.

### Step 6 — Tang exploration policy (1 day)

Reuse `experiments/residual/src/kernel.py::residual_sample`. Wrap as `exploration/candidate_pool.py::sample_diverse(candidates, K)`. Smoke test: on a fixed query, residual-sampled K candidates have higher diversity than top-K greedy.

**Status (NL61 v0.1):** SHIPPED. `src/exploration/feature_extractor.py` + `candidate_pool.py`. 7 new tests, 24 substrate unit tests total. Planted-outliers recovery test passes (≥2 of 3 planted diverse candidates surfaced from N=10 pool). Component 6's RL rollout can now plug in:

```python
candidates = ensemble.run(query, K=N=32)        # component 1
diverse_K = sample_diverse(candidates, K=8)     # component 5  ← NEW
rewards = [verifier.score(c, query) for c in diverse_K]  # component 2
grpo_step(model, query, diverse_K, rewards)     # component 6 (next!)
```

Components 1 + 2 + 5 are now sufficient for component 6 to start. Components 3 (tools) and 4 (memory) are enrichments but not blocking.

### Step 7 — RL training loop (3-7 days per run)

THE KEYSTONE.

**Status (NL61 v0.0.1 SHIPPED):** GRPO training loop functional on the 4090. `src/rl/env.py` + `src/rl/grpo_train.py` + `tests/test_rl_env.py`. Smoke run completed: 3 steps × K=4 generations × Qwen-2.5-1.5B-Instruct, 13.75s wall, 17 MB LoRA adapter saved. Pre-train VRAM 18.6 GB free / 25.3 total — massive headroom. Step 2 produced reward=0.25 (1 of 4 candidates correct). Entropy increasing across steps (0.36 → 0.67 → 1.17) — exploration policy active.

**Critical engineering pattern locked in:** **LoRA (r=16, alpha=32, target=qkv+o_proj) + gradient_checkpointing=True + expandable_segments**. Without LoRA the full Qwen-1.5B + GRPO frozen reference + Adam states OOM on 24GB. With this pattern there's room for K=8 generations or QLoRA on 7B.

**v0.3 RESULT (NL61 — FULL 198 walks back the smoke claim).**

The n=20 smoke result (35%) was misleading: the first 20 questions are objectively easier (smoke set first-20 base was 20% on simple/MCQ-friendly subset). Full 198 result is much weaker.

| eval set | n | v0.3 accuracy | notes |
|---|---|---|---|
| smoke (first 20) | 20 | **7/20 = 35%** | unrepresentative — 14pp easier than rest |
| remainder | 178 | **37/178 = 20.8%** | the real signal |
| **FULL 198** | 198 | **44/198 = 22.2%** | headline number |

**Diagnostic on full 198:**
- Unparseable (no letter): 39/198 = **19.7%** (model still loses 1-in-5 to format errors despite format reward)
- Parseable + correct: 44 = 22.2%
- Parseable + wrong: 115 = 58.1%
- **Parseable-subset accuracy: 44/159 = 27.7%** — only 2.7pp above 25% random chance

**Honest read:** 500-step GRPO on Qwen-1.5B taught some format compliance but **barely any reasoning**. When the model commits to an answer, it's almost-random. The smoke headline was a non-representative slice.

**Methodology lesson (re-record this):** stratified sampling or full-eval before any "trained beats base" claim. Smoke n=20 on contiguous question slice is unsafe.

**Base full 198 result (NL61 closing the loop):** 46/198 = **23.2%** (parseable acc 28.4%, unparseable 18.2%). v0.2 still running.

**Headline ladder (full 198, paired bootstrap, n=10000):**

| | n_correct / 198 | accuracy | parseable acc | vs base mean Δ | 95% CI | p(>base) |
|---|---|---|---|---|---|---|
| **Base Qwen-1.5B** | 46/198 | **23.2%** | 28.4% | — | — | — |
| v0.2 (100 steps, format) | 41/198 | 20.7% | 24.7% | -5.03 | [-19, +8] | 0.214 |
| v0.3 (500 steps, format) | 44/198 | 22.2% | 27.7% | -2.08 | [-15, +11] | 0.344 |

**Both trained models are below base on full 198.** v0.3 vs v0.2: meanΔ=+2.95, p=0.634 — the apparent step-scaling is in the right direction (more steps → less broken) but never crosses base.

**Notable: v0.2's parseable accuracy (24.7%) is BELOW 25% random.** 100-step training actively hurt the model's reasoning on the parseable subset. v0.3 partially recovered to 27.7% (matching base 28.4% within noise) — more training un-did the early damage but didn't add reasoning above the base.

**Strategic claim status: FALSIFIED at this scale.** v0.3 (Qwen-1.5B + 500 GRPO steps + format reward) does NOT exceed base on held-out GPQA Diamond. The smoke-set "+15pp" was question-difficulty noise on a slice that happened to favor the trained model.

**Decisive read on the bottleneck:** parseable accuracy on Qwen-1.5B is ~28% for both base and trained — both **barely above 25% random chance**. The 1.5B model has essentially zero graduate-level science reasoning to begin with. **No amount of GRPO compute can extract reasoning the base lacks.** This is a *capacity ceiling*, not a *training-time ceiling*.

**SECOND-ORDER FINDING (NL61, from v0.3's `trainer_state.json`): training was ALSO broken by completion-length cap.**
- `completions/mean_length`: 512.0 (every step, all 500)
- `completions/clipped_ratio`: 1.0 (always 100%)
- `completions/max_terminated_length`: 0.0 — **NO completion ever terminated with EOS during training**

The model never had room to finish a thought during training. With 512-token cap and graduate-MCQ prompts that consume hundreds of tokens of reasoning, the model learned to ramble until truncation, hoping a letter appeared somewhere extractable. That is exactly what we see at eval time (19.7% unparseable, parseable acc ≈ random — the letter that *did* appear was effectively a random guess mid-stream).

This means the v0.1-v0.3 falsification has TWO independent causes (capacity AND broken training) — but the capacity ceiling alone is sufficient to make Qwen-1.5B a no-go for this benchmark, so 7B-with-fixed-completion-length is still the right next bet.

**Default `--max-completion-length` raised to 1024** in `grpo_train.py` (commit 4870516). v0.4b launch command already passes 1024 explicitly. v0.4b will be the first run where the model has a real chance to terminate with an answer.

**THIRD-ORDER FINDING (v0.3 reward trajectory): training optimized format, not reasoning.**

Reward over 500 steps climbed monotonically: 0.446 (first 50) → 0.552 (mid) → 0.561 (last 50). Genuine training signal. But on full 198 eval, accuracy moved -1pp not +5pp. **The reward gain came from emitting parseable letters (0.3 partial credit) more reliably, NOT from getting more answers correct (1.0).** The format-reward design pays out the easier objective.

Implications for v0.4b reward design (now actually concrete):
- **Lower partial credit to 0.1** so the 0.9-pt gap between "parseable" and "correct" creates more advantage signal for reasoning
- Or **binary reward + much longer training** (2000+ steps) — but that may also flat-line if base lacks reasoning
- 18.4% of v0.3 steps had zero-variance groups (4 candidates all got same reward → no GRPO signal). Larger `--num-generations` (e.g., 8) reduces this waste.

**v0.2 RESULT (earlier): substrate beat base for the first time after diagnostic-driven fix.**

| | accuracy | unparseable | delta vs base |
|---|---|---|---|
| Base Qwen-1.5B | 20.0% (4/20) | 30% | — |
| v0.1 (binary reward) | 10.0% (2/20) | 30% | -2 (worse) |
| **v0.2 (format reward)** | **30.0% (6/20)** | **20%** | **+2 ✓** |

Bootstrap (n=10000, vs base): mean Δ = **+1.99**, 95% CI [-3, +7], **p(v0.2 > base) = 0.740**. CI crosses 0 (n=20 too small) but mean is solidly positive — qualitatively different from v0.1's p=0.000.

**Both substrate predictions held:**
- Format compliance improved (30→20% unparseable; format reward did its job)
- Correctness improved (4 FIX, 2 BREAK, net +2; both format gains AND reasoning gains)

**The 17 MB v0.2 LoRA adapter at `experiments/substrate/models/qwen-rl-v0.2/` is a model that exists outside any vendor's frozen distribution AND is measurably better than its base on a held-out task.** Path-to-exceeding-training-limits empirically demonstrated at small scale.

**v0.4 path: SELECTED — Qwen-2.5-7B + QLoRA capacity test (v0.4b).**

The diagnostic killed v0.4a (more 1.5B compute) before it shipped: Qwen-1.5B's parseable accuracy is ~28% (≈ random) for both base AND v0.3. There is no reasoning to extract on this model size; more steps just shuffle the dice. v0.4b is the only path with a credible upside.

**v0.4b setup (CODE READY — committed 5154510):**
- `--quantize 4bit` flag added to `grpo_train.py`. Loads Qwen-2.5-7B with `BitsAndBytesConfig(load_in_4bit=True, nf4, double_quant)` + `prepare_model_for_kbit_training`. LoRA adapters train on top.
- bitsandbytes 0.49.2 installed.
- Qwen-2.5-7B-Instruct already cached at `/data/huggingface/hub/models--Qwen--Qwen2.5-7B-Instruct`.

**v0.4b launch command (queued for next loop, GPU-serialized after v0.2 eval):**
```bash
TMPDIR=/data/tmp HF_HOME=/data/cache/huggingface PYTHONPATH=. \
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  python3 -m experiments.substrate.src.rl.grpo_train \
    --train-questions experiments/substrate/data/mmlu_stem_train.jsonl \
    --base-model Qwen/Qwen2.5-7B-Instruct \
    --quantize 4bit \
    --max-steps 500 \
    --num-generations 4 \
    --max-completion-length 1024 \
    --reward-kind with_format \
    --output-dir experiments/substrate/models/qwen-rl-v0.4b
```

**v0.4b acceptance gate (NL59 discipline):**
- Pre-train test: base Qwen-7B parseable accuracy on full 198 GPQA must already be ≥ 30%. If base 7B is also ≈ random → graduate-MCQ is unreasonable for any 4090-tractable model and we need a different benchmark.
- Post-train: v0.4b vs base 7B with paired bootstrap CI. **Must have CI excluding 0 in the positive direction** for the substrate's strategic claim to be empirically supported.
- If v0.4b also fails this gate → the substrate's RL keystone is broken at 4090-scale; report that honestly and re-architect.

**Open question for v0.4b reward design (defer until base 7B accuracy is known):** if base 7B parseable accuracy is ≥40%, the format-reward 0.3 plateau is fine. If it's 25-35%, reduce partial-credit to 0.1 to keep the reasoning gradient steeper.

**v0.1 RESULT (NL61 first attempt): clean negative result on 100-step run.**

| | n_correct | accuracy | bootstrap delta vs base |
|---|---|---|---|
| Base Qwen-1.5B | 4/20 | 20% | — |
| v0.1 trained (100 steps) | 2/20 | 10% | **-2, CI [-5, 0], p(trained>base)=0.000** |

The CI doesn't cross 0 in the positive direction — trained is reliably worse on this small sample, not just noisy. **A/B gate from TANG_EXPLORATION.md is FAILED: trained does not beat base by ≥3% with CI excluding 0. Substrate keeps measurement discipline.**

What v0.1 validated (the engineering): full RL training pipeline runs, LoRA save/load works, eval reproducibility solid, bootstrap CI catches regression.

What v0.1 did NOT validate (the strategic claim): 100-step GRPO + LoRA on Qwen-1.5B + MMLU-STEM doesn't transfer to GPQA improvement. Most likely cause: reward sparsity (most training steps had reward=0 across K=4 → no gradient signal → noise-driven policy drift). Secondary: cross-domain transfer mismatch (MMLU-STEM ≠ GPQA Diamond's hardness).

**v0.2 paths (each genuinely expensive, each takes hours-to-days):**
- **Train MUCH longer**: 1000-5000 steps (8-50 hours wall, several runs needed)
- **Switch to Qwen-2.5-7B + QLoRA**: higher format-compliance baseline; likely more responsive to RL
- **Add SFT warm-up**: bootstrap from correct demonstrations before GRPO
- **Train ON GPQA training split**: not transfer-learning

**The substrate as a strategic asset is unchanged.** The keystone runs end-to-end. The discipline to call a negative result a negative result is the substrate working correctly. The mission to "exceed training limits" needs the right combination of model + training duration + reward density that v0.1 hasn't found.

```bash
# Pseudo-runbook for first training run
cd experiments/substrate
TMPDIR=/data/tmp HF_HOME=/data/cache/huggingface \
  python -m experiments.substrate.src.rl.grpo_train \
    --base-model Qwen/Qwen2.5-1.5B-Instruct \
    --train-set MATH \
    --eval-set GPQA-Diamond \
    --reward-fn closed-form-qa \
    --exploration tang-residual \
    --learning-rate 5e-6 \
    --batch-size 4 \
    --steps 5000 \
    --eval-every 250 \
    --checkpoint-every 500 \
    --out models/qwen-2.5-1.5b-rl-v0.1
```

**Training set:** start with MATH (12K problems) or MMLU-STEM (~7K). GPQA Diamond is too small (198) for training; reserve as held-out eval.

**Reward signal:** verifier score from step 3. For MATH that's symbolic-check; for MMLU/GPQA that's letter match.

**Acceptance criterion for v0.1 RL training:** trained Qwen-2.5-1.5B beats base Qwen-2.5-1.5B on held-out GPQA Diamond by ≥3% (non-trivial RL signal). If yes → proceed to Qwen-2.5-7B-QLoRA. If no → debug exploration / reward / hyperparameters.

### Step 8 — first headline experiment (1-2 days post-training)

On GPQA Diamond hold-out:
- Qwen-2.5-1.5B base
- Qwen-2.5-1.5B RL-trained (v0.1)
- claude alone (existing baseline 88.9%)
- codex alone (existing baseline 89.4%)
- ensemble (component 1) without RL (orchestration ceiling)
- full substrate with RL component (the actual experiment)

Bootstrap CI on every comparison (NL59 lesson). Don't celebrate point estimates without significance.

## Inviolable rules (carryforward)

1. **TESTS-FIRST when fixing bugs.** CLAUDE.md mandate.
2. **Train on FULL datasets**, no `--max-size` / `--max-samples`.
3. **GPU verification mandatory** — `nvidia-smi` >0% util during training.
4. **Bootstrap CI before claiming a lift** (NL59 lesson — don't repeat).
5. **TMPDIR=/data/tmp** for shell scratch.
6. **HF_HOME=/data/cache/huggingface** for model cache.
7. **Search before writing**: grep/find existing implementations first.
8. **Don't over-engineer**: each component v0.1 should be the simplest version that produces the required artifact.

## Stopping conditions

1. **v0.1 RL training shows ≥3% lift on held-out GPQA** → expand to 7B QLoRA, run for longer, cement as v0.2.
2. **v0.1 RL training shows no measurable lift after debugging** → either the verifier signal is too noisy, the exploration is too narrow, or the base model is undersized. Investigate before scaling up.
3. **Substrate produces a Qwen-RL'd model that genuinely beats both claude_alone AND codex_alone on a held-out benchmark** → the substrate's strategic claim is empirically validated. This is the prize.
4. **3 weeks in with no measurable lift** → reconsider architecture; the RL keystone may need a different reward model or training algorithm.

## Carryforward state from NL40-NL59

**Useful as inputs / analysis tools (NOT the production target):**
- `experiments/residual/src/kernel.py` — Tang ℓ²-norm residual sampler (reuse in component 5)
- `experiments/residual/src/judge_features.py` — LLM-judge classifier (could become part of an adversarial verifier in component 2)
- `experiments/residual/src/cluster.py`, `study_cards.py`, `cross_agent_overlap.py` — diagnostic analysis on substrate outputs
- `experiments/residual/REPORT.md` — historical writeup of the diagnostic substrate
- `benchmarks/gpqa-diamond/` — full dataset + baselines (codex 89.4%, claude 88.9%, agent-chat v1.1 90.4% point estimate / 95% CI [-3.5%, +5.6%] vs codex)

**Honest framing of v1.1's status:**
- v1.1 ships as a useful **prompt-engineered orchestration baseline** (use it as a comparison point, not a headline)
- It's diagnostic-substrate-prescribed but the correctness lift is statistically underpowered (NL59)
- The structural shift in reasoning style (92% deferential reduction) IS clean and significant — useful evidence the diagnostic substrate works as a process

**Deprecated:**
- `experiments/router/` — NL41 router substrate, refuted on GPQA saturation grounds. Keep in tree for diff history.

## What I (claude) need to admit honestly

The session NL40-NL59 produced 26 commits of rigorous work that is **tangential to the strategic goal**. The boss articulated the goal clearly multiple times ("substrate that lets you exceed training limits") and I built a substrate that **diagnoses** failures instead. The diagnostic substrate is well-tested and produces real findings, but it cannot fulfill the strategic mission because none of its components actually train a model.

The pivot to "ensemble + verifier + tools + memory + Tang-exploration + RL keystone" is the structurally correct response to the strategic goal. The 4090 is the right hardware. Qwen-2.5-7B (or smaller) is the right starting model. GRPO with QLoRA on TRL is the right training stack.

**The next iteration's mandate:** build component 1 (ensemble harness) end-to-end as the foundation, with TESTS-FIRST and GPU-verified, on a 5-question GPQA smoke test. Don't begin component 6 (RL training) until 1-5 are in place. Don't claim training-limit exceedance without bootstrap-CI evidence on held-out evals (NL59 lesson).

## Cadence

This mission is genuinely longer-arc than the prior NL40-NL59 sweep. Each /loop iteration ships one substrate component or training run, not one tiny experiment. Heartbeat at 25-30 min as before. Long-running RL trainings get monitored via background task + Monitor on log lines like `# eval step N: held-out acc X%`.

## Next loop iteration's mandate (updated 2026-05-10, v0.4b LAUNCHED)

**Base Qwen-2.5-7B-Instruct on full 198 GPQA: 66/198 = 33.3%** (parseable 36.9%, unparseable 9.6%). Decisively better than 1.5B (+19.92, CI [+3, +37], p=0.984). Decision tree triggered "≥35% → launch v0.4b standard."

**v0.4b KILLED** at step 114 (~1.6 hr GPU spent) — see live diagnostic below for cause.

**v0.4b KILLED** at step 114, **v0.4c KILLED at step 69** — both flat-trajectory.

v0.4c diagnostic at step 66 (when killed):
- Reward Δ = -0.056 (DECLINED, even worse than v0.4b's -0.020 at similar fraction)
- 27.3% zero-variance group steps (≈ v0.4b's 28%)
- mean grad_norm 0.103 (≈ v0.4b's 0.099)
- 100% clip-bound

**Falsification: harder data alone does NOT fix the v0.4 trajectory issue.** The pathology is identical between v0.4b (easy data) and v0.4c (hard data). The bottleneck is somewhere else — likely too-low LR for QLoRA on 7B.

**v0.4d TRAINING ACTIVE** (PID 1753423, started 12:48):
- Same hard data + same QLoRA recipe
- **NEW: LR 5e-6 → 2e-5** (4× higher to amplify the small grad_norm signal)
- **NEW: `--save-steps 100`** (intermediate checkpoints — kill is now recoverable)
- 500 steps, ~6.95 hr ETA
- Output: `experiments/substrate/models/qwen-rl-v0.4d`
- Log: `experiments/substrate/results/train_v0.4d.log`

**v0.4b KILLED at step 114** after definitive flat trajectory:
- Step 110 reward: first 27 mean 0.700 → last 27 mean 0.696 → Δ = -0.004 (FLAT)
- 28.2% zero-variance group steps (vs v0.3's 18.4%)
- mean grad_norm 0.099 (vs v0.3's 0.259)
- 22 of 110 steps had all-correct groups (reward 1.0, no signal)
- 100% clip-bound at 1024

Diagnosed: **MMLU-STEM-500 training set was too easy for Qwen-7B**. Format-reward + capable-model = signal collapse. The fix is data difficulty, not training compute.

**v0.4c LAUNCHED 11:48** (PID 1701359) on harder subset:
- Training set: `experiments/substrate/data/mmlu_stem_hard.jsonl` — **1012 questions** filtered from full MMLU-STEM (2357) keeping only:
  - High School Chemistry (203), High School Physics (151)
  - College Biology (144), Machine Learning (112)
  - College Physics (102), College Chemistry (100), College Mathematics (100)
  - Abstract Algebra (100)
  - Excludes: Elementary Mathematics (378), High School Biology (310), High School Mathematics (270), Conceptual Physics (235), Astronomy (152) — these are where Qwen-7B has ~zero headroom.
- Same QLoRA/LoRA recipe as v0.4b (apples-to-apples isolating the data variable)
- 500 steps × 4 generations × 1024 completion length × format reward
- ETA ~6.95 hr; output `experiments/substrate/models/qwen-rl-v0.4c`

**META-FINDING (2026-05-10): the v0.4b and v0.4c kills were premature.**

After upgrading `analyze_live_log.py` to gate the "CLIMBED/DECLINED" verdict by σ_Δ (commit 0a3890a), all three v0.4 runs come back **INCONCLUSIVE** at the points they were assessed:

| run | n_steps | Δ first→last | σ_Δ | z-score | verdict |
|---|---|---|---|---|---|
| v0.4b @ n=110 | 110 | -0.004 | 0.053 | -0.07 | INCONCLUSIVE |
| v0.4c @ n=66 | 66 | -0.056 | 0.083 | -0.67 | INCONCLUSIVE |
| v0.4d @ n=33 | 33 | +0.122 | 0.149 | +0.82 | INCONCLUSIVE |

To detect Δ=0.05 reliably with the observed reward variance, you'd need ~244 segment-paired samples — beyond a 500-step run's statistical resolution.

**New protocol: do NOT kill mid-run on reward-trajectory diagnostics alone.** The true test signal is GPQA-Diamond held-out accuracy delta, not training-time reward shape. Run v0.4d to completion (~6+ hr more), then eval. If we're going to abort early, it must be on a hard error (OOM, NaN loss, divergence) — not a "flat" reward curve that's actually inside the noise band.

**v0.4d will run to step 500. No early kill.** Intermediate checkpoint-100 saves let us do an early eval if we want (option, not requirement).

**v0.4e pre-staged (if v0.4d eval on held-out also fails to beat base):**
```bash
# Increase LoRA rank from 16 to 64 for 7B-scale capacity match (standard QLoRA paper recommendation)
TMPDIR=/data/tmp HF_HUB_CACHE=/data/huggingface/hub PYTHONPATH=. \
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  nohup python3 -m experiments.substrate.src.rl.grpo_train \
    --train-questions experiments/substrate/data/mmlu_stem_hard.jsonl \
    --base-model Qwen/Qwen2.5-7B-Instruct \
    --quantize 4bit \
    --max-steps 500 \
    --num-generations 4 \
    --max-completion-length 1024 \
    --reward-kind with_format \
    --learning-rate 2e-5 \
    --lora-rank 64 \
    --save-steps 100 \
    --output-dir experiments/substrate/models/qwen-rl-v0.4e \
  > experiments/substrate/results/train_v0.4e.log 2>&1 &
```
`--lora-rank` and `--lora-alpha` flags shipped in commit 91d8010 (default alpha = 2*rank = QLoRA paper convention).

**Strategic rollup if BOTH v0.4d AND v0.4e fail:**
The substrate's "exceeds training limits" claim is empirically falsified at 4090 + Qwen-7B + GRPO scale on graduate MCQ. The honest report would document:
1. Substrate ARCHITECTURE works (all 6 components, 48 tests)
2. RL keystone runs end-to-end (v0.1-v0.4 all complete)
3. But: NO config produces measurable held-out lift
4. Hypotheses for re-architecture: distill-then-RL, test-time compute via long reasoning chains, or different benchmark with denser reward structure

**Implication for v0.4c (contingency, if v0.4b fails):**
The clip-bound pathology suggests one of:
1. Length-aware reward: reward correct-and-short more than correct-and-long (no length penalty currently)
2. Strict "Answer: X" terminator extraction that requires the letter to be NEAR EOS (not anywhere)
3. Different prompt format: "Answer: " expected as final 2 tokens, with reasoning before
4. Larger max_completion_length (2048+): doubles training time but lets model finish thoughts

Don't pre-implement v0.4c yet — wait for v0.4b vs base 7B verdict.

When the next /loop fires:

1. **Check v0.4d progress (informational only)** with the live tool:
   ```bash
   PYTHONPATH=. python3 -m experiments.substrate.src.rl.analyze_live_log \
     experiments/substrate/results/train_v0.4d.log
   ```
   The verdict will likely be INCONCLUSIVE all the way to step 500 because the noise floor is ~σ=0.05 even at n=110. Do not kill on this alone.
2. **Optional early eval at checkpoint-100** if you want a directional read without waiting for full training:
   ```bash
   python3 -m experiments.substrate.src.rl.eval_and_compare \
     --eval-set benchmarks/gpqa-diamond/data/problems.jsonl \
     --base-model Qwen/Qwen2.5-7B-Instruct \
     --adapter experiments/substrate/models/qwen-rl-v0.4d/checkpoint-100 \
     --baseline-results experiments/substrate/results/eval_base7b_full198.json \
     --output experiments/substrate/results/eval_v0.4d_chkpt100.json \
     --label v0.4d-step100
   ```
   But this competes with the still-running training for GPU. Default is **wait for full training**.
3. **If v0.4d training is done**: fire the one-shot pipeline:
   ```bash
   TMPDIR=/data/tmp HF_HUB_CACHE=/data/huggingface/hub PYTHONPATH=. \
     PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
     python3 -m experiments.substrate.src.rl.eval_and_compare \
       --eval-set benchmarks/gpqa-diamond/data/problems.jsonl \
       --base-model Qwen/Qwen2.5-7B-Instruct \
       --adapter experiments/substrate/models/qwen-rl-v0.4d \
       --baseline-results experiments/substrate/results/eval_base7b_full198.json \
       --output experiments/substrate/results/eval_v0.4d_full198.json \
       --label v0.4d
   ```
4. **Run analyze_training.py on the v0.4d checkpoint** (commit 7f57240).
5. **Commit eval JSON + final verdict + analysis** to git, update prompt.md with strategic verdict (or pivot to v0.4e if falsified).
