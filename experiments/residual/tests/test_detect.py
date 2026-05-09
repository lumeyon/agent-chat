"""End-to-end smoke test of the anomaly detection pipeline."""
import torch
from experiments.residual.src.detect import detect_anomalies


def test_detect_returns_expected_shape():
    triples = [
        {"id": f"q{i}", "domain": "Physics", "subdomain": "Mechanics",
         "query": f"Question number {i} about physics.",
         "codex_response": f"Standard reasoning {i}. Answer: A",
         "claude_response": f"Standard reasoning {i}. Answer: A",
         "agent_chat_response": f"Standard reasoning {i}. Answer: A"}
        for i in range(20)
    ]
    # Plant one obviously-anomalous response (very long, full of self-correction).
    triples[7]["codex_response"] = (
        "Wait. Actually, let me reconsider. " * 30 +
        "But on second thought, possibly maybe perhaps... " * 20 +
        "Answer: B"
    )
    # k=1 because with only 20 rows (19 ~identical + 1 anomaly), k=2 absorbs the anomaly
    # into the second singular component. On real data with hundreds of diverse rows, k=5
    # is fine.
    result = detect_anomalies(triples, agent="codex", k=1, n_samples=5, device="cpu")
    assert "anomalies" in result
    assert len(result["anomalies"]) == 5
    # The planted long-self-correcting row should be in the top-5.
    ids = [a["id"] for a in result["anomalies"]]
    assert "q7" in ids, f"expected planted anomaly q7 in top-5, got {ids}"
    for a in result["anomalies"]:
        assert "anomaly_score" in a
        assert a["anomaly_score"] >= 0
