"""Tests for the study-card formatter (Apprenticeship Substrate bridge)."""
import json
from pathlib import Path
from experiments.residual.src.study_cards import (
    build_study_card_markdown, name_failure_mode, cross_agent_query_overlap,
)


def _toy_cluster_data():
    return {
        "agent": "agent_chat",
        "k_lowrank": 5,
        "n_clusters": 4,
        "n_total_rows": 194,
        "n_high_residual": 97,
        "clusters": [
            {
                "cluster_id": 0,
                "n_members": 48,
                "signature": [
                    {"feature": "n_self_correction", "mean_abs": 0.44, "mean_signed": 0.44},
                    {"feature": "n_certainty_words", "mean_abs": 0.71, "mean_signed": -0.71},
                    {"feature": "response_len", "mean_abs": 0.24, "mean_signed": 0.24},
                ],
                "exemplars": [
                    {"id": "qA1", "domain": "Chemistry", "subdomain": "Organic",
                     "residual_norm_sq": 5.5,
                     "response_excerpt": "Re-examining this with the peer's critique in mind..."},
                    {"id": "qA2", "domain": "Chemistry", "subdomain": "Organic",
                     "residual_norm_sq": 4.2,
                     "response_excerpt": "The peer reviewer raises a valid point. Let me redo..."},
                ],
            },
        ],
    }


def test_build_study_card_returns_markdown():
    data = _toy_cluster_data()
    md = build_study_card_markdown(data, cluster_idx=0)
    assert "# Study Card" in md
    assert "agent_chat" in md
    assert "n=48" in md or "48 / 97" in md
    assert "n_self_correction" in md
    assert "qA1" in md  # exemplar id appears
    assert "## Lesson" in md or "## What to learn" in md.replace("# What", "## What")


def test_name_failure_mode_returns_human_readable_label():
    """For the agent_chat cluster 0 signature, return a sensible name."""
    sig = [
        {"feature": "n_self_correction", "mean_signed": 0.44},
        {"feature": "n_certainty_words", "mean_signed": -0.71},
    ]
    name = name_failure_mode(sig)
    # Should mention the dominant feature axis somehow.
    assert any(t in name.lower() for t in ["self-correction", "certainty", "soft-pushback", "deferral"])


def test_cross_agent_query_overlap_finds_shared_anomalies():
    """If qA appears in cluster X of codex AND cluster Y of claude, the
    overlap analyzer should return that pair."""
    by_agent = {
        "codex": {"clusters": [
            {"cluster_id": 0, "exemplars": [{"id": "shared1"}, {"id": "cx_only"}]},
            {"cluster_id": 1, "exemplars": [{"id": "shared2"}]},
        ]},
        "claude": {"clusters": [
            {"cluster_id": 0, "exemplars": [{"id": "shared1"}, {"id": "cl_only"}]},
            {"cluster_id": 1, "exemplars": [{"id": "shared2"}]},
        ]},
    }
    overlaps = cross_agent_query_overlap(by_agent)
    # shared1 appears in both agents' cluster 0 → overlap entry
    shared = [o for o in overlaps if o["query_id"] == "shared1"]
    assert shared
    assert {a["agent"] for a in shared[0]["found_in"]} == {"codex", "claude"}
