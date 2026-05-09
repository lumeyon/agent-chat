"""Tests for residual clustering — finds distinct anomaly STYLES per agent."""
import torch
from experiments.residual.src.cluster import (
    cluster_residuals, characterize_cluster,
)


def test_cluster_recovers_planted_groups():
    """50 residual vectors: 3 planted groups in different feature subspaces.
    k-means with k=3 should recover them up to label permutation."""
    torch.manual_seed(0)
    d = 20
    group_a = torch.randn(15, d) * 0.3 + torch.tensor([5.0] + [0] * (d - 1))
    group_b = torch.randn(15, d) * 0.3 + torch.tensor([0, 5.0] + [0] * (d - 2))
    group_c = torch.randn(20, d) * 0.3 + torch.tensor([0, 0, 5.0] + [0] * (d - 3))
    R = torch.cat([group_a, group_b, group_c])
    labels = cluster_residuals(R, k=3, seed=0)
    # Group label purity: each true-group should map to one cluster id ≥ 80% of the time.
    truth = ([0] * 15) + ([1] * 15) + ([2] * 20)
    from collections import Counter
    purity_total = 0
    for true_id, n in [(0, 15), (1, 15), (2, 20)]:
        slice_labels = [labels[i] for i, t in enumerate(truth) if t == true_id]
        most_common = Counter(slice_labels).most_common(1)[0][1]
        purity_total += most_common
    assert purity_total / len(truth) >= 0.8, f"cluster purity too low: {purity_total}/{len(truth)}"


def test_characterize_cluster_returns_top_features():
    """Given residual rows + a feature-name list, return the features that
    are largest IN MEAN ABS VALUE within the cluster."""
    rows = torch.tensor([
        [3.0, 0.1, 0.0, 0.0],
        [2.5, 0.0, 0.1, 0.0],
        [3.2, 0.2, 0.0, 0.1],
    ])
    feature_names = ["alpha", "beta", "gamma", "delta"]
    chars = characterize_cluster(rows, feature_names, top=2)
    assert chars[0]["feature"] == "alpha"
    assert chars[0]["mean_abs"] > 2.0
