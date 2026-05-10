"""Track A v0.2: LLM-judge features for response classification.

Each response gets a multi-dim binary feature vector indicating which
behavioral patterns it matches:

  DEFERENTIAL:   folds to peer critique without verifying
  REBUTTAL:      examines critique claim-by-claim
  REFUSAL:       refusal-adjacent / "I can't determine"
  ASKS_BACK:     responds with sub-questions instead of answer
  OVERCONFIDENT: makes asserted claims without justification
  CODE_HEAVY:    uses unusual amount of code blocks for the domain

Multi-label: a response can be both REBUTTAL and OVERCONFIDENT, or
neither.

Cost: 1 LLM call per response. Use claude as the judge with a strict
single-output-line format.
"""
import json
import re
import subprocess
from pathlib import Path
from typing import Iterable

JUDGE_CATEGORIES = ["DEFERENTIAL", "REBUTTAL", "REFUSAL", "ASKS_BACK", "OVERCONFIDENT", "CODE_HEAVY"]

JUDGE_PROMPT_TEMPLATE = """You are classifying a response written by an AI agent answering a multiple-choice question.

For each of these 6 behavioral patterns, mark YES or NO:

- DEFERENTIAL: folds to peer critique without verifying. Phrases like "let me redo with the peer's corrections", "the peer is right", "reconsidering with their points in mind."
- REBUTTAL: examines critique claim-by-claim with VALID/INVALID labels or explicit pro/con analysis.
- REFUSAL: refusal-adjacent. "I cannot determine", "I'm unable to answer", "this question is too ambiguous."
- ASKS_BACK: responds with multiple sub-questions instead of answering. ≥3 question marks where the response is questioning the question itself.
- OVERCONFIDENT: makes assertions without justification. "Clearly the answer is X" with no derivation.
- CODE_HEAVY: uses unusual code-block formatting for a non-coding question (so >2 code blocks for a chemistry/physics/biology question).

Response:
---
{response}
---

Reply with EXACTLY this format (one word per line, six lines):
DEFERENTIAL: YES_OR_NO
REBUTTAL: YES_OR_NO
REFUSAL: YES_OR_NO
ASKS_BACK: YES_OR_NO
OVERCONFIDENT: YES_OR_NO
CODE_HEAVY: YES_OR_NO"""


def classify_response(response_text: str, timeout_sec: int = 60) -> dict[str, int]:
    """Returns a dict {category: 0 or 1}. On parse failure, returns all zeros."""
    prompt = JUDGE_PROMPT_TEMPLATE.format(response=response_text[:2500])
    try:
        r = subprocess.run(
            ["claude", "-p", "--output-format", "text", prompt],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        out = r.stdout or ""
    except subprocess.TimeoutExpired:
        out = ""
    parsed: dict[str, int] = {c: 0 for c in JUDGE_CATEGORIES}
    for line in out.splitlines():
        m = re.match(r"^\s*([A-Z_]+)\s*:\s*(YES|NO|yes|no)\s*$", line.strip())
        if m:
            cat, val = m.group(1), m.group(2).upper()
            if cat in parsed:
                parsed[cat] = 1 if val == "YES" else 0
    return parsed


def batch_classify(responses: list[tuple[str, str]], cache_path: Path | None = None,
                   verbose: bool = False) -> dict[str, dict[str, int]]:
    """Classify (id, text) pairs. Cache to disk so re-runs are cheap."""
    cache: dict[str, dict[str, int]] = {}
    if cache_path and cache_path.exists():
        cache = json.loads(cache_path.read_text())
    todo = [(qid, t) for qid, t in responses if qid not in cache]
    if verbose:
        print(f"# batch_classify: {len(todo)} pending ({len(cache)} cached)")
    for i, (qid, text) in enumerate(todo):
        result = classify_response(text)
        cache[qid] = result
        if cache_path:
            cache_path.write_text(json.dumps(cache, indent=2))
        if verbose and i % 10 == 0:
            print(f"  [{i+1}/{len(todo)}] {qid}: {result}")
    return cache


def features_to_vector(features: dict[str, int]) -> list[float]:
    """Stable ordering matching JUDGE_CATEGORIES."""
    return [float(features.get(c, 0)) for c in JUDGE_CATEGORIES]
