"""Tests for the dual-audience training-data export."""
import json
from pathlib import Path
import pytest
from experiments.residual.src.export_training_data import (
    build_export_rows, write_jsonl,
)


def _toy_results():
    """Synthetic Track A + Track C results matching the on-disk schemas."""
    anomalies = {
        "codex": {
            "agent": "codex",
            "k_lowrank": 5,
            "n_samples": 3,
            "total_valid_rows": 50,
            "matrix_shape": [50, 396],
            "anomalies": [
                {"rank": 1, "id": "qA", "domain": "Physics", "subdomain": "Mechanics",
                 "anomaly_score": 12.5, "sample_prob": 0.03,
                 "top_features": [{"feature": "embedding_total", "abs_residual": 4.2, "max_single_dim": 0.5}],
                 "query_excerpt": "Compute the velocity...",
                 "response_excerpt": "Step 1: F=ma. Answer: B"},
            ],
        },
    }
    disagreements = {
        "agents": ["codex", "claude", "agent_chat"],
        "k_lowrank": 5,
        "n_samples": 3,
        "n_valid_rows": 50,
        "matrix_shape": [50, 1188],
        "per_agent_dim": 396,
        "disagreements": [
            {"rank": 1, "id": "qA", "domain": "Physics", "subdomain": "Mechanics",
             "total_divergence_sq": 50.0, "sample_prob": 0.04,
             "per_agent_divergence": [
                 {"agent": "codex", "divergence_sq": 30.0, "embedding_div_sq": 25.0,
                  "scalar_div_sq": 5.0, "top_scalar_features": [
                      {"feature": "n_self_correction", "abs": 1.5, "signed": 1.5}]},
                 {"agent": "claude", "divergence_sq": 15.0, "embedding_div_sq": 10.0,
                  "scalar_div_sq": 5.0, "top_scalar_features": [
                      {"feature": "response_len", "abs": 0.8, "signed": -0.8}]},
                 {"agent": "agent_chat", "divergence_sq": 5.0, "embedding_div_sq": 3.0,
                  "scalar_div_sq": 2.0, "top_scalar_features": [
                      {"feature": "n_latex", "abs": 0.4, "signed": 0.4}]},
             ],
             "query_excerpt": "Compute the velocity...",
             "responses": {"codex": "Step1...", "claude": "Step1...", "agent_chat": "Step1..."}},
        ],
    }
    return anomalies, disagreements


def test_build_export_rows_returns_unified_records():
    anomalies, disagreements = _toy_results()
    rows = build_export_rows(anomalies, disagreements, min_anomaly_score=0.0)
    assert len(rows) >= 1
    qA = next((r for r in rows if r["id"] == "qA"), None)
    assert qA is not None
    assert qA["query_excerpt"] == "Compute the velocity..."
    assert "domain" in qA
    assert "subdomain" in qA
    assert "anomaly_per_agent" in qA  # which agents found this anomalous, with their scores
    assert "divergence" in qA  # Track C signature
    assert qA["divergence"]["total_sq"] == 50.0
    assert qA["divergence"]["dominant_agent"] == "codex"
    assert "schema_version" in qA


def test_export_records_are_jsonl_serializable(tmp_path: Path):
    anomalies, disagreements = _toy_results()
    rows = build_export_rows(anomalies, disagreements, min_anomaly_score=0.0)
    out = tmp_path / "training.jsonl"
    write_jsonl(rows, out)
    assert out.exists()
    # Re-load each line as JSON.
    for line in out.read_text().splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        assert "id" in obj
        assert "schema_version" in obj


def test_min_anomaly_score_filters():
    anomalies, disagreements = _toy_results()
    # qA has anomaly 12.5; if we require ≥ 100 it should be excluded.
    rows = build_export_rows(anomalies, disagreements, min_anomaly_score=100.0)
    qA_rows = [r for r in rows if r["id"] == "qA"]
    # qA should NOT be in anomaly_per_agent for any agent (score 12.5 < threshold)
    # but it IS still in disagreements (no threshold there). So row exists but
    # anomaly_per_agent is empty.
    if qA_rows:
        assert qA_rows[0]["anomaly_per_agent"] == [] or all(
            ap.get("anomaly_score", 0) >= 100.0 for ap in qA_rows[0]["anomaly_per_agent"]
        )
