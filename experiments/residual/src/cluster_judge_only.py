"""Re-cluster agent_chat responses on JUDGE FEATURES ALONE (no embedding).

Addresses v0.2 caveat: in cluster_v02.py the 6 binary judge features got
dwarfed by the 384-dim embedding in k-means distance. Clustering on just
the 6 judge dims should produce cleanly style-separated clusters."""
import json
from collections import Counter
from pathlib import Path
import torch
from sklearn.cluster import KMeans
from .judge_features import JUDGE_CATEGORIES
from .detect import _load_triples_from_disk

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def cluster_on_judge(judge_cache: dict, n_clusters: int = 4, seed: int = 0):
    ids = list(judge_cache.keys())
    M = torch.tensor([[float(judge_cache[i].get(c, 0)) for c in JUDGE_CATEGORIES] for i in ids])
    km = KMeans(n_clusters=n_clusters, random_state=seed, n_init=10)
    labels = km.fit_predict(M.numpy())
    centers = km.cluster_centers_
    return ids, labels, centers


def main() -> None:
    triples_by_id = {t["id"]: t for t in _load_triples_from_disk()}

    for version, cache_name in [("v1.0", "judge_cache_agent_chat.json"),
                                 ("v1.1", "judge_cache_agent_chat_v11.json")]:
        cache_path = RESULTS_DIR / cache_name
        if not cache_path.exists():
            print(f"# missing {cache_path}")
            continue
        cache = json.loads(cache_path.read_text())
        n_clusters = 4
        ids, labels, centers = cluster_on_judge(cache, n_clusters=n_clusters)
        print(f"\n# {version} judge-only clustering (n={len(ids)}, k={n_clusters})")
        for cid in range(n_clusters):
            members_idx = [i for i, l in enumerate(labels) if l == cid]
            if not members_idx:
                continue
            # Center vector = which categories dominate this cluster
            center = centers[cid]
            dominant = [(c, center[i]) for i, c in enumerate(JUDGE_CATEGORIES)]
            dominant.sort(key=lambda x: -x[1])
            label_str = ", ".join(f"{c}={v:.2f}" for c, v in dominant if v > 0.3)
            print(f"  cluster {cid}: n={len(members_idx):>3}  centers: {label_str or '(no dominant)'}")
            # Show a few member ids per cluster
            sample_ids = [ids[i] for i in members_idx[:3]]
            for sid in sample_ids:
                t = triples_by_id.get(sid, {})
                resp = (t.get("agent_chat_response") if version == "v1.0" else "")
                if version == "v1.1":
                    # for v1.1, look up new_response from v11_full.jsonl
                    pass
                print(f"    {sid} [{t.get('domain', '?')}/{t.get('subdomain', '?')[:20]}]")


if __name__ == "__main__":
    main()
