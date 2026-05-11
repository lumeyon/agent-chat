"""Tests for rl.eval — held-out evaluation of trained checkpoints."""
import os
import pytest
from experiments.substrate.src.rl.eval import (
    EvalResult, evaluate_model_on_jsonl, bootstrap_delta_ci,
)


def test_EvalResult_shape():
    r = EvalResult(n=5, n_correct=3, accuracy=0.6, per_question=[])
    assert r.n == 5
    assert r.accuracy == 0.6


def test_bootstrap_delta_ci_returns_correct_shape():
    """Compare two correct/incorrect arrays, get bootstrap CI."""
    arr_a = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1]   # 7/10
    arr_b = [0, 0, 1, 1, 0, 0, 1, 0, 0, 1]   # 4/10
    ci = bootstrap_delta_ci(arr_a, arr_b, n_bootstrap=1000, seed=0)
    assert "mean_delta" in ci
    assert "ci_low_pct" in ci
    assert "ci_high_pct" in ci
    assert "p_one_sided" in ci
    # arr_a is meaningfully better than arr_b on this small sample
    assert ci["mean_delta"] > 1.5  # raw question count


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live model evaluation",
)
def test_evaluate_model_on_jsonl_smoke(tmp_path):
    """Smoke: eval base Qwen-1.5B on first 2 GPQA questions."""
    import json
    eval_path = tmp_path / "eval.jsonl"
    with open("benchmarks/gpqa-diamond/data/problems.jsonl") as f:
        rows = [json.loads(l) for l in f if l.strip()][:2]
    eval_path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    r = evaluate_model_on_jsonl(
        eval_path,
        base_model="Qwen/Qwen2.5-1.5B-Instruct",
        adapter_path=None,  # base model
        max_new_tokens=200,
    )
    assert r.n == 2
    assert 0 <= r.n_correct <= 2
    assert 0.0 <= r.accuracy <= 1.0
