"""Tests for exploration.feature_extractor — extract features per candidate."""
import torch
from experiments.substrate.src.exploration.feature_extractor import (
    extract_scalar_features, build_candidate_features, FEATURE_NAMES,
)


def test_scalar_extractor_returns_finite_dict():
    text = "Reasoning here.\n\nAnswer: B"
    f = extract_scalar_features(text)
    for k, v in f.items():
        assert v == v  # NaN check
        assert isinstance(v, (int, float))


def test_features_named_consistently():
    text = "Some text"
    f = extract_scalar_features(text)
    for name in FEATURE_NAMES:
        assert name in f, f"missing feature: {name}"


def test_build_candidate_features_returns_correct_shape():
    """N=4 candidates → matrix of shape (4, embed_dim + len(FEATURE_NAMES))."""
    candidates = [
        "Some answer text.",
        "Another response.",
        "Third one.",
        "Fourth.",
    ]
    M = build_candidate_features(candidates, device="cpu")
    assert M.shape[0] == 4
    assert M.shape[1] >= 384  # at least the embedding dim
    assert M.shape[1] == 384 + len(FEATURE_NAMES)


def test_features_differ_across_different_responses():
    """Different responses should produce different feature vectors."""
    candidates = [
        "Short.",
        "Much longer answer with reasoning that goes on and on. Answer: A",
    ]
    M = build_candidate_features(candidates, device="cpu")
    assert not torch.allclose(M[0], M[1])
