"""Code-correctness verifier.

Given a candidate response containing Python code (extracted via fence
markers) and a query with `tests` (pytest snippets), execute the code,
run the tests, return score = pass_rate.

This is component 6's reward signal for code-generation training tasks
(HumanEval, MBPP). Reuses tools/code_exec.py for sandboxed execution.
"""
import re
from .base import Verifier, VerifierResult
from ..tools.code_exec import execute_python


CODE_FENCE_RE = re.compile(r"```(?:python|py)?\n(.*?)```", re.DOTALL)


def extract_code(text: str) -> str | None:
    """Extract the LAST python code block from text."""
    if not text:
        return None
    matches = CODE_FENCE_RE.findall(text)
    return matches[-1] if matches else None


class CodeVerifier:
    """Score = test_pass_count / total_tests for a candidate's code.

    query schema: {"tests": "...pytest source...", "id": "..."}
    """

    def score(self, candidate: str, query: dict) -> VerifierResult:
        code = extract_code(candidate)
        if code is None:
            return VerifierResult(
                score=0.0, extracted=None, expected=None,
                error="no python code block found in candidate",
            )
        tests = query.get("tests")
        if not tests:
            return VerifierResult(
                score=0.0, extracted=code[:200], expected=None,
                error="query.tests missing",
            )
        # Combine candidate code + test code, then count assertions / use
        # exit code to gauge pass/fail. v0.1 uses simple all-or-nothing:
        # exit 0 = pass = score 1.0; non-zero = fail = score 0.0.
        combined = code + "\n\n" + tests
        result = execute_python(combined, timeout_sec=10.0)
        score = 1.0 if result.status == 0 else 0.0
        return VerifierResult(
            score=score,
            extracted=code[:200],
            expected="all tests pass",
            error=None if score >= 1.0 else (result.stderr[:200] if result.stderr else "tests failed"),
            meta={
                "exec_status": result.status,
                "exec_elapsed_ms": result.elapsed_ms,
                "stdout_excerpt": result.stdout[:200],
            },
        )
