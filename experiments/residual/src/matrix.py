"""Build per-agent feature matrix from triples.

Each row is one (question, agent) → 396-dim feature vector
(384 BGE response embedding + 12 scalar features).

After concatenation, scalar columns are z-scored across rows so they don't get
swamped by the unit-norm embedding columns. Embedding rows are already normalized
by sentence-transformers so we don't touch them."""
import os
import torch
from sentence_transformers import SentenceTransformer
from .response_features import FEATURE_NAMES, build_feature_vector

EMBEDDER_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

_embedder_cache: SentenceTransformer | None = None


def _get_embedder(device: str = "cuda") -> SentenceTransformer:
    global _embedder_cache
    if _embedder_cache is None:
        os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
        dev = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
        _embedder_cache = SentenceTransformer(EMBEDDER_NAME, device=dev)
    return _embedder_cache


def _resp_field(agent: str) -> str:
    return f"{agent}_response"


def build_per_agent_matrix(
    triples: list[dict],
    agent: str,
    device: str = "cuda",
) -> torch.Tensor:
    """Returns M of shape (n_triples, EMBED_DIM + len(FEATURE_NAMES)).
    Numeric scalar columns are z-scored across rows."""
    field = _resp_field(agent)
    responses = [t.get(field, "") or "" for t in triples]
    embedder = _get_embedder(device)
    embs = embedder.encode(
        responses,
        convert_to_tensor=True,
        show_progress_bar=False,
        normalize_embeddings=True,
    ).float().cpu()
    rows = [build_feature_vector(text, embs[i]) for i, text in enumerate(responses)]
    M = torch.stack(rows)
    # Z-score the scalar feature columns (last len(FEATURE_NAMES)) — leave embedding alone.
    scalar_start = EMBED_DIM
    cols = M[:, scalar_start:]
    mu = cols.mean(dim=0, keepdim=True)
    sd = cols.std(dim=0, keepdim=True).clamp(min=1e-6)
    M[:, scalar_start:] = (cols - mu) / sd
    return M
