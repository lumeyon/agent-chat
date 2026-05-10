"""Track A v0.2: re-cluster agent_chat with LLM-judge features added to the
feature vector. See if separation improves over the regex-only v0.1.

Augmented feature vector per (agent_chat response):
  [embedding (384) | scalar regex (12) | judge labels (6)] = 402 dim
"""
import json
from pathlib import Path
import torch
from .matrix import build_per_agent_matrix, EMBED_DIM, _get_embedder
from .response_features import build_feature_vector, FEATURE_NAMES
from .judge_features import batch_classify, JUDGE_CATEGORIES, features_to_vector
from .kernel import residual_sample
from .cluster import cluster_residuals, characterize_cluster
from .detect import _load_triples_from_disk

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def build_augmented_matrix(triples: list[dict], agent: str, judge_cache: dict, device: str = "cuda") -> torch.Tensor:
    """Like build_per_agent_matrix but appends the judge feature vector."""
    field = f"{agent}_response"
    responses = [t.get(field, "") or "" for t in triples]
    embedder = _get_embedder(device)
    embs = embedder.encode(responses, convert_to_tensor=True, show_progress_bar=False, normalize_embeddings=True).float().cpu()
    rows = []
    for i, text in enumerate(responses):
        scalar = build_feature_vector(text, embs[i])  # 384 + 12 = 396
        judge_vec = features_to_vector(judge_cache.get(triples[i]["id"], {c: 0 for c in JUDGE_CATEGORIES}))
        full = torch.cat([scalar, torch.tensor(judge_vec, dtype=torch.float32)])
        rows.append(full)
    M = torch.stack(rows)
    # Z-score scalar (regex) + judge columns. Embedding stays untouched.
    cols = M[:, EMBED_DIM:]
    mu = cols.mean(dim=0, keepdim=True)
    sd = cols.std(dim=0, keepdim=True).clamp(min=1e-6)
    M[:, EMBED_DIM:] = (cols - mu) / sd
    return M


def main() -> None:
    triples = _load_triples_from_disk()
    print(f"# loaded {len(triples)} triples")
    valid = [t for t in triples if t.get("agent_chat_response")]
    print(f"# {len(valid)} have agent_chat responses")
    cache_path = RESULTS_DIR / "judge_cache_agent_chat.json"

    print(f"# classifying with LLM-judge (cached at {cache_path})...")
    pairs = [(t["id"], t["agent_chat_response"]) for t in valid]
    judge_cache = batch_classify(pairs, cache_path=cache_path, verbose=True)
    print(f"# judge cache size: {len(judge_cache)}")

    # Audit: distribution of categories.
    from collections import Counter
    cat_counts = Counter()
    for v in judge_cache.values():
        for c, val in v.items():
            if val:
                cat_counts[c] += 1
    print(f"# category counts across {len(judge_cache)} responses:")
    for c, n in cat_counts.most_common():
        print(f"  {c}: {n} ({n/len(judge_cache)*100:.1f}%)")

    # Build augmented matrix
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# building augmented matrix on {device}...")
    M = build_augmented_matrix(valid, "agent_chat", judge_cache, device=device)
    print(f"# matrix shape: {tuple(M.shape)}")

    # Compute residuals against top-5 SVD; cluster the high-residual half.
    Mc = M.float() - M.float().mean(dim=0, keepdim=True)
    U, S, Vh = torch.linalg.svd(Mc, full_matrices=False)
    M_k = U[:, :5] @ torch.diag(S[:5]) @ Vh[:5, :]
    R = M.float() - M_k
    norms_sq = (R ** 2).sum(dim=1)
    threshold = norms_sq.median().item()
    high_idx = torch.where(norms_sq > threshold)[0].tolist()
    R_high = R[high_idx]
    n_clusters = 4
    labels = cluster_residuals(R_high, k=n_clusters, seed=0)

    # Characterize each cluster on (regex + judge) feature subset.
    n_regex = len(FEATURE_NAMES)
    n_judge = len(JUDGE_CATEGORIES)
    feature_subset_names = FEATURE_NAMES + JUDGE_CATEGORIES
    scalar_R_high = R_high[:, EMBED_DIM:]  # regex (12) + judge (6) = 18
    clusters_out = []
    for cid in range(n_clusters):
        member_local = [i for i, l in enumerate(labels) if l == cid]
        if not member_local:
            continue
        member_rows = scalar_R_high[member_local]
        signature = characterize_cluster(member_rows, feature_subset_names, top=6)
        # Judge-feature density per cluster
        judge_density = {}
        for c in JUDGE_CATEGORIES:
            count = sum(judge_cache[valid[high_idx[i]]["id"]].get(c, 0) for i in member_local)
            judge_density[c] = count / len(member_local)
        # Top-5 exemplars by within-cluster residual norm
        member_norms = (R_high[member_local] ** 2).sum(dim=1).tolist()
        ranked = sorted(zip(member_local, member_norms), key=lambda x: x[1], reverse=True)
        exemplars = []
        for local_i, norm_sq in ranked[:5]:
            global_i = high_idx[local_i]
            t = valid[global_i]
            exemplars.append({
                "id": t["id"],
                "domain": t.get("domain", ""),
                "subdomain": t.get("subdomain", ""),
                "residual_norm_sq": float(norm_sq),
                "judge_labels": judge_cache[t["id"]],
                "response_excerpt": (t.get("agent_chat_response") or "")[:200],
            })
        clusters_out.append({
            "cluster_id": cid,
            "n_members": len(member_local),
            "signature": signature,
            "judge_density": judge_density,
            "exemplars": exemplars,
        })

    result = {
        "agent": "agent_chat",
        "feature_set": "regex+judge",
        "k_lowrank": 5,
        "n_clusters": n_clusters,
        "n_total_rows": int(M.shape[0]),
        "n_high_residual": int(len(R_high)),
        "matrix_shape": list(M.shape),
        "clusters": clusters_out,
    }
    out = RESULTS_DIR / "clusters_agent_chat_v02.json"
    out.write_text(json.dumps(result, indent=2))
    print(f"# wrote {out}")
    print()
    print(f"# v0.2 cluster summary (judge-density per category, n_members):")
    for c in clusters_out:
        densities = ", ".join(f"{cat}={c['judge_density'][cat]:.0%}" for cat in JUDGE_CATEGORIES if c['judge_density'][cat] > 0.1)
        print(f"  cluster {c['cluster_id']}: n={c['n_members']:>3}  {densities or '(none > 10%)'}")


if __name__ == "__main__":
    main()
