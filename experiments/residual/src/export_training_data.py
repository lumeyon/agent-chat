"""Dual-audience training-data export.

Reads the Track A per-agent anomaly results and the Track C multi-agent
disagreement results, and produces a unified JSONL where each row is
ONE QUESTION with all available residual signal:

  {
    "id": "...",
    "domain": "...",
    "subdomain": "...",
    "query_excerpt": "...",
    "responses": {agent: response_text, ...},   # from Track C
    "anomaly_per_agent": [                        # from Track A
        {"agent": "codex", "anomaly_score": 54.3,
         "top_features": [...]},
        ...
    ],
    "divergence": {                               # from Track C
        "total_sq": 228.4,
        "dominant_agent": "codex",
        "per_agent": [{"agent": "codex", "divergence_sq": 156.1, ...}, ...]
    },
    "schema_version": "residual-v0.1",
  }

This is the artifact suitable for:
  - the Apprenticeship Substrate as study material (each row = one teaching point)
  - AI-training-data buyers (each row = one labeled "interesting prompt" with
    multi-agent responses + signed divergence breakdown)

Both audiences consume the same file, satisfying the dual-audience-fusion
design rule (every artifact serves agents AND data buyers)."""
import json
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"
SCHEMA_VERSION = "residual-v0.1"


def build_export_rows(
    anomalies: dict[str, dict] | dict,
    disagreements: dict,
    min_anomaly_score: float = 0.0,
) -> list[dict]:
    """Merge Track A + Track C results by id.

    `anomalies` may be either:
      (a) a single Track A result dict (with "agent" and "anomalies"), or
      (b) a dict mapping agent name -> Track A result dict.
    """
    # Normalize anomalies to dict-by-agent.
    if "agent" in anomalies and "anomalies" in anomalies:
        per_agent = {anomalies["agent"]: anomalies}
    else:
        per_agent = anomalies  # type: ignore

    # Build id -> per-agent anomaly list (filtered by score threshold).
    by_id_anomalies: dict[str, list[dict]] = {}
    for agent_name, result in per_agent.items():
        for a in result.get("anomalies", []):
            if a["anomaly_score"] < min_anomaly_score:
                continue
            entry = {
                "agent": agent_name,
                "anomaly_score": a["anomaly_score"],
                "rank_within_agent": a["rank"],
                "top_features": a["top_features"],
            }
            by_id_anomalies.setdefault(a["id"], []).append(entry)

    # Build id -> Track C entry.
    by_id_disagreement = {d["id"]: d for d in disagreements.get("disagreements", [])}

    # Union of ids from both sources.
    all_ids = set(by_id_anomalies) | set(by_id_disagreement)
    rows = []
    for qid in sorted(all_ids):
        d = by_id_disagreement.get(qid)
        # Fall back to first anomaly's metadata if no Track C entry.
        if d is None:
            first = by_id_anomalies[qid][0]
            row = {
                "id": qid,
                "domain": "",
                "subdomain": "",
                "query_excerpt": "",
                "responses": {},
                "anomaly_per_agent": by_id_anomalies.get(qid, []),
                "divergence": None,
                "schema_version": SCHEMA_VERSION,
            }
        else:
            per_agent_div = d["per_agent_divergence"]
            row = {
                "id": qid,
                "domain": d.get("domain", ""),
                "subdomain": d.get("subdomain", ""),
                "query_excerpt": d.get("query_excerpt", ""),
                "responses": d.get("responses", {}),
                "anomaly_per_agent": by_id_anomalies.get(qid, []),
                "divergence": {
                    "total_sq": d["total_divergence_sq"],
                    "dominant_agent": per_agent_div[0]["agent"],
                    "rank_within_disagreements": d["rank"],
                    "per_agent": per_agent_div,
                },
                "schema_version": SCHEMA_VERSION,
            }
        rows.append(row)
    return rows


def write_jsonl(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def _enrich_with_source_data(rows: list[dict]) -> None:
    """For rows with empty domain/responses (Track A only, no Track C entry),
    look up from the source triples and the original baseline JSONL files."""
    from .detect import _load_triples_from_disk
    triples = {t["id"]: t for t in _load_triples_from_disk()}
    for row in rows:
        if row.get("domain"):
            continue  # already enriched from Track C
        t = triples.get(row["id"])
        if t is None:
            continue
        row["domain"] = t.get("domain", "")
        row["subdomain"] = t.get("subdomain", "")
        row["query_excerpt"] = (t.get("query") or "")[:300]
        row["responses"] = {
            agent: (t.get(f"{agent}_response") or "")[:400]
            for agent in ("codex", "claude", "agent_chat")
            if t.get(f"{agent}_response")
        }


def main() -> None:
    # Load all available Track A results.
    anomalies: dict[str, dict] = {}
    for agent in ("codex", "claude", "agent_chat"):
        p = RESULTS_DIR / f"anomalies_{agent}.json"
        if p.exists():
            anomalies[agent] = json.loads(p.read_text())
    disagreements_path = RESULTS_DIR / "disagreements.json"
    if not disagreements_path.exists():
        print(f"# missing {disagreements_path}; run boundary.py first")
        return
    disagreements = json.loads(disagreements_path.read_text())

    rows = build_export_rows(anomalies, disagreements, min_anomaly_score=0.0)
    _enrich_with_source_data(rows)
    out = RESULTS_DIR / "training_data.jsonl"
    write_jsonl(rows, out)

    # Summary stats.
    n_with_anomaly = sum(1 for r in rows if r["anomaly_per_agent"])
    n_with_divergence = sum(1 for r in rows if r["divergence"])
    n_both = sum(1 for r in rows if r["anomaly_per_agent"] and r["divergence"])
    print(f"# wrote {out}")
    print(f"# total rows: {len(rows)}")
    print(f"# rows with Track A anomaly entry: {n_with_anomaly}")
    print(f"# rows with Track C divergence entry: {n_with_divergence}")
    print(f"# rows with BOTH (high-confidence interesting): {n_both}")
    print()
    print(f"# top 5 by total divergence:")
    by_div = sorted([r for r in rows if r["divergence"]],
                    key=lambda r: r["divergence"]["total_sq"], reverse=True)[:5]
    for r in by_div:
        ap_summary = ",".join(ap["agent"] for ap in r["anomaly_per_agent"]) or "(none)"
        print(f"  {r['id']} [{r['domain']}] div={r['divergence']['total_sq']:.1f} dominant={r['divergence']['dominant_agent']} also-flagged-by: {ap_summary}")


if __name__ == "__main__":
    main()
