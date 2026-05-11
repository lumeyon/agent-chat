"""Tests for verifier.score_ensemble — wires ensemble + verifier together."""
from experiments.substrate.src.ensemble.api_runners import RunResult
from experiments.substrate.src.ensemble.run_ensemble import EnsembleResult
from experiments.substrate.src.verifier.qa_verifier import QAVerifier
from experiments.substrate.src.verifier.score_ensemble import (
    score_ensemble, ScoredEnsemble,
)


def _fake_ensemble():
    return EnsembleResult(
        query="What is 2+2? (A) 3 (B) 4 (C) 5 (D) 6\nAnswer:",
        per_agent={
            "claude": [
                RunResult(text="Reasoning. Answer: B", elapsed_ms=100, status=0, agent="claude"),
                RunResult(text="Reasoning. Answer: A", elapsed_ms=120, status=0, agent="claude"),
            ],
            "codex": [
                RunResult(text="Step. Answer: B", elapsed_ms=200, status=0, agent="codex"),
                RunResult(text="I cannot answer", elapsed_ms=180, status=0, agent="codex"),
            ],
        },
        meta={"K": 2},
    )


def test_score_ensemble_returns_per_agent_results():
    e = _fake_ensemble()
    v = QAVerifier()
    query = {"id": "q1", "answer": "B", "choices": {}}
    s = score_ensemble(e, v, query)
    assert isinstance(s, ScoredEnsemble)
    assert s.query_id == "q1"
    assert s.expected == "B"
    assert len(s.per_agent_candidates["claude"]) == 2
    assert len(s.per_agent_candidates["codex"]) == 2


def test_pass_rate_per_agent():
    e = _fake_ensemble()
    v = QAVerifier()
    query = {"id": "q1", "answer": "B", "choices": {}}
    s = score_ensemble(e, v, query)
    rates = s.per_agent_pass_rate()
    # claude: 1 of 2 correct (B) → 0.5
    assert rates["claude"] == 0.5
    # codex: 1 of 2 (the second was unparseable) → 0.5
    assert rates["codex"] == 0.5


def test_best_per_agent():
    e = _fake_ensemble()
    v = QAVerifier()
    query = {"id": "q1", "answer": "B", "choices": {}}
    s = score_ensemble(e, v, query)
    best = s.best_per_agent()
    # claude best = "Answer: B" candidate (score 1.0)
    assert best["claude"].verifier.score == 1.0
    assert best["claude"].verifier.extracted == "B"
    # codex best = "Answer: B" candidate (score 1.0)
    assert best["codex"].verifier.score == 1.0
