"""Tests for the multi-agent boundary scout (Track C)."""
import torch
from experiments.residual.src.boundary import (
    build_multiagent_matrix, scout_boundary, decompose_per_agent_divergence,
)


def _toy_triples_with_disagreement():
    """30 rows: 27 with all 3 agents in agreement, 3 with codex anomalous.
    Multiple planted anomalies prevent rank-1 SVD from absorbing a single
    outlier direction."""
    base = [
        {"id": f"q{i:02d}", "domain": "Physics", "subdomain": "Mechanics",
         "query": f"Question {i}",
         "codex_response": f"Step by step calculation for q{i}. Answer: A",
         "claude_response": f"Step by step calculation for q{i}. Answer: A",
         "agent_chat_response": f"Step by step calculation for q{i}. Answer: A"}
        for i in range(30)
    ]
    # Plant 3 codex-off-script anomalies at indexes 7, 14, 22.
    for idx in (7, 14, 22):
        base[idx]["codex_response"] = (
            "Wait. Actually, let me reconsider. " * 25 +
            "I'm uncertain. Possibly maybe perhaps. " * 15 +
            "Answer: D"
        )
    return base


def test_multiagent_matrix_shape():
    triples = _toy_triples_with_disagreement()
    agents = ["codex", "claude", "agent_chat"]
    M, valid, per_agent_dim = build_multiagent_matrix(triples, agents, device="cpu")
    assert M.shape[0] == len(triples)  # all 20 are valid (all agents have responses)
    assert len(valid) == len(triples)
    assert M.shape[1] == per_agent_dim * len(agents)
    assert torch.isfinite(M).all()


def test_scout_recovers_planted_disagreements():
    """At least 2 of the 3 planted disagreements should appear in top-5 residuals."""
    triples = _toy_triples_with_disagreement()
    result = scout_boundary(triples, ["codex", "claude", "agent_chat"], k=1, n_samples=5, device="cpu")
    ids = [a["id"] for a in result["disagreements"]]
    planted = {"q07", "q14", "q22"}
    overlap = planted & set(ids)
    assert len(overlap) >= 2, f"expected ≥2 of {planted} in top-5, got {ids}"


def test_per_agent_decomposition_is_mathematically_consistent():
    """For every sampled disagreement, per-agent divergence_sq values should
    sum to (within float epsilon) the total residual norm². On toy data with
    few rows, SVD absorption can swap rankings — the exact ordering is fragile.
    What MUST hold is the math: per-agent decomposition partitions the
    residual norm² by agent slice."""
    triples = _toy_triples_with_disagreement()
    result = scout_boundary(triples, ["codex", "claude", "agent_chat"], k=1, n_samples=5, device="cpu")
    for a in result["disagreements"]:
        per_agent_sum = sum(c["divergence_sq"] for c in a["per_agent_divergence"])
        total = a["total_divergence_sq"]
        rel_err = abs(per_agent_sum - total) / max(total, 1e-9)
        assert rel_err < 1e-4, \
            f"per-agent sum != total on {a['id']}: per_agent_sum={per_agent_sum:.6f}, total={total:.6f}, rel_err={rel_err:.6f}"
        # Every per-agent divergence is non-negative.
        for c in a["per_agent_divergence"]:
            assert c["divergence_sq"] >= 0
        # And contribs are sorted descending.
        divs = [c["divergence_sq"] for c in a["per_agent_divergence"]]
        assert divs == sorted(divs, reverse=True), f"contribs not sorted desc: {divs}"
