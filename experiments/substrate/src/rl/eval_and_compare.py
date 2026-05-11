"""End-to-end eval + bootstrap-CI report for a trained adapter.

Runs `evaluate_model_on_jsonl` for the trained adapter, loads a baseline
JSON for the same model, computes paired bootstrap CI, prints a verdict
report. The single-command pipeline I want to fire the moment v0.4b
training finishes.

Usage:
  python -m experiments.substrate.src.rl.eval_and_compare \
    --eval-set benchmarks/gpqa-diamond/data/problems.jsonl \
    --base-model Qwen/Qwen2.5-7B-Instruct \
    --adapter experiments/substrate/models/qwen-rl-v0.4b \
    --baseline-results experiments/substrate/results/eval_base7b_full198.json \
    --output experiments/substrate/results/eval_v0.4b_full198.json \
    --label v0.4b
"""
import argparse
import json
from pathlib import Path

import numpy as np

from .eval import evaluate_model_on_jsonl


def paired_bootstrap(arr_a: np.ndarray, arr_b: np.ndarray,
                     label_a: str, label_b: str,
                     n_boot: int = 10000, seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    n = len(arr_a)
    deltas = np.empty(n_boot, dtype=np.int64)
    for i in range(n_boot):
        idx = rng.integers(0, n, size=n)
        deltas[i] = arr_a[idx].sum() - arr_b[idx].sum()
    cilo, cihi = np.percentile(deltas, [2.5, 97.5])
    fix = int(((arr_a == 1) & (arr_b == 0)).sum())
    brk = int(((arr_a == 0) & (arr_b == 1)).sum())
    both_right = int(((arr_a == 1) & (arr_b == 1)).sum())
    both_wrong = int(((arr_a == 0) & (arr_b == 0)).sum())
    return {
        "label_a": label_a, "label_b": label_b,
        "n": int(n),
        "n_correct_a": int(arr_a.sum()),
        "n_correct_b": int(arr_b.sum()),
        "mean_delta": float(deltas.mean()),
        "ci_low": float(cilo), "ci_high": float(cihi),
        "p_a_better": float((deltas > 0).mean()),
        "p_b_better": float((deltas < 0).mean()),
        "fix": fix, "break": brk,
        "both_right": both_right, "both_wrong": both_wrong,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--adapter", type=Path, required=True)
    ap.add_argument("--baseline-results", type=Path, required=True,
                    help="JSON with per_question results for the same base model (no adapter)")
    ap.add_argument("--output", type=Path, required=True,
                    help="Where to write the trained eval JSON")
    ap.add_argument("--label", default="trained",
                    help="Label for the trained variant in the report")
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    args = ap.parse_args()

    print(f"# === eval_and_compare: {args.label} vs base ===")
    print(f"# base: {args.base_model}")
    print(f"# adapter: {args.adapter}")
    print(f"# eval-set: {args.eval_set}")
    print()

    # 1. Run trained eval
    print(f"# running trained eval...")
    r = evaluate_model_on_jsonl(args.eval_set, args.base_model, args.adapter,
                                max_new_tokens=args.max_new_tokens)
    print(f"# trained accuracy: {r.n_correct}/{r.n} = {r.accuracy*100:.1f}%")
    args.output.write_text(json.dumps({
        "n": r.n, "n_correct": r.n_correct, "accuracy": r.accuracy,
        "per_question": r.per_question,
        "base_model": args.base_model,
        "adapter": str(args.adapter),
    }, indent=2))
    print(f"# wrote {args.output}")
    print()

    # 2. Load baseline
    base = json.loads(args.baseline_results.read_text())
    base_by_id = {row["id"]: row for row in base["per_question"]}
    trained_by_id = {row["id"]: row for row in r.per_question}

    # 3. Build paired arrays
    common_ids = sorted(set(base_by_id) & set(trained_by_id))
    arr_t = np.array([1 if trained_by_id[i]["correct"] else 0 for i in common_ids])
    arr_b = np.array([1 if base_by_id[i]["correct"] else 0 for i in common_ids])

    # 4. Bootstrap
    boot = paired_bootstrap(arr_t, arr_b, args.label, "base", n_boot=10000)

    # 5. Parseable diagnostics
    def pacc(d):
        p_corr = sum(1 for r in d.values() if r["extracted"] and r["correct"])
        p_total = sum(1 for r in d.values() if r["extracted"])
        return p_corr / max(1, p_total), p_total
    pacc_t, pt = pacc(trained_by_id)
    pacc_b, pb = pacc(base_by_id)

    # 6. Report
    print(f"=== Headline ladder (n={boot['n']}, paired) ===")
    print(f"  Base:    {boot['n_correct_b']:3d}/{boot['n']} = {boot['n_correct_b']/boot['n']*100:.1f}%   parseable {pacc_b*100:.1f}% ({pb}/{boot['n']})")
    print(f"  {args.label}:   {boot['n_correct_a']:3d}/{boot['n']} = {boot['n_correct_a']/boot['n']*100:.1f}%   parseable {pacc_t*100:.1f}% ({pt}/{boot['n']})")
    print()
    print(f"=== Paired bootstrap (n_boot=10000) ===")
    print(f"  meanΔ ({args.label} - base) : {boot['mean_delta']:+.2f}")
    print(f"  95% CI                 : [{boot['ci_low']:.0f}, {boot['ci_high']:.0f}]   "
          f"({boot['ci_low']/boot['n']*100:+.1f}pp, {boot['ci_high']/boot['n']*100:+.1f}pp)")
    print(f"  p({args.label} > base)         : {boot['p_a_better']:.3f}")
    print(f"  FIX:{boot['fix']}  BREAK:{boot['break']}  "
          f"both_right:{boot['both_right']}  both_wrong:{boot['both_wrong']}")
    print()

    # 7. Verdict
    accept_gate_passes = boot['ci_low'] > 0
    if accept_gate_passes:
        verdict = f"✅ ACCEPTANCE GATE PASSED — {args.label} > base, CI excludes 0"
    elif boot['mean_delta'] > 0:
        verdict = f"~ MARGINAL — {args.label} mean above base but CI crosses 0 (n insufficient)"
    else:
        verdict = f"❌ FALSIFIED — {args.label} <= base"
    print(f"=== Verdict ===")
    print(f"  {verdict}")
    print(f"  (NL59 discipline: requires CI excluding 0 in positive direction)")


if __name__ == "__main__":
    main()
