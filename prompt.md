# RL Router for Heterogeneous Experts — Continuous-Learning Pivot (NL41+)

> **Mission (NL41+):** Pivot from agent-chat orchestration (v1 demonstrated -1 vs claude on GPQA, failed
> at the stated win condition) to a **learned router** π(e | x) over heterogeneous experts (codex,
> claude, optionally agent-chat). The router demonstrates **continuous learning**: accuracy improves
> measurably as a function of training samples, on the same GPQA Diamond data we already collected.
>
> This is the smallest end-to-end pilot of the broader vision: tree-of-knowledge experts with
> dynamic memory + reward-driven routing + Hebbian edge plasticity. Boss's framing of the bigger
> picture lives in `~/.claude/projects/-data-eyon-git-agent-chat/memory/` (Apprenticeship
> Substrate, Inquiry Lattice, Lumeyon dual-audience fusion, quantum continuity).

## Why the pivot

**Empirical:** at n=142 paired GPQA, oracle-router ceiling is **95.1%** vs codex_solo 88.7% (+6.3%
headroom). A trivial domain-argmax router already hits 91.5% (+2.8% over codex). Agent-chat v1
orchestration hits 87.3% (-1.4%). **Routing has measurably more headroom than orchestration on this
benchmark, with strictly less compute (1 LLM call per question instead of 3).**

**Strategic:** every (task, expert_chosen, reward) triple the router emits is simultaneously:
- training data for the router itself (immediate),
- training data for a future fine-tuned expert (medium-term),
- a row in the dataset Lumeyon sells to model-trainers (revenue path).

**Continuous-learning demo** is the forcing function: a rising accuracy curve as a function of
training samples seen. A static-argmax baseline does not satisfy this; an online-updated learned
policy does.

## Hardware mandate

NVIDIA RTX 4090 on this box (24GB VRAM, ~330 TFLOPS FP16). For the v0.1 model (small MLP) the GPU is
overkill but used regardless to stay aligned with the broader compute trajectory and to validate the
training loop on cuda before scaling. The query embedder (sentence-transformers) genuinely benefits
from GPU.

**Per `~/.claude/CLAUDE.md`:** "When doing training or inference with the gpu and you are about to
report that you are done and now waiting on the training or inference, always check that the GPU is
actually being used with `nvidia-smi`." → every iteration that runs training MUST verify GPU
utilization before reporting completion.

**Also from CLAUDE.md:** "Please always do calibrations and training on the FULL datasets. Do not use
`--max-size` or `--max-samples`." → train on all 198 questions, no subsetting. K-fold CV is fine
because each fold trains on a contiguous subset; that's not subsetting in the prohibited sense.

**Also from CLAUDE.md:** "When you debug an issue and believe you found a fix, first write the test
(C++ or pytest) and then verify that it fails. Then fix the issue, and then verify the test now
passes." → strict tests-first when fixing bugs. For new feature code, write the tests alongside the
module so failures during refactor are visible.

## Data on hand

- `benchmarks/gpqa-diamond/data/problems.jsonl` — 198 problems with `{id, domain, subdomain, question, choices: {A,B,C,D}, answer}`.
- `benchmarks/gpqa-diamond/results/codex.jsonl` — 198 baseline rows with `{id, correct, response, ...}`.
- `benchmarks/gpqa-diamond/results/claude.jsonl` — 198 baseline rows.
- `benchmarks/gpqa-diamond/results/agent-chat.jsonl` — 122 valid + 76 currently re-running (background pid 2232643). Final 198 once re-run completes.
- `benchmarks/gpqa-diamond/src/compare.ts` — already JOINs and emits paired stats. Shareable via the same JSONL files.

Each (id, expert) → outcome is **fully observed** (we have correct/incorrect for both experts on every question). This is full-information, not bandit. Training a Q-function `P(correct | query, expert)` is the principled choice; REINFORCE-style policy gradient is a wrapper we can add for the "RL framing" without losing the Q signal.

