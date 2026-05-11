"""Multiple-choice QA verifier.

Extracts the final A/B/C/D letter from the candidate's response and
compares to the expected answer. Score = 1.0 if match, 0.0 otherwise.
Returns the extracted letter, expected letter, and an error string when
extraction fails (so unparseable responses are distinguishable from
incorrect ones in downstream analysis)."""
import re
from .base import Verifier, VerifierResult


# Reuses the canonical regex from experiments/residual/src/response_features.py
# (which itself derives from benchmarks/gpqa-diamond/src/extract.ts). Last
# occurrence wins so chain-of-thought mentions of intermediate letters don't
# false-positive.
ANSWER_RE = re.compile(
    r"(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}(?![A-Za-z])",
    re.MULTILINE,
)


def extract_answer_letter(text: str) -> str | None:
    """Return final A/B/C/D letter, or None if not extractable."""
    if not text:
        return None
    matches = ANSWER_RE.findall(text)
    if matches:
        return matches[-1]
    # Bare-letter fallback: last non-empty line is exactly A/B/C/D (with
    # optional punctuation/markdown).
    for line in reversed(text.strip().splitlines()):
        s = line.strip().strip(".() ").rstrip("*").strip("()")
        if len(s) == 1 and s in "ABCD":
            return s
    return None


class QAVerifier:
    """MCQ letter-match. query must have 'answer' key with the expected letter."""

    def score(self, candidate: str, query: dict) -> VerifierResult:
        expected = query.get("answer")
        if expected not in {"A", "B", "C", "D"}:
            return VerifierResult(
                score=0.0, extracted=None, expected=expected,
                error=f"query.answer must be A/B/C/D, got {expected!r}",
            )
        extracted = extract_answer_letter(candidate)
        if extracted is None:
            return VerifierResult(
                score=0.0, extracted=None, expected=expected,
                error="no extractable answer letter in candidate",
            )
        is_correct = extracted == expected
        return VerifierResult(
            score=1.0 if is_correct else 0.0,
            extracted=extracted, expected=expected, error=None,
        )
