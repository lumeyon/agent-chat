"""Tang-style ℓ²-norm sampling on residual matrices.

Given M ∈ R^{n×d}, keep top-k SVD modes, compute residual R = M - M_k, and
sample n_samples row indices with probability ∝ ||R_i||² (without replacement).

This is the kernel for both Track A (per-agent anomaly) and Track C (multi-agent
boundary scout). Tracks differ only in what M is."""
from typing import Tuple
import torch


def residual_sample(
    M: torch.Tensor,
    k: int,
    n_samples: int,
    seed: int = 0,
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Returns (indices, residual_rows, sampled_probs)."""
    if M.dim() != 2:
        raise ValueError(f"M must be 2-D, got shape {tuple(M.shape)}")
    n, d = M.shape
    if k < 0 or k > min(n, d):
        raise ValueError(f"k={k} out of range for ({n}, {d})")
    if n_samples > n:
        raise ValueError(f"n_samples={n_samples} > n={n}")

    M_f = M.float()
    U, S, Vh = torch.linalg.svd(M_f, full_matrices=False)
    if k > 0:
        M_k = U[:, :k] @ torch.diag(S[:k]) @ Vh[:k, :]
        R = M_f - M_k
    else:
        R = M_f

    norms_sq = (R ** 2).sum(dim=1)
    total = norms_sq.sum()
    if total <= 0:
        raise RuntimeError("residual norms sum to zero; matrix is rank-k")
    probs = norms_sq / total

    g = torch.Generator(device=M.device).manual_seed(seed)
    indices = torch.multinomial(probs, n_samples, replacement=False, generator=g)
    return indices, R[indices], probs[indices]
