"""Tests for ensemble.run_ensemble — orchestrate K candidates per agent."""
import os
import pytest
from experiments.substrate.src.ensemble.run_ensemble import (
    run_ensemble, EnsembleResult,
)


def test_EnsembleResult_shape():
    r = EnsembleResult(
        query="q",
        per_agent={"claude": [], "codex": []},
        meta={"K": 3},
    )
    assert r.query == "q"
    assert "claude" in r.per_agent
    assert "codex" in r.per_agent


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live integration",
)
def test_run_ensemble_returns_K_per_agent():
    K = 2
    result = run_ensemble(
        query="What is 2+2? Answer: ",
        K=K,
        agents=["claude", "codex"],
        per_agent_timeout_sec=60,
    )
    assert isinstance(result, EnsembleResult)
    assert len(result.per_agent["claude"]) == K
    assert len(result.per_agent["codex"]) == K
    for r in result.per_agent["claude"]:
        assert r.agent == "claude"
    for r in result.per_agent["codex"]:
        assert r.agent == "codex"
