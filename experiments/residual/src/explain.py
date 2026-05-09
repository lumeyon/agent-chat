"""Explain why a row is anomalous: which features contributed most to its residual norm."""
import torch
from .response_features import FEATURE_NAMES
from .matrix import EMBED_DIM


def explain_residual(R_row: torch.Tensor, top: int = 3) -> list[dict]:
    """Identify the top-N feature dimensions driving this row's residual.
    Returns named features for scalar columns; aggregates the embedding span."""
    abs_r = R_row.abs()
    # Aggregate embedding contribution into a single "embedding_total" entry.
    emb_total = abs_r[:EMBED_DIM].sum().item()
    emb_max = abs_r[:EMBED_DIM].max().item()
    scalar = abs_r[EMBED_DIM:]
    contrib = [{"feature": "embedding_total", "abs_residual": emb_total, "max_single_dim": emb_max}]
    for i, name in enumerate(FEATURE_NAMES):
        contrib.append({
            "feature": name,
            "abs_residual": float(scalar[i].item()),
            "signed_residual": float(R_row[EMBED_DIM + i].item()),
        })
    contrib.sort(key=lambda c: c["abs_residual"], reverse=True)
    return contrib[:top]
