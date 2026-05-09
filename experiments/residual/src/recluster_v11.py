"""Recursive substrate use: apply Track A clustering to the v1.1 revise responses.

Question: did the substrate-prescribed v1.1 prompt fix actually eliminate the
soft-pushback cluster, or just suppress its numerical cost?

Build a synthetic agent_chat-v1.1 triple list where each entry's response is
the v1.1 NEW response (not the v1.0 response). Run cluster_per_agent. Compare
the cluster structure to the original v1.0 clusters.

If cluster 0 (soft-pushback) shrinks dramatically → the fix worked structurally.
If cluster 0 persists → orion still produces the pattern even with the v1.1
prompt; the fix only changed final-letter outcomes.
"""
import json
from pathlib import Path
import torch
from .cluster import cluster_per_agent
from .response_features import FEATURE_NAMES

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def main() -> None:
    v11_path = RESULTS_DIR / "v11_full.jsonl"
    if not v11_path.exists():
        print(f"# missing {v11_path}; run v1.1 sweep first")
        return
    v11 = [json.loads(l) for l in v11_path.read_text().splitlines() if l.strip()]
    print(f"# loaded {len(v11)} v1.1 results")

    # Synthesize triples where agent_chat_response = the v1.1 new_response.
    triples = [
        {
            "id": r["id"],
            "domain": r["domain"],
            "subdomain": r["subdomain"],
            "query": "",  # unused by clustering
            "agent_chat_response": r["new_response"],
        }
        for r in v11
        if r.get("new_response")
    ]
    print(f"# {len(triples)} valid v1.1 responses to cluster")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")

    result = cluster_per_agent(triples, agent="agent_chat", k_lowrank=5,
                               n_clusters=4, device=device)
    out = RESULTS_DIR / "clusters_agent_chat_v11.json"
    out.write_text(json.dumps(result, indent=2))
    print(f"# wrote {out}")

    # Also load the v1.0 clusters for comparison.
    v10_path = RESULTS_DIR / "clusters_agent_chat.json"
    v10 = json.loads(v10_path.read_text())

    print()
    print("# === COMPARISON: agent_chat clusters BEFORE (v1.0) vs AFTER (v1.1) ===")
    print(f"#   v1.0: n_total={v10['n_total_rows']}, n_high_residual={v10['n_high_residual']}")
    print(f"#   v1.1: n_total={result['n_total_rows']}, n_high_residual={result['n_high_residual']}")
    print()
    print(f"# v1.0 clusters:")
    for c in v10["clusters"]:
        sig = ", ".join(f"{f['feature']}({f['mean_signed']:+.2f})" for f in c["signature"][:3])
        print(f"  cluster {c['cluster_id']}: n={c['n_members']:>3}  top: {sig}")
    print()
    print(f"# v1.1 clusters:")
    for c in result["clusters"]:
        sig = ", ".join(f"{f['feature']}({f['mean_signed']:+.2f})" for f in c["signature"][:3])
        print(f"  cluster {c['cluster_id']}: n={c['n_members']:>3}  top: {sig}")

    # Try to identify which v1.1 cluster (if any) corresponds to the soft-pushback signature
    # (high n_self_correction, low n_certainty_words).
    print()
    print("# Searching for soft-pushback cluster in v1.1...")
    for c in result["clusters"]:
        sig_dict = {f["feature"]: f["mean_signed"] for f in c["signature"]}
        sc = sig_dict.get("n_self_correction", 0)
        cw = sig_dict.get("n_certainty_words", 0)
        if sc > 0.2 and cw < -0.2:
            print(f"  cluster {c['cluster_id']} (n={c['n_members']}) STILL matches soft-pushback signature: n_self_correction({sc:+.2f}), n_certainty_words({cw:+.2f})")
        else:
            print(f"  cluster {c['cluster_id']} (n={c['n_members']}) does NOT match: n_self_correction({sc:+.2f}), n_certainty_words({cw:+.2f})")


if __name__ == "__main__":
    main()
