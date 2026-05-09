"""Track C — multi-agent boundary scout.

Build a stacked-agent matrix M where each row is one question and the columns are
[agent_1's feature vec | agent_2's feature vec | ... | agent_N's feature vec].

The top-k SVD of M captures the cross-agent CONSENSUS: the dominant subspace is
"what all agents tend to say on this kind of query." Subtract it and the residual
isolates rows where one or more agents diverged from the consensus.

Per-agent decomposition: split the residual row into its per-agent slices and
report ||R_agent_i_slice||² so we can attribute divergence to specific agents.
"""
import json
from pathlib import Path
import torch
from .kernel import residual_sample
from .matrix import build_per_agent_matrix, EMBED_DIM
from .response_features import FEATURE_NAMES


def build_multiagent_matrix(
    triples: list[dict],
    agents: list[str],
    device: str = "cuda",
) -> tuple[torch.Tensor, list[str], int]:
    """Stack per-agent feature matrices side-by-side. Returns (M, agents, per_agent_dim).

    Only includes rows where ALL listed agents have a non-empty response — otherwise
    the missing agent would be a zero block that injects fake "divergence."
    """
    fields = {a: f"{a}_response" for a in agents}
    valid = [t for t in triples if all((t.get(fields[a]) or "").strip() for a in agents)]
    if not valid:
        raise ValueError("no triples have responses from all listed agents")
    blocks = []
    for a in agents:
        blocks.append(build_per_agent_matrix(valid, a, device=device))
    M = torch.cat(blocks, dim=1)
    per_agent_dim = blocks[0].shape[1]
    return M, valid, per_agent_dim


def decompose_per_agent_divergence(
    residual_row: torch.Tensor,
    agents: list[str],
    per_agent_dim: int,
) -> list[dict]:
    """Split a residual row into per-agent ||R_a||² and rank by divergence."""
    contribs = []
    for i, a in enumerate(agents):
        start = i * per_agent_dim
        end = (i + 1) * per_agent_dim
        slice_ = residual_row[start:end]
        # Aggregate scalar features (last len(FEATURE_NAMES)) and embedding span.
        emb_slice = slice_[:EMBED_DIM]
        scalar_slice = slice_[EMBED_DIM:]
        contribs.append({
            "agent": a,
            "divergence_sq": float((slice_ ** 2).sum().item()),
            "embedding_div_sq": float((emb_slice ** 2).sum().item()),
            "scalar_div_sq": float((scalar_slice ** 2).sum().item()),
            "top_scalar_features": _top_scalar_contribs(scalar_slice, top=3),
        })
    contribs.sort(key=lambda c: c["divergence_sq"], reverse=True)
    return contribs


def _top_scalar_contribs(scalar_slice: torch.Tensor, top: int) -> list[dict]:
    abs_r = scalar_slice.abs()
    pairs = [(name, float(abs_r[i].item()), float(scalar_slice[i].item()))
             for i, name in enumerate(FEATURE_NAMES)]
    pairs.sort(key=lambda x: x[1], reverse=True)
    return [{"feature": n, "abs": a, "signed": s} for n, a, s in pairs[:top]]


def scout_boundary(
    triples: list[dict],
    agents: list[str],
    k: int = 5,
    n_samples: int = 20,
    device: str = "cuda",
    seed: int = 0,
) -> dict:
    """Build multi-agent matrix, sample residuals, decompose per-agent."""
    M, valid, per_agent_dim = build_multiagent_matrix(triples, agents, device=device)
    indices, residuals, probs = residual_sample(M, k=k, n_samples=n_samples, seed=seed)
    out = []
    for rank, (idx, res_row, p) in enumerate(zip(indices.tolist(), residuals, probs.tolist())):
        t = valid[idx]
        decomp = decompose_per_agent_divergence(res_row, agents, per_agent_dim)
        out.append({
            "rank": rank + 1,
            "id": t["id"],
            "domain": t.get("domain", ""),
            "subdomain": t.get("subdomain", ""),
            "total_divergence_sq": float(res_row.norm().item() ** 2),
            "sample_prob": float(p),
            "per_agent_divergence": decomp,
            "query_excerpt": (t.get("query", "") or "")[:300],
            "responses": {a: (t.get(f"{a}_response", "") or "")[:400] for a in agents},
        })
    return {
        "agents": agents,
        "k_lowrank": k,
        "n_samples": n_samples,
        "n_valid_rows": len(valid),
        "matrix_shape": list(M.shape),
        "per_agent_dim": per_agent_dim,
        "disagreements": out,
    }


def main() -> None:
    from .detect import _load_triples_from_disk, RESULTS_DIR
    triples = _load_triples_from_disk()
    print(f"# loaded {len(triples)} triples")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")
    agents = ["codex", "claude", "agent_chat"]
    result = scout_boundary(triples, agents, k=5, n_samples=20, device=device)
    out = RESULTS_DIR / "disagreements.json"
    out.write_text(json.dumps(result, indent=2))
    print(f"# wrote {out}  (matrix={result['matrix_shape']}, n_valid={result['n_valid_rows']})")

    # Human-readable digest appended to summary.md.
    summary = RESULTS_DIR / "summary.md"
    existing = summary.read_text() if summary.exists() else ""
    lines = ["\n## Track C — multi-agent boundary scout (codex × claude × agent_chat)\n"]
    lines.append(f"matrix shape {result['matrix_shape']}, per-agent dim {result['per_agent_dim']}, k={result['k_lowrank']}\n")
    for d in result["disagreements"][:15]:
        per = " ".join(f"{c['agent']}={c['divergence_sq']:.1f}" for c in d["per_agent_divergence"])
        lines.append(
            f"- **{d['id']}** [{d['domain']}/{d['subdomain']}] total={d['total_divergence_sq']:.1f}  → {per}"
        )
        for c in d["per_agent_divergence"]:
            top = ", ".join(f"{f['feature']}({f['signed']:+.2f})" for f in c["top_scalar_features"])
            lines.append(f"    - {c['agent']}: {top}")
    summary.write_text(existing + "\n".join(lines))
    print(f"# appended Track C section to {summary}")


if __name__ == "__main__":
    main()