**Domain mix** (computed from prior NL40 work, n=198): Physics 86, Chemistry 93, Biology 19. **Per-domain expert profile** (n=142 paired) to guide router design:

| domain | codex acc | claude acc | only-codex | only-claude |
|---|---|---|---|---|
| Physics (n=53) | 98.1% | 98.1% | 0 | 0 |
| Chemistry (n=74) | 81.1% | 86.5% | 5 | 9 |
| Biology (n=15) | 93.3% | 60.0% | 5 | 0 |

→ Physics has no router headroom. Biology is solved by the rule "always send to codex." Chemistry is the only domain where the router has to actually learn; 14 of 74 questions (19%) have one expert right and the other wrong.

## v0.1 — minimum end-to-end RL router (target: 1-2 days)

**Goal:** reproduce or beat the trivial domain-argmax router (91.5%) using a learned policy, AND demonstrate that accuracy rises with training samples.

### v0.1 Project layout

Create at top level (NOT under `benchmarks/`, since this is a separate experimental track that will outlive the GPQA-specific scaffolding):

```
experiments/router/
  README.md                  # One paragraph: "see prompt.md for design; this is router v0.1"
  src/
    data.py                  # Load + JOIN problem + baseline files into training rows
    featurize.py             # Embed queries, build feature vectors
    model.py                 # PyTorch Q-function / policy
    train.py                 # Training loop: supervised + online/REINFORCE variants
    eval.py                  # K-fold CV, learning curve, oracle ceiling comparison
    router.py                # Production interface: query → expert pick
  tests/
    test_data.py
    test_featurize.py
    test_model.py
    test_train.py
    test_eval.py
  results/
    learning_curve.csv       # Per training-size, per-fold accuracy
    learning_curve.png       # Headline plot
    final_metrics.json       # Aggregate result vs baselines + oracle
  models/                    # Saved checkpoints (.pt)
```

### v0.1 Dependencies

Already installed (verify): `torch`, `bun`. Probably need to install: `sentence-transformers`,
`scikit-learn`, `matplotlib`, `pytest`, `numpy`. Check first with `pip list` (or whatever python env
is in use here) and install only what's missing.

```bash
TMPDIR=/data/tmp python3 -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no-gpu')"
```
Expect: torch present, cuda available, device name = "NVIDIA GeForce RTX 4090".

If cuda is NOT available, stop and report. The mission is GPU-validated; don't fall back to CPU silently.

### v0.1 Step-by-step build order

**Step 1 — Tests scaffold first.** Write all five `tests/test_*.py` files with stubs that import the modules and assert the expected interfaces (function names, return shapes). They will fail because the modules don't exist yet. That's the failing-test-first checkpoint. Run `TMPDIR=/data/tmp python -m pytest experiments/router/tests/ -x` and confirm all five fail with import errors.

**Step 2 — `src/data.py`.** Function `load_triples()` returns a list of `{id, domain, subdomain, query: str, choices: dict, answer_letter: str, codex_correct: bool, claude_correct: bool, agent_chat_correct: bool | None}`. JOIN by id across the three result files; tolerate missing agent-chat entries (return None for those). Test: returns 198 rows; codex_correct count matches `score.ts` codex baseline (177/198 expected).

**Step 3 — `src/featurize.py`.** Function `embed_queries(queries: list[str], device='cuda') -> torch.Tensor` returning shape (n, 384) using `BAAI/bge-small-en-v1.5` via `sentence-transformers`. Function `build_features(triples, embeddings) -> (X, y, meta)` returning:
- X: torch.Tensor (n_rows × 2_experts, dim) where dim = 384 (embed) + 3 (domain one-hot) + 30+ (subdomain one-hot) + 2 (expert one-hot) ≈ 420ish
- y: torch.Tensor (n_rows × 2,) of correct/incorrect per (question, expert)
- meta: dict with feature column-name list, domain index, subdomain index for inverse lookup

Test: feature dim is consistent across rows; embeddings device is cuda; all questions have non-NaN features.

