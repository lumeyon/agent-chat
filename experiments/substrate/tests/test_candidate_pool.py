"""Tests for exploration.candidate_pool — Tang-sample K diverse candidates."""
import torch
from experiments.substrate.src.exploration.candidate_pool import sample_diverse


def test_returns_K_indices():
    """Sample K=3 from N=10 returns 3 distinct indices."""
    torch.manual_seed(0)
    candidates = [f"candidate {i}" for i in range(10)]
    indices = sample_diverse(candidates, K=3, k_lowrank=2, device="cpu", seed=0)
    assert len(indices) == 3
    assert len(set(indices)) == 3


def test_returns_indices_in_valid_range():
    torch.manual_seed(0)
    candidates = [f"candidate {i}" for i in range(8)]
    indices = sample_diverse(candidates, K=3, k_lowrank=2, device="cpu", seed=0)
    for i in indices:
        assert 0 <= i < 8


def test_recovers_planted_diverse_candidates():
    """Plant 3 obviously-different candidates among 10 similar ones; Tang
    should over-sample the diverse ones."""
    candidates = []
    for i in range(7):
        candidates.append(f"Standard reasoning step {i}. Answer: A")  # similar
    candidates.append("Wait, actually let me reconsider. " * 30 + "Answer: B")  # outlier
    candidates.append("$E = mc^2$ " * 50 + "Final answer: C")  # math-heavy outlier
    candidates.append("Looking at this problem carefully and methodically. " * 25 + "Answer: D")  # verbose
    indices = sample_diverse(candidates, K=4, k_lowrank=1, device="cpu", seed=0)
    # At least 2 of the 3 planted outliers (indices 7, 8, 9) should appear in K=4 selection
    overlap = len(set(indices) & {7, 8, 9})
    assert overlap >= 2, f"expected ≥2 of the 3 planted outliers, got {indices}"
