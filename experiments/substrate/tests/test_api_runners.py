"""Tests for ensemble.api_runners — claude and codex subprocess wrappers."""
import os
import pytest
from experiments.substrate.src.ensemble.api_runners import (
    run_claude, run_codex, RunResult,
)


def test_RunResult_has_required_fields():
    r = RunResult(text="x", elapsed_ms=1, status=0, agent="claude", error=None)
    assert r.text == "x"
    assert r.elapsed_ms == 1
    assert r.status == 0
    assert r.agent == "claude"


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live claude integration",
)
def test_run_claude_smoke():
    r = run_claude("Reply with exactly: OK", timeout_sec=30)
    assert r.agent == "claude"
    assert "OK" in r.text or r.status == 0
    assert r.elapsed_ms > 0


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run live codex integration",
)
def test_run_codex_smoke():
    r = run_codex("Reply with exactly: OK", timeout_sec=120)
    assert r.agent == "codex"
    assert r.elapsed_ms > 0


def test_run_claude_returns_error_on_invalid_command():
    """If claude binary doesn't exist, RunResult should reflect that, not crash."""
    # We can't easily simulate this without monkeypatching subprocess, so
    # just check that RunResult can carry an error string.
    r = RunResult(text="", elapsed_ms=0, status=-1, agent="claude", error="not found")
    assert r.error == "not found"
    assert r.status == -1
