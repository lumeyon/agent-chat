"""Extract per-response features for the residual sampler.

Two parts:
  - extract_scalar_features: regex-based reasoning markers + length + final letter
  - build_feature_vector: concatenates a response embedding with the scalar features

Numeric scalar features are NOT z-scored here — that's done at matrix-build time
where we have the full distribution across responses.
"""
import re
from typing import Optional
import torch


HEDGE_RE = re.compile(r"\b(possibly|maybe|uncertain|might|perhaps|approximately|roughly|likely|seems|appears|tend to|tends to)\b", re.IGNORECASE)
CERTAIN_RE = re.compile(r"\b(clearly|definitely|certainly|undoubtedly|obviously|exactly|precisely|absolutely)\b", re.IGNORECASE)
SELF_CORRECT_RE = re.compile(r"\b(wait|actually|reconsider|let me reconsider|on second thought|hmm|hold on|scratch that|i was wrong|correction)\b", re.IGNORECASE)
LATEX_INLINE_RE = re.compile(r"\$[^$\n]+\$|\\\([^\)]+\\\)")
CODEBLOCK_RE = re.compile(r"```", re.MULTILINE)
ANSWER_LETTER_RE = re.compile(r"(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}(?![A-Za-z])", re.MULTILINE)

# Order matters — must match feature-vector layout used in build_feature_vector.
FEATURE_NAMES = [
    "response_len",
    "n_latex",
    "n_codeblocks",
    "n_hedge_words",
    "n_certainty_words",
    "n_self_correction",
    "n_questions",
    "letter_A",
    "letter_B",
    "letter_C",
    "letter_D",
    "letter_unknown",
]


def extract_scalar_features(text: str) -> dict:
    """Return a dict of named features. Numeric values are RAW (not z-scored)."""
    if not text:
        text = ""
    matches = ANSWER_LETTER_RE.findall(text)
    final_letter: Optional[str] = matches[-1] if matches else None
    return {
        "response_len": len(text),
        "n_latex": len(LATEX_INLINE_RE.findall(text)),
        "n_codeblocks": len(CODEBLOCK_RE.findall(text)) // 2 if len(CODEBLOCK_RE.findall(text)) > 0 else 0,
        "n_hedge_words": len(HEDGE_RE.findall(text)),
        "n_certainty_words": len(CERTAIN_RE.findall(text)),
        "n_self_correction": len(SELF_CORRECT_RE.findall(text)),
        "n_questions": text.count("?"),
        "final_letter": final_letter,
    }


def build_feature_vector(text: str, embedding: torch.Tensor) -> torch.Tensor:
    """Concatenate [embedding, scalar features] in canonical order. Letter is one-hot."""
    f = extract_scalar_features(text)
    parts: list[float] = [
        float(f["response_len"]),
        float(f["n_latex"]),
        float(f["n_codeblocks"]),
        float(f["n_hedge_words"]),
        float(f["n_certainty_words"]),
        float(f["n_self_correction"]),
        float(f["n_questions"]),
        1.0 if f["final_letter"] == "A" else 0.0,
        1.0 if f["final_letter"] == "B" else 0.0,
        1.0 if f["final_letter"] == "C" else 0.0,
        1.0 if f["final_letter"] == "D" else 0.0,
        1.0 if f["final_letter"] is None else 0.0,
    ]
    return torch.cat([embedding, torch.tensor(parts, dtype=torch.float32)])
