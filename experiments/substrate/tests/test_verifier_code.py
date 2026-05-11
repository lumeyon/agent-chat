"""Tests for verifier.code_verifier."""
from experiments.substrate.src.verifier.code_verifier import (
    CodeVerifier, extract_code,
)


def test_extract_python_block():
    text = "Here's my solution:\n```python\ndef add(a, b):\n    return a + b\n```\nDone."
    code = extract_code(text)
    assert "def add" in code
    assert "return a + b" in code


def test_extract_returns_last_block():
    text = "```python\nx=1\n```\nthen\n```python\ny=2\n```"
    assert "y=2" in extract_code(text)


def test_extract_returns_none_when_no_code():
    assert extract_code("just plain text") is None


def test_code_verifier_passing_solution():
    v = CodeVerifier()
    candidate = "```python\ndef add(a, b):\n    return a + b\n```"
    query = {"id": "q1", "tests": "assert add(2, 3) == 5\nassert add(0, 0) == 0\n"}
    r = v.score(candidate, query)
    assert r.score == 1.0
    assert r.error is None


def test_code_verifier_failing_solution():
    v = CodeVerifier()
    candidate = "```python\ndef add(a, b):\n    return a - b  # wrong\n```"
    query = {"id": "q1", "tests": "assert add(2, 3) == 5\n"}
    r = v.score(candidate, query)
    assert r.score == 0.0
    assert r.error is not None


def test_code_verifier_no_code_returns_0():
    v = CodeVerifier()
    candidate = "I don't know how to write that function."
    query = {"id": "q1", "tests": "assert add(2, 3) == 5\n"}
    r = v.score(candidate, query)
    assert r.score == 0.0
    assert "no python code block" in r.error
