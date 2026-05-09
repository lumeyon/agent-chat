"""Tests for the per-agent feature matrix builder."""
import torch
from experiments.residual.src.matrix import build_per_agent_matrix


def _toy_triples():
    return [
        {"id": "q1", "domain": "Physics", "subdomain": "Mechanics",
         "query": "What is the velocity at t=2s if a=10?",
         "codex_response": "v = a*t = 20 m/s. Answer: A",
         "claude_response": "Possibly v = 20. Wait, let me reconsider. Answer: A",
         "agent_chat_response": "Answer: A"},
        {"id": "q2", "domain": "Chemistry", "subdomain": "Organic",
         "query": "What is the major product of Diels-Alder?",
         "codex_response": "$\\Delta H = -50$ kJ/mol. Answer: B",
         "claude_response": "Clearly the answer is B.",
         "agent_chat_response": "Answer: C"},
    ]


def test_returns_correct_shape():
    triples = _toy_triples()
    M = build_per_agent_matrix(triples, "codex", device="cpu")
    assert M.shape[0] == 2
    assert M.shape[1] >= 384  # at least the embedding dimension


def test_matrix_finite_no_nans():
    triples = _toy_triples()
    M = build_per_agent_matrix(triples, "claude", device="cpu")
    assert torch.isfinite(M).all()


def test_different_agents_produce_different_matrices():
    triples = _toy_triples()
    M_cx = build_per_agent_matrix(triples, "codex", device="cpu")
    M_cl = build_per_agent_matrix(triples, "claude", device="cpu")
    # Same shape but different content (different responses).
    assert M_cx.shape == M_cl.shape
    assert not torch.allclose(M_cx, M_cl)
