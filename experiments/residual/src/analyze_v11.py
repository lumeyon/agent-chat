"""Post-sweep analysis of the v1.1 full-scale revise experiment.

Reads:
  - experiments/residual/results/v11_full.jsonl    (the sweep results)
  - benchmarks/gpqa-diamond/results/agent-chat.jsonl  (v1.0 baseline)
  - benchmarks/gpqa-diamond/results/codex.jsonl
  - benchmarks/gpqa-diamond/results/claude.jsonl
  - experiments/residual/results/clusters_agent_chat.json (for cluster-0 subgroup)

Emits:
  - aggregate FIX/BREAK/STAY-RIGHT/STAY-WRONG counts
  - new paired accuracy: agent-chat-v1.1 vs codex vs claude (using all 198, falling back to v1.0 for un-swept)
  - per-domain breakdown
  - cluster-0 subgroup analysis: did v1.1's prescribed-target (soft-pushback cluster) fix more than non-target cases?
  - top BREAK and FIX cases with response excerpts for qualitative review
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"


def main() -> None:
    v11_path = RESULTS_DIR / "v11_full.jsonl"
    if not v11_path.exists():
        print(f"# missing {v11_path}; sweep not started")
        return
    v11 = [json.loads(l) for l in v11_path.read_text().splitlines() if l.strip()]
    print(f"# v1.1 sweep results: n={len(v11)}")

    counts = Counter(r["outcome"] for r in v11)
    n = len(v11)
    fix = counts.get("FIX", 0); brk = counts.get("BREAK", 0)
    sr = counts.get("STAY-RIGHT", 0); sw = counts.get("STAY-WRONG", 0)
    print(f"  FIX:        {fix}")
    print(f"  BREAK:      {brk}")
    print(f"  STAY-RIGHT: {sr}")
    print(f"  STAY-WRONG: {sw}")
    print(f"  net:        {fix - brk:+d}")
    if n:
        print(f"  mean elapsed: {sum(r['elapsed_ms'] for r in v11) / n / 1000:.1f}s")

    # New paired accuracy.
    ac = {json.loads(l)["id"]: json.loads(l)
          for l in (ROOT / "benchmarks/gpqa-diamond/results/agent-chat.jsonl").read_text().splitlines()
          if l.strip() and not (json.loads(l).get("error") or "").startswith("claude draft cli exited 1: Configuration error")}
    cx = {json.loads(l)["id"]: json.loads(l)
          for l in (ROOT / "benchmarks/gpqa-diamond/results/codex.jsonl").read_text().splitlines() if l.strip()}
    cl = {json.loads(l)["id"]: json.loads(l)
          for l in (ROOT / "benchmarks/gpqa-diamond/results/claude.jsonl").read_text().splitlines() if l.strip()}

    v11_by_id = {r["id"]: r for r in v11}
    paired = sorted(set(ac) & set(cx) & set(cl))
    cx_correct = sum(1 for i in paired if cx[i]["correct"])
    cl_correct = sum(1 for i in paired if cl[i]["correct"])
    ac_correct_v10 = sum(1 for i in paired if ac[i]["correct"])
    # v1.1 effective: use v1.1 result if swept, else fall back to v1.0
    ac_correct_v11 = 0
    for i in paired:
        if i in v11_by_id:
            ac_correct_v11 += int(v11_by_id[i]["new_correct"])
        else:
            ac_correct_v11 += int(ac[i]["correct"])
    n_paired = len(paired)
    print()
    print(f"# Paired accuracy (n={n_paired}):")
    print(f"  codex:           {cx_correct}/{n_paired} = {cx_correct/n_paired*100:.1f}%")
    print(f"  claude:          {cl_correct}/{n_paired} = {cl_correct/n_paired*100:.1f}%")
    print(f"  agent-chat v1.0: {ac_correct_v10}/{n_paired} = {ac_correct_v10/n_paired*100:.1f}%")
    print(f"  agent-chat v1.1: {ac_correct_v11}/{n_paired} = {ac_correct_v11/n_paired*100:.1f}%")
    print(f"  v1.1 lift over v1.0: {ac_correct_v11 - ac_correct_v10:+d}")
    print(f"  v1.1 lift over codex: {ac_correct_v11 - cx_correct:+d}")
    print(f"  v1.1 lift over claude: {ac_correct_v11 - cl_correct:+d}")

    # Per-domain.
    print()
    print(f"# Per-domain v1.1 outcomes:")
    by_dom: dict[str, Counter] = defaultdict(Counter)
    for r in v11:
        d = (r.get("domain") or "?").split("/")[0]
        by_dom[d][r["outcome"]] += 1
    for d in sorted(by_dom):
        c = by_dom[d]
        total = sum(c.values())
        print(f"  {d:12s} (n={total:>3}): FIX={c['FIX']:>2} BREAK={c['BREAK']:>2} STAY-R={c['STAY-RIGHT']:>3} STAY-W={c['STAY-WRONG']:>2}  net={c['FIX']-c['BREAK']:+d}")

    # Cluster-0 subgroup analysis.
    cluster0_ids: set[str] = set()
    cluster_path = RESULTS_DIR / "clusters_agent_chat.json"
    if cluster_path.exists():
        cluster_data = json.loads(cluster_path.read_text())
        # Note: clusters_*.json only stores top-5 exemplars per cluster, not all members.
        # We can compute the full cluster 0 membership by re-running the cluster.py
        # logic; for now use exemplars as a proxy.
        c0_exemplars = cluster_data["clusters"][0]["exemplars"]
        cluster0_ids = {e["id"] for e in c0_exemplars}
        print()
        print(f"# Cluster-0 (soft-pushback) exemplar subgroup analysis:")
        print(f"  Note: only top-5 exemplars stored; smaller subgroup than full 48-member cluster.")
        c0_outcomes = Counter()
        for r in v11:
            if r["id"] in cluster0_ids:
                c0_outcomes[r["outcome"]] += 1
        n_c0 = sum(c0_outcomes.values())
        if n_c0:
            print(f"  n_in_v11_sweep={n_c0}: FIX={c0_outcomes['FIX']} BREAK={c0_outcomes['BREAK']} STAY-R={c0_outcomes['STAY-RIGHT']} STAY-W={c0_outcomes['STAY-WRONG']}")

    # Top BREAK and FIX cases.
    print()
    print(f"# All BREAK cases ({brk}):")
    for r in v11:
        if r["outcome"] == "BREAK":
            print(f"  {r['id']} [{r['domain']}/{r.get('subdomain','?')}] draft={r['draft_letter']} v1.0={r['old_revised_letter']}({r['old_correct']}) → v1.1={r['new_revised_letter']}({r['new_correct']}) expected={r['expected']} peer={r.get('peer','?')}")
    print()
    print(f"# All FIX cases ({fix}):")
    for r in v11:
        if r["outcome"] == "FIX":
            print(f"  {r['id']} [{r['domain']}/{r.get('subdomain','?')}] draft={r['draft_letter']} v1.0={r['old_revised_letter']}({r['old_correct']}) → v1.1={r['new_revised_letter']}({r['new_correct']}) expected={r['expected']} peer={r.get('peer','?')}")

    # Save aggregate JSON
    summary = {
        "n_v11": n,
        "counts": dict(counts),
        "net_correct_change": fix - brk,
        "n_paired": n_paired,
        "codex_correct": cx_correct,
        "claude_correct": cl_correct,
        "agent_chat_v10_correct": ac_correct_v10,
        "agent_chat_v11_correct": ac_correct_v11,
        "v11_lift_over_v10": ac_correct_v11 - ac_correct_v10,
        "v11_lift_over_codex": ac_correct_v11 - cx_correct,
        "per_domain": {d: dict(c) for d, c in by_dom.items()},
    }
    out = RESULTS_DIR / "v11_summary.json"
    out.write_text(json.dumps(summary, indent=2))
    print(f"\n# wrote {out}")


if __name__ == "__main__":
    main()
