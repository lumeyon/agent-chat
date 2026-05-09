"""Tests for evaluation utilities."""
from experiments.router.src.eval import oracle_ceiling, domain_argmax_router
from experiments.router.src.data import load_triples


def test_oracle_ceiling_matches_prior_NL40_number():
    """Oracle (max-of-2 expert) on full 198 must reproduce NL40 ceiling."""
    triples = load_triples()
    n_correct, n_total = oracle_ceiling(triples)
    assert n_total == 198
    pct = n_correct / n_total * 100
    assert 93.0 <= pct <= 97.0, f"oracle ceiling outside expected band: {pct:.1f}%"


def test_domain_argmax_beats_codex_alone():
    """Trivial domain-router lift over codex_solo on full 198."""
    triples = load_triples()
    router_correct = domain_argmax_router(triples)
    codex_correct = sum(1 for t in triples if t["codex_correct"])
    assert router_correct >= codex_correct, f"domain-router {router_correct} should >= codex {codex_correct}"