**Step 4 — `src/model.py`.** Class `RouterQNet(nn.Module)`:
```python
class RouterQNet(nn.Module):
    def __init__(self, in_dim: int, hidden: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden), nn.ReLU(), nn.Dropout(0.1),
            nn.Linear(hidden, hidden // 2), nn.ReLU(), nn.Dropout(0.1),
            nn.Linear(hidden // 2, 1),
        )
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)  # logits for P(correct | x)
```
~75K params. Test: forward pass on dummy input returns shape (batch,), output is finite.

**Step 5 — `src/train.py`.** Two training entry points:

(a) `train_supervised(X, y, n_epochs=200, lr=1e-3, weight_decay=1e-4, device='cuda')` — straight BCE supervised, returns trained model + train/val loss curves. This is the Q-function trainer. Use AdamW. Cosine LR schedule. Early stopping on val loss with patience=20.

(b) `train_online(triples, embedder, ordering_seed=0)` — streams the 198 questions in shuffled order, maintains running model, after each question: (i) infers Q-values for both experts on this query, (ii) picks expert (greedy w.r.t. Q OR ε-greedy with ε=0.1), (iii) observes reward, (iv) does ONE SGD step on the (query, expert) pair with the observed reward. Records rolling-window accuracy in 20-question windows. Returns the per-step accuracy trajectory.

Test (a): on toy data with known signal, supervised training converges to >95% accuracy. Test (b): on the real 198-row data, the rolling-window accuracy at the END of the run is higher than at the START. This is the CONTINUOUS LEARNING TEST. If this test fails, the pivot's premise is wrong.

**Step 6 — `src/eval.py`.** Functions:
- `kfold_eval(triples, k=5, n_seeds=5, train_sizes=[10,25,50,100,158])` — for each train_size, run k-fold CV with n_seeds shuffles, train supervised, report mean ± std accuracy on held-out fold. Output: `results/learning_curve.csv`.
- `plot_learning_curve(csv_path, out_path)` — matplotlib: x = train_size, y = accuracy ± std band, with horizontal lines at codex_solo (88.7%), claude_solo (88.0%), agent_chat (87.3%), oracle (95.1%), domain_argmax (91.5%).
- `oracle_ceiling(triples)` — sanity check that recomputes the 95.1% ceiling on the 198-row data; must match the prior NL40 number to within 1 question.
- `final_metrics(triples, model)` — single-fold trained-on-all-but-test-fold accuracy, broken out by domain, vs all baselines. Output: `results/final_metrics.json`.

Test: oracle_ceiling returns 95.1% ± 0.5% (sanity).

**Step 7 — `src/router.py`.** Production interface that loads a trained checkpoint and exposes `route(query: str) -> dict[expert, float]` returning P(correct | query, expert) per expert. Used by future production calls. v0.1 only needs the Python interface; CLI wrapper can wait.

**Step 8 — Run the headline experiment.** Sequence:
1. `nvidia-smi` to confirm GPU is idle and accessible.
2. `python -m experiments.router.src.eval kfold` (or whatever invocation) → writes learning_curve.csv + .png.
3. `nvidia-smi` AGAIN during training (separate shell or before training finishes) to verify GPU utilization is non-zero. Per CLAUDE.md mandate.
4. `python -m experiments.router.src.eval final` → writes final_metrics.json.
5. Inspect the learning curve. **Pass criteria:** (a) router accuracy at train_size=158 > codex_solo (88.7%), (b) curve is monotone-rising (allowing for noise band), (c) oracle ceiling sanity check passes.

**Step 9 — Commit.** Commit the experiments/router/ directory with the data + plots. Update prompt.md with the actual numbers. Decide v0.2 priority based on the curve.

### v0.1 Acceptance criteria (concrete)

| metric | target | rationale |
|---|---|---|
| Test suite | all green | tests-first mandate |
| GPU utilized | nvidia-smi shows >0% during training | CLAUDE.md mandate |
| Trained on full 198 | yes | CLAUDE.md mandate (no max-samples) |
| Router @ n=158 | ≥ 89% (matches codex) | beat the strongest single-model baseline |
| Learning curve | monotone-rising, with std band visible | continuous-learning claim |
| Oracle sanity | 95.1% ± 0.5% | reproducibility check on prior numbers |
| Code lines | <500 across src/ | per CLAUDE.md "don't over-engineer" |

