"""Tests for data loader. JOIN problems + codex + claude (+ agent-chat) results by id."""
from experiments.router.src.data import load_triples, count_correct


def test_load_triples_returns_198_rows():
    triples = load_triples()
    assert len(triples) == 198, f"expected 198 paired rows, got {len(triples)}"


def test_each_triple_has_required_fields():
    triples = load_triples()
    required = {"id", "domain", "subdomain", "query", "answer_letter", "codex_correct", "claude_correct"}
    for t in triples:
        assert required <= set(t.keys()), f"missing fields in {t['id']}: {required - set(t.keys())}"


def test_codex_baseline_accuracy_matches_score_ts():
    """codex baseline on full 198 should be 177/198 (89.4%) per locked baseline."""
    triples = load_triples()
    n_correct = count_correct(triples, "codex")
    assert n_correct == 177, f"expected codex 177/198 per locked baseline, got {n_correct}/198"


def test_claude_baseline_accuracy_matches_score_ts():
    """claude baseline on full 198 should be 176/198 (88.9%) per locked baseline."""
    triples = load_triples()
    n_correct = count_correct(triples, "claude")
    assert n_correct == 176, f"expected claude 176/198 per locked baseline, got {n_correct}/198"


def test_query_strings_are_nonempty():
    triples = load_triples()
    for t in triples:
        assert t["query"] and len(t["query"]) > 50, f"query too short for {t['id']}"


def test_domain_values_are_canonical():
    triples = load_triples()
    domains = {t["domain"] for t in triples}
    assert domains <= {"Physics", "Chemistry", "Biology"}, f"unexpected domains: {domains}"
