"""Tests for query embedding + feature vector assembly."""
import torch
from experiments.router.src.featurize import embed_queries, build_features
from experiments.router.src.data import load_triples


def test_embed_queries_returns_correct_shape():
    qs = ["What is 2+2?", "Define mitosis."]
    embs = embed_queries(qs)
    assert isinstance(embs, torch.Tensor)
    assert embs.shape == (2, 384), f"expected (2,384), got {tuple(embs.shape)}"
    assert torch.isfinite(embs).all()


def test_build_features_doubles_rows_per_expert():
    triples = load_triples()
    embs = embed_queries([t["query"] for t in triples])
    X, y, meta = build_features(triples, embs)
    assert X.shape[0] == 2 * len(triples), f"expected {2*len(triples)} rows (one per expert), got {X.shape[0]}"
    assert y.shape == (X.shape[0],)


def test_feature_dim_is_documented():
    triples = load_triples()
    embs = embed_queries([t["query"] for t in triples])
    X, y, meta = build_features(triples, embs)
    expected = 384 + 3 + meta["n_subdomains"] + 2  # embed + domain + subdomain + expert
    assert X.shape[1] == expected, f"feature dim mismatch: got {X.shape[1]} expected {expected}"


def test_labels_match_triples():
    triples = load_triples()
    embs = embed_queries([t["query"] for t in triples])
    X, y, meta = build_features(triples, embs)
    n_correct_codex = int(y[meta["expert_idx"]["codex"]::2].sum().item())
    assert n_correct_codex == 177, f"codex correct count via y mismatched: {n_correct_codex}"