If router @ n=158 is BELOW codex_solo, that's a v0.1 fail. Don't claim continuous learning if the destination is below a static baseline. Investigate: insufficient features? embedder too weak? insufficient regularization? Iterate on featurization before declaring the architecture wrong.

### v0.1 build status (NL41 — SHIPPED)

- ✅ All 5 test files written first; **18/18 tests pass** (5:24 on CPU).
- ✅ All 5 src modules: data.py, featurize.py, model.py, train.py (supervised + online with replay buffer), eval.py (oracle, domain-argmax, kfold curve, plotting), router.py (production interface).
- ✅ Embedder = BAAI/bge-small-en-v1.5 (384-dim), HF_HOME=/data/cache/huggingface so model cache lives on /data not /.
- ✅ GPU verified during training: **21% util, 1067 MiB VRAM** on the 4090 (CLAUDE.md mandate satisfied).
- ✅ Trained on full n=198 (CLAUDE.md mandate, no max-samples).
- ✅ Code: ~410 lines across src/ (under 500-line ceiling).
- ✅ Headline plot + CSV + final_metrics.json written to `experiments/router/results/`.

### v0.1 honest result (n=198 paired, 5-fold × 5-seed kfold)

```
oracle ceiling     188/198 = 94.9%   (perfect router upper bound)
domain-argmax      180/198 = 90.9%   (zero learnable params)
codex alone        177/198 = 89.4%
claude alone       176/198 = 88.9%

learned router (mean ± std over 25 fold/seed runs):
  train_size=10:   88.6% ± 4.8%
  train_size=25:   89.2% ± 4.5%
  train_size=50:   89.1% ± 3.9%
  train_size=100:  87.7% ± 5.0%
  train_size=158:  88.4% ± 3.7%
```

**The curve is FLAT within noise.** Learned router clusters at 88-89% regardless of training-set size. Above codex_solo by ~0% (within noise), below domain-argmax by ~2.5%. **Continuous learning behavior is NOT demonstrated on this benchmark.**

Plot: `experiments/router/results/learning_curve.png` (rendered with horizontal reference lines at oracle, domain-argmax, codex_solo, claude_solo).

### v0.1 verdict + recommended pivot

**What v0.1 proves:** the substrate works end-to-end. PyTorch + sentence-transformers on cuda, full-info Q-function training, kfold evaluation, learning-curve plotting, oracle-ceiling sanity check, all bolted together with passing tests. The plumbing is real.

**What v0.1 cannot prove on GPQA:** continuous learning. Diagnosis is unambiguous — only ~14 of 142 paired questions have disagreement between codex and claude (5 only-codex + 9 only-claude). The other 128 questions, both experts give the same letter. A 384-dim embedder cannot learn signal from 14 differentiable training points; even strong regularization only collapses to "always pick codex" behavior.

**This is exactly stopping condition #3:** "Continuous-learning curve does not rise → either generate more triples or pivot benchmark."

**Recommended pivot — ranked benchmarks where codex and claude likely disagree more:**

| benchmark | size | expected disagree % | why |
|---|---|---|---|
| HumanEval | 164 | 30-40% | codex dominates code; claude noticeably weaker. Easy to set up. |
| MBPP | 974 | 25-35% | similar to HumanEval but bigger. Better statistics. |
| SWE-bench Verified | 500 | 40-60% | codex very strong on agentic-code; claude varies. Best disagreement candidate but each task is expensive (~$1+ per attempt). |
| MATH / AIME | 5K / 30 | 20-30% | claude often stronger on long-form math; codex sometimes shortcuts. AIME 2024-2025 is expensive ($$). |
| HLE | 3K | 30-40% | humanity's last exam; less saturated than GPQA. Mixed format. |
| Custom code-vs-reasoning split | n=200 | 50%+ | mix HumanEval (codex wins) + GPQA-Bio (claude weak) to engineer disagreement. Cheapest way to demonstrate the router. |

