"""Synthetic-data tests for the Tang ℓ²-norm residual sampler."""
import torch
from experiments.residual.src.kernel import residual_sample


def test_recovers_planted_anomalies():
    """50 rows: 45 are rank-2 + small noise; 5 have a high-norm anomaly direction.
    residual_sample(k=2, n_samples=5) should recover ≥4 of the 5 anomaly indices."""
    torch.manual_seed(0)
    n, d = 50, 30
    # rank-2 base: each row is α·u + β·v
    u = torch.randn(d)
    v = torch.randn(d)
    M = torch.zeros(n, d)
    for i in range(n):
        M[i] = torch.randn(1).item() * u + torch.randn(1).item() * v + 0.05 * torch.randn(d)
    # Plant 5 anomalies: large component in a direction orthogonal to {u, v}
    anomaly_dir = torch.randn(d)
    # Orthogonalize against u, v.
    for basis in (u, v):
        anomaly_dir = anomaly_dir - (anomaly_dir @ basis) / (basis @ basis) * basis
    anomaly_dir = anomaly_dir / anomaly_dir.norm()
    planted = [3, 11, 22, 33, 44]
    for idx in planted:
        M[idx] = M[idx] + 5.0 * anomaly_dir
    indices, residuals, probs = residual_sample(M, k=2, n_samples=5, seed=0)
    overlap = len(set(indices.tolist()) & set(planted))
    assert overlap >= 4, f"only recovered {overlap}/5 planted anomalies; got idx={indices.tolist()}"


def test_residual_norms_decrease_after_lowrank_subtract():
    """After top-k SVD subtract, the resulting residual norms should be strictly less
    than the original row norms (modulo numerical noise)."""
    torch.manual_seed(1)
    M = torch.randn(20, 50)
    indices, residuals, probs = residual_sample(M, k=3, n_samples=5, seed=0)
    orig_norms = M[indices].norm(dim=1)
    res_norms = residuals.norm(dim=1)
    # Residuals are ⊆ M projected to orthogonal subspace; their norms must be ≤ originals.
    assert (res_norms <= orig_norms + 1e-5).all(), \
        f"residual norms exceeded originals: orig={orig_norms.tolist()}, res={res_norms.tolist()}"


def test_returns_correct_shape_and_dtype():
    M = torch.randn(40, 16)
    indices, residuals, probs = residual_sample(M, k=2, n_samples=10, seed=42)
    assert indices.shape == (10,)
    assert residuals.shape == (10, 16)
    assert probs.shape == (10,)
    assert (probs > 0).all()
