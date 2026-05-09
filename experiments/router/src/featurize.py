"""Embed queries (BGE-small-en-v1.5) + assemble feature vectors per (question, expert)."""
import os
import torch
from sentence_transformers import SentenceTransformer

EMBEDDER_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

DOMAINS = ["Physics", "Chemistry", "Biology"]
EXPERTS = ["codex", "claude"]

_embedder_cache: SentenceTransformer | None = None


def _get_embedder(device: str | None = None) -> SentenceTransformer:
    global _embedder_cache
    if _embedder_cache is None:
        os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
        dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
        _embedder_cache = SentenceTransformer(EMBEDDER_NAME, device=dev)
    return _embedder_cache


def embed_queries(queries: list[str], device: str | None = None) -> torch.Tensor:
    m = _get_embedder(device)
    embs = m.encode(queries, convert_to_tensor=True, show_progress_bar=False, normalize_embeddings=True)
    return embs.float().cpu()


def build_features(triples: list[dict], embeddings: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, dict]:
    """Two rows per triple, one per expert. Feature = embed + domain-1hot + subdomain-1hot + expert-1hot."""
    subdomains = sorted({t["subdomain"] for t in triples})
    sub_idx = {s: i for i, s in enumerate(subdomains)}
    n_sub = len(subdomains)
    expert_idx = {e: i for i, e in enumerate(EXPERTS)}

    rows = []
    labels = []
    for i, t in enumerate(triples):
        emb = embeddings[i]
        d_oh = torch.zeros(len(DOMAINS))
        d_oh[DOMAINS.index(t["domain"])] = 1.0
        s_oh = torch.zeros(n_sub)
        s_oh[sub_idx[t["subdomain"]]] = 1.0
        for e in EXPERTS:
            e_oh = torch.zeros(len(EXPERTS))
            e_oh[expert_idx[e]] = 1.0
            rows.append(torch.cat([emb, d_oh, s_oh, e_oh]))
            labels.append(1.0 if t[f"{e}_correct"] else 0.0)
    X = torch.stack(rows)
    y = torch.tensor(labels)
    meta = {
        "subdomains": subdomains,
        "subdomain_idx": sub_idx,
        "n_subdomains": n_sub,
        "domains": DOMAINS,
        "experts": EXPERTS,
        "expert_idx": expert_idx,
        "feature_dim": X.shape[1],
    }
    return X, y, meta
