"""Anomaly detection pipeline: load triples → featurize → residual_sample → report."""
import json
from pathlib import Path
from typing import Optional
import torch
from .kernel import residual_sample
from .matrix import build_per_agent_matrix
from .explain import explain_residual

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def detect_anomalies(
    triples: list[dict],
    agent: str,
    k: int = 5,
    n_samples: int = 20,
    device: str = "cuda",
    seed: int = 0,
) -> dict:
    """Build M, sample residuals, return ranked anomalies with explanations.
    Skips rows whose response field is empty (agent didn't answer)."""
    field = f"{agent}_response"
    valid = [t for t in triples if t.get(field)]
    if len(valid) < n_samples + 5:
        raise ValueError(f"only {len(valid)} valid responses for {agent}; need ≥ {n_samples+5}")
    M = build_per_agent_matrix(valid, agent, device=device)
    indices, residuals, probs = residual_sample(M, k=k, n_samples=n_samples, seed=seed)
    anomalies = []
    for i_local, (idx, res_row, p) in enumerate(zip(indices.tolist(), residuals, probs.tolist())):
        t = valid[idx]
        contrib = explain_residual(res_row, top=4)
        anomalies.append({
            "rank": i_local + 1,
            "id": t["id"],
            "domain": t.get("domain", ""),
            "subdomain": t.get("subdomain", ""),
            "anomaly_score": float(res_row.norm().item() ** 2),
            "sample_prob": float(p),
            "top_features": contrib,
            "query_excerpt": (t.get("query", "") or "")[:300],
            "response_excerpt": (t.get(field, "") or "")[:600],
        })
    return {
        "agent": agent,
        "k_lowrank": k,
        "n_samples": n_samples,
        "total_valid_rows": len(valid),
        "matrix_shape": list(M.shape),
        "anomalies": anomalies,
    }


def _load_triples_from_disk() -> list[dict]:
    """Reuse router's triple loader, then attach response prose from each baseline file."""
    from experiments.router.src.data import load_triples as _base_load
    triples = _base_load()
    # Re-load the actual response strings (router's loader strips them).
    by_id = {t["id"]: t for t in triples}
    for name in ("codex", "claude"):
        path = ROOT / "benchmarks" / "gpqa-diamond" / "results" / f"{name}.jsonl"
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r["id"] in by_id:
                by_id[r["id"]][f"{name}_response"] = r.get("response", "") or ""
    # Agent-chat: pull revised response (final answer text), tolerate disk-fill polluted rows.
    DISK_FILL_MARKER = "claude draft cli exited 1: Configuration error"
    ac_path = ROOT / "benchmarks" / "gpqa-diamond" / "results" / "agent-chat.jsonl"
    for line in ac_path.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if (r.get("error") or "").startswith(DISK_FILL_MARKER):
            continue
        if r["id"] in by_id:
            by_id[r["id"]]["agent_chat_response"] = r.get("claude_revised_response", "") or ""
    return list(by_id.values())


def main() -> None:
    triples = _load_triples_from_disk()
    print(f"# loaded {len(triples)} triples")
    print(f"#   with codex response:      {sum(1 for t in triples if t.get('codex_response'))}")
    print(f"#   with claude response:     {sum(1 for t in triples if t.get('claude_response'))}")
    print(f"#   with agent-chat response: {sum(1 for t in triples if t.get('agent_chat_response'))}")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")
    summary_lines = ["# Track A anomaly summary\n"]
    for agent in ("codex", "claude", "agent_chat"):
        if not any(t.get(f"{agent}_response") for t in triples):
            print(f"# skipping {agent}: no responses")
            continue
        result = detect_anomalies(triples, agent=agent, k=5, n_samples=20, device=device)
        out = RESULTS_DIR / f"anomalies_{agent}.json"
        out.write_text(json.dumps(result, indent=2))
        print(f"# wrote {out}  (matrix={result['matrix_shape']}, n_valid={result['total_valid_rows']})")
        summary_lines.append(f"\n## {agent} top-20 anomalies (k={result['k_lowrank']}, matrix shape {result['matrix_shape']})\n")
        for a in result["anomalies"][:10]:
            top_named = [c["feature"] for c in a["top_features"]]
            summary_lines.append(
                f"- **{a['id']}** [{a['domain']}/{a['subdomain']}] score={a['anomaly_score']:.2f} "
                f"top features: `{', '.join(top_named)}`"
            )
            summary_lines.append(f"  - response: `{a['response_excerpt'][:160]!r}`")
    (RESULTS_DIR / "summary.md").write_text("\n".join(summary_lines))
    print(f"# wrote {RESULTS_DIR / 'summary.md'}")


if __name__ == "__main__":
    main()