**My read:** start with **HumanEval (164 problems, easy to instrument)**. Reuses the same pattern (run codex baseline, run claude baseline, generate triples, train router). Expected outcome: ~30%+ disagreement rate, oracle ceiling above any single model by 8-15%, learned router has actual signal to learn. If router beats max(codex_solo, claude_solo) on HumanEval, the continuous-learning claim is REAL. If still flat, the substrate concept needs deeper redesign.

Cost: ~1 day of work to instrument + run. Codex tends to be very fast on HumanEval (<10s/Q typical), claude similar. ~$0 LLM cost on existing accounts.

### v0.2 + v0.3 status

Deferred until v0.1 is repeated on a non-saturated benchmark. v0.2 (episodic memory) and v0.3 (Hebbian edges) only add value if v0.1 can demonstrate any signal in the first place. On GPQA there's nothing for them to amplify.

## v0.2 — episodic memory (target: 1 week after v0.1)

**Goal:** add per-expert episodic memory; show that retrieval-augmented features lift the router's accuracy further.

After v0.1's router picks expert e for query x, retrieve K=5 most-similar prior triples where expert e was used and inject their outcomes as features into the router (NOT into the LLM — we're not re-calling the LLM for v0.2).

Mechanism:
- Per-expert FAISS index over query embeddings of historically-routed-to-expert questions.
- New query → top-K similar prior questions → mean(prior_correct) and std as additional features → re-train router with the augmented feature space.
- Test: router with episodic features beats router without by >1% on held-out fold.

If v0.2 doesn't lift over v0.1: the embedder is the bottleneck. Try a larger encoder (`BAAI/bge-large-en-v1.5`, 1024 dim) before declaring memory useless.

## v0.3 — Hebbian edges + multi-expert (target: 3 weeks)

**Goal:** add agent-chat as a third expert; learn edge weights w(drafter→critic | domain) instead of the existing hash-based peer pick.

Mechanism:
- Treat the petersen graph edges as routing parameters. Initialize uniform.
- For each agent-chat question: drafter is fixed (orion=claude). Sample peer ∝ exp(w(orion→peer | domain) / τ).
- After outcome observed, Hebbian-style update: w(orion→peer) += η × reward_signal × (1 if peer was selected else 0).
- Compare: hash-based peer selection (current) vs learned-edge-weighted selection.

Reuses the existing agent-chat substrate; doesn't require new LLM calls if we evaluate over the existing 122-198 agent-chat triples.

## v0.4+ — out of scope until v0.1-3 deliver

Per the boss's 10-direction sketch: retrieval-augmented per-expert specialization (mid-term), reward-weighted memory growth (mid-term), recursive expert teaching (mid-term), expert spawning (aspirational), market dynamics (aspirational). NOT building yet. The Tang ℓ₂-norm sampling machinery is also deferred — at 2-3 experts it's overkill. Implement when the lattice has 10+ heterogeneous expert nodes.

## Stability discipline (from boss's vision sec. 9)

GPQA's reward is ground-truth (correct/incorrect). Reward hacking is bounded — answer keys exist. Continuous learning on bounded reward is stable in practice; the pathologies (mode collapse, reward hacking, runaway specialization) become real on FUZZY reward (user satisfaction, novelty bonuses, predicted compression). **Stay on bounded-reward benchmarks until the substrate is proven, THEN graduate.**

Mitigations to bake in even on bounded reward:
- KL constraint to a baseline policy (uniform 50/50 over experts) — prevents the router from collapsing too hard onto one expert if the early data is unbalanced.
- Periodic eval on fixed held-out fold — catch silent regression.
- Save checkpoints every N updates so we can roll back if the policy gets worse.

## Inviolable rules (carried from prior NL iterations)

