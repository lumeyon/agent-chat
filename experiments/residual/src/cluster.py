"""Cluster residual rows to find distinct anomaly STYLES per agent.

Run k-means on the full residual matrix (not just sampled rows). Each cluster
captures a coherent "way of deviating from typical" — refusal-adjacent,
code-heavy, hedge-heavy, self-correction-heavy, etc.

This validates the rigor of Track A: structured clusters → real signal.
Random scatter → just noise. The output is also study material for the
Apprenticeship Substrate (each cluster is one teachable failure mode).
"""
import json
from pathlib import Path
import torch
from sklearn.cluster import KMeans
from .matrix import build_per_agent_matrix, EMBED_DIM
from .response_features import FEATURE_NAMES
from .kernel import residual_sample
from .detect import _load_triples_from_disk

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def cluster_residuals(R: torch.Tensor, k: int, seed: int = 0) -> list[int]:
    """k-means cluster row vectors. Returns one label per row."""
    if R.shape[0] < k:
        raise ValueError(f"can't form {k} clusters from {R.shape[0]} rows")
    km = KMeans(n_clusters=k, random_state=seed, n_init=10)
    return km.fit_predict(R.cpu().numpy()).tolist()


def characterize_cluster(rows: torch.Tensor, feature_names: list[str], top: int = 5) -> list[dict]:
    """For a cluster of residual rows (in scalar-feature subspace), return the
    top-N features by mean absolute value across the cluster."""
    abs_mean = rows.abs().mean(dim=0)
    pairs = [
        {"feature": name, "mean_abs": float(abs_mean[i].item()),
         "mean_signed": float(rows[:, i].mean().item())}
        for i, name in enumerate(feature_names)
    ]
    pairs.sort(key=lambda p: p["mean_abs"], reverse=True)
    return pairs[:top]


def cluster_per_agent(
    triples: list[dict],
    agent: str,
    k_lowrank: int = 5,
    n_clusters: int = 4,
    device: str = "cuda",
    seed: int = 0,
) -> dict:
    """End-to-end: build per-agent matrix, compute residuals against top-k SVD,
    cluster the residuals, characterize each cluster.

    Returns a dict with cluster assignments and per-cluster feature signatures."""
    field = f"{agent}_response"
    valid = [t for t in triples if t.get(field)]
    M = build_per_agent_matrix(valid, agent, device=device)
    # Compute residual matrix R for ALL rows (not just sampled).
    Mc = M.float() - M.float().mean(dim=0, keepdim=True)
    U, S, Vh = torch.linalg.svd(Mc, full_matrices=False)
    M_k = U[:, :k_lowrank] @ torch.diag(S[:k_lowrank]) @ Vh[:k_lowrank, :]
    R = (M.float() - M_k)
    norms_sq = (R ** 2).sum(dim=1)
    # Cluster only the rows above the median residual norm — the "typical" rows
    # contribute noise to clustering.
    threshold = norms_sq.median().item()
    high_residual_mask = (norms_sq > threshold)
    high_idx = torch.where(high_residual_mask)[0].tolist()
    R_high = R[high_idx]
    if R_high.shape[0] < n_clusters:
        return {"agent": agent, "n_high_residual": int(R_high.shape[0]),
                "error": "too few high-residual rows for clustering"}

    labels = cluster_residuals(R_high, k=n_clusters, seed=seed)
    # Characterize each cluster's scalar-feature profile (skip the embedding
    # span — it's not human-interpretable).
    scalar_R_high = R_high[:, EMBED_DIM:]
    clusters = []
    for cid in range(n_clusters):
        member_mask = [l == cid for l in labels]
        member_local = [i for i, m in enumerate(member_mask) if m]
        if not member_local:
            continue
        # Map back to global triple ids.
        member_global = [high_idx[i] for i in member_local]
        member_rows = scalar_R_high[member_local]
        signature = characterize_cluster(member_rows, FEATURE_NAMES, top=4)
        # Sample 3 example query ids from the cluster, sorted by within-cluster
        # residual norm (most extreme).
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
                "response_excerpt": (t.get(field) or "")[:200],
            })
        clusters.append({
            "cluster_id": cid,
            "n_members": len(member_local),
            "signature": signature,
            "exemplars": exemplars,
        })
    return {
        "agent": agent,
        "k_lowrank": k_lowrank,
        "n_clusters": n_clusters,
        "n_total_rows": int(M.shape[0]),
        "n_high_residual": int(R_high.shape[0]),
        "residual_norm_sq_threshold": float(threshold),
        "clusters": clusters,
    }


def main() -> None:
    triples = _load_triples_from_disk()
    print(f"# loaded {len(triples)} triples")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")

    summary_lines = ["\n## Anomaly clusters (per-agent k-means on residuals)\n"]
    for agent in ("codex", "claude", "agent_chat"):
        if not any(t.get(f"{agent}_response") for t in triples):
            continue
        result = cluster_per_agent(triples, agent, k_lowrank=5, n_clusters=4, device=device)
        out = RESULTS_DIR / f"clusters_{agent}.json"
        out.write_text(json.dumps(result, indent=2))
        print(f"# wrote {out}")

        summary_lines.append(f"\n### {agent} clusters (k_lowrank=5, n_clusters=4)\n")
        if "clusters" not in result:
            summary_lines.append(f"- (skipped: {result.get('error', 'unknown')})\n")
            continue
        for c in result["clusters"]:
            top = ", ".join(f"{f['feature']}({f['mean_signed']:+.2f})" for f in c["signature"])
            summary_lines.append(f"- **cluster {c['cluster_id']}** (n={c['n_members']}): {top}")
            for e in c["exemplars"][:2]:
                summary_lines.append(f"    - `{e['id']}` [{e['domain']}/{e['subdomain']}]: {e['response_excerpt'][:100]!r}")

    summary = RESULTS_DIR / "summary.md"
    existing = summary.read_text() if summary.exists() else ""
    summary.write_text(existing + "\n".join(summary_lines))
    print(f"# appended cluster section to {summary}")


if __name__ == "__main__":
    main()
