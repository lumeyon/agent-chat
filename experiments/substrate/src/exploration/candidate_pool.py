"""Tang ℓ²-norm sampling of K most-diverse candidates from a pool of N.

Per TANG_EXPLORATION.md §3 (level-2 fit). Wraps the residual_sample kernel
from experiments/residual/src/kernel.py with a candidate-aware feature
extractor.

This is the exploration policy that component 6's RL training will call
during rollouts to oversample diverse candidates before reward scoring."""
import torch
from .feature_extractor import build_candidate_features

# Reuse the canonical ℓ²-norm-residual sampler from NL42.
from experiments.residual.src.kernel import residual_sample


def sample_diverse(
    candidates: list[str],
    *,
    K: int,
    k_lowrank: int = 4,
    device: str = "cuda",
    seed: int = 0,
) -> list[int]:
    """Return K indices into `candidates` chosen by Tang ℓ²-norm sampling
    of the residual after top-k SVD subtraction.

    Falls back gracefully when:
      - len(candidates) ≤ K → return all indices
      - len(candidates) ≤ k_lowrank → cap k_lowrank to len-1 (rank-deficient)
      - residual is exactly zero (matrix is rank-k) → fall back to uniform sample
    """
    n = len(candidates)
    if n == 0:
        return []
    if n <= K:
        return list(range(n))

    M = build_candidate_features(candidates, device=device, z_score_scalars=True)

    # Cap k_lowrank to prevent rank-deficiency errors.
    effective_k = max(1, min(k_lowrank, M.shape[0] - 1, M.shape[1] - 1))

    try:
        indices, _residuals, _probs = residual_sample(
            M, k=effective_k, n_samples=K, seed=seed,
        )
        return indices.tolist()
    except RuntimeError as e:
        # residual_sample raises when norms sum to 0 (matrix is rank-k or below)
        if "residual norms sum to zero" in str(e):
            g = torch.Generator().manual_seed(seed)
            return torch.randperm(n, generator=g)[:K].tolist()
        raise