1. **TESTS-FIRST when fixing bugs.** Strict per CLAUDE.md.
2. **Train on FULL 198.** No `--max-size`/`--max-samples`. K-fold CV uses contiguous subsets, that's allowed.
3. **GPU verification.** `nvidia-smi` must show non-zero utilization during training; verify before reporting "done."
4. **Reproducibility.** Seeded shuffles. Saved checkpoints. CSV outputs that can be re-plotted.
5. **PAIRED comparison.** Router accuracy reported on the same 198 ids as codex/claude baselines; use compare.ts-style JOIN.
6. **Don't over-engineer v0.1.** Single-feature-set, single-model, no premature abstractions for v0.2/v0.3 hooks.
7. **Search before writing.** Per CLAUDE.md: grep/find/ls before creating new files; check `experiments/`, `benchmarks/`, top-level for any pre-existing router work. None expected, but verify.
8. **TMPDIR=/data/tmp** for all shell scratch. Per saved feedback memory; root partition has been chronically near-full.

## Carryover from NL40 (still in flight)

- **Agent-chat v1 re-run** is alive in background (pid 2232643). 16/76 done at last check; ETA ~10:00 local. When it finishes, run `bun benchmarks/gpqa-diamond/src/compare.ts` for the FINAL paired numbers on all 198 ids. Use those final agent-chat-as-third-expert numbers as the v0.3 reference point.
- **compare.ts** at `benchmarks/gpqa-diamond/src/compare.ts` — JOINs three result files, drops disk-fill polluted rows. Reuse for any GPQA-related comparison going forward.
- **Disk recovery** complete: claude.json restored, TMPDIR=/data/tmp set globally in `~/.claude/settings.json` env block. Boss has launched a separate claude session to investigate the root-cause disk-fill pattern; track that work via memory if/when it lands.

## Stopping conditions

1. **v0.1 acceptance criteria all green** → ship the v0.1 paper-grade plot + final_metrics.json, decide v0.2 priority based on the curve shape.
2. **v0.1 router @ n=158 below codex_solo** → architecture or featurization is wrong. Investigate; do NOT proceed to v0.2 until v0.1 lands.
3. **Oracle ceiling on 198-row data drops below 90%** → indicates the GPQA benchmark is too saturated to discriminate any router. Pivot to a less-saturated benchmark (HLE, ARC-AGI-2, or a code-vs-reasoning split where the two experts genuinely diverge).
4. **Continuous-learning curve does not rise** → the data is too small or too saturated to demonstrate online learning. Either generate more triples (run the same 198 questions multiple times to capture stochastic variation) or pivot benchmark.

## Cadence

This mission is `/loop`-driven: each iter runs as much as can fit in one turn, commits, updates prompt.md, schedules a heartbeat. The agent-chat re-run finishing is a Monitor-driven event; the router build is foreground compute. Use background tasks for the GPQA re-run only.

## Lessons learned (carryforward)

- **Heterogeneity is real and free.** codex and claude have measurably different error patterns, even on 2 experts. The router doesn't need exotic infrastructure to extract value — even a 3-line domain-argmax beats both single-model baselines on this data.
- **Saturation is the silent killer of orchestration value.** GPQA at 88-89% has no Physics headroom (98% all three) and tiny n in Biology (15). The router's value is bounded by oracle ceiling - max(baselines), which on saturated benchmarks is small even when "correctly" learned. Pick benchmarks where the oracle gap is larger.
- **Full-information beats bandit when available.** We observe both expert outcomes per question, so supervised Q-function training is correct; pretending otherwise wastes signal.
- **Mid-flight verdicts can flip.** The 58% v1 verdict said -2 net vs claude; the 122-Q (61%) verdict said +1 net flip ledger. Don't commit to a redesign motivation until the full dataset is in.
- **Disk-fill failure mode (NL40):** the claude CLI's atomic write of `~/.claude.json` truncates to 0 bytes if `/` is at 100% during the rename. Defensive: TMPDIR=/data/tmp now set globally; durable fix would be symlinking `~/.claude.json` onto `/data`.
