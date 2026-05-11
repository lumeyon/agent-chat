"""Tests for verifier.qa_verifier — MCQ letter-match scoring."""
from experiments.substrate.src.verifier.base import VerifierResult
from experiments.substrate.src.verifier.qa_verifier import (
    QAVerifier, extract_answer_letter,
)


def test_extract_canonical_answer_C():
    assert extract_answer_letter("blah blah\n\nAnswer: C") == "C"


def test_extract_with_markdown_bold():
    assert extract_answer_letter("Reasoning.\n\nAnswer: **B**") == "B"


def test_extract_lowercase():
    assert extract_answer_letter("Final analysis.\nanswer: A") == "A"


def test_extract_with_parens():
    assert extract_answer_letter("Reasoning.\nAnswer: (D)") == "D"


def test_extract_last_occurrence_wins():
    """Chain-of-thought can mention multiple letters; last 'Answer: X' wins."""
    text = "Initially Answer: A\nWait, Answer: B\nFinal: Answer: C"
    assert extract_answer_letter(text) == "C"


def test_extract_returns_none_when_no_answer():
    assert extract_answer_letter("I cannot determine the answer.") is None


def test_extract_returns_none_when_letter_outside_ABCD():
    assert extract_answer_letter("Answer: E") is None


def test_qa_verifier_correct_answer_returns_1():
    v = QAVerifier()
    candidate = "Reasoning here.\n\nAnswer: B"
    query = {"id": "q1", "answer": "B", "choices": {"A": "x", "B": "y", "C": "z", "D": "w"}}
    r = v.score(candidate, query)
    assert isinstance(r, VerifierResult)
    assert r.score == 1.0
    assert r.extracted == "B"
    assert r.expected == "B"
    assert r.error is None


def test_qa_verifier_wrong_answer_returns_0():
    v = QAVerifier()
    candidate = "Reasoning here.\n\nAnswer: D"
    query = {"id": "q1", "answer": "B", "choices": {}}
    r = v.score(candidate, query)
    assert r.score == 0.0
    assert r.extracted == "D"
    assert r.expected == "B"


def test_qa_verifier_unparseable_returns_partial_score():
    """When the response has no extractable answer, score is 0 but error is set."""
    v = QAVerifier()
    candidate = "I really don't know."
    query = {"id": "q1", "answer": "B", "choices": {}}
    r = v.score(candidate, query)
    assert r.score == 0.0
    assert r.extracted is None
    assert r.error is not None  # explanatory error attached
