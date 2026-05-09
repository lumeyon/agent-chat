"""Tests for response feature extraction."""
import torch
from experiments.residual.src.response_features import (
    extract_scalar_features, FEATURE_NAMES, build_feature_vector,
)


def test_scalar_features_on_canonical_response():
    text = (
        "Looking at this carefully, I think the answer is **possibly** A.\n"
        "Wait, actually let me reconsider. $E = mc^2$ gives us...\n"
        "```python\nx = 1\n```\n"
        "Clearly the answer is B.\n\n"
        "Answer: B"
    )
    f = extract_scalar_features(text)
    assert f["response_len"] == len(text)
    assert f["n_latex"] == 1, f"expected 1 latex, got {f['n_latex']}"
    assert f["n_codeblocks"] == 1
    assert f["n_hedge_words"] >= 1   # "possibly"
    assert f["n_certainty_words"] >= 1  # "Clearly"
    assert f["n_self_correction"] >= 2  # "Wait", "actually"
    assert f["n_questions"] == 0
    assert f["final_letter"] == "B"


def test_scalar_features_on_empty_response_returns_finite():
    f = extract_scalar_features("")
    for name, val in f.items():
        if isinstance(val, (int, float)):
            assert val == 0 or val == 0.0, f"{name} should be 0, got {val}"
    assert f["final_letter"] is None


def test_build_feature_vector_dim_is_documented():
    text = "Answer: A"
    embedding = torch.zeros(384)
    v = build_feature_vector(text, embedding)
    expected = 384 + len(FEATURE_NAMES)
    assert v.shape == (expected,), f"expected {expected}, got {v.shape}"
    assert torch.isfinite(v).all()


def test_letter_one_hot_inside_vector():
    text = "Final answer:\n\nAnswer: D"
    embedding = torch.zeros(384)
    v = build_feature_vector(text, embedding)
    # Find the slot corresponding to letter_D in FEATURE_NAMES
    idx_D = 384 + FEATURE_NAMES.index("letter_D")
    idx_A = 384 + FEATURE_NAMES.index("letter_A")
    assert v[idx_D].item() == 1.0
    assert v[idx_A].item() == 0.0
