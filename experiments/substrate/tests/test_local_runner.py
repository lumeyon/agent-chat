"""Tests for ensemble.local_runner — Qwen-2.5-1.5B-Instruct via HF transformers."""
import os
import pytest
from experiments.substrate.src.ensemble.local_runner import (
    run_qwen_local, get_local_model, DEFAULT_MODEL,
)
from experiments.substrate.src.ensemble.api_runners import RunResult


def test_default_model_is_qwen_1_5b():
    assert "Qwen2.5-1.5B-Instruct" in DEFAULT_MODEL


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live local-model integration",
)
def test_run_qwen_local_smoke():
    r = run_qwen_local("What is 2+2? Answer with one word.", max_new_tokens=20)
    assert isinstance(r, RunResult)
    assert r.agent.startswith("qwen")
    assert r.elapsed_ms > 0
    # Be permissive on the actual content; just check we got SOMETHING.
    assert r.text or r.error is not None


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live local-model integration",
)
def test_get_local_model_caches():
    """Second call should return the same (model, tokenizer) tuple."""
    a = get_local_model()
    b = get_local_model()
    assert a is b
