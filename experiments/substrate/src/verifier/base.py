"""Base protocol for verifiers.

Every verifier's `score(candidate, query) -> VerifierResult` returns a
floating-point score in [0, 1] (1 = correct, 0 = wrong, fractional for
partial credit) plus diagnostic fields. The score is the reward signal
for component 6's RL training."""
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class VerifierResult:
    score: float
    extracted: str | None = None
    expected: str | None = None
    error: str | None = None
    meta: dict = field(default_factory=dict)


@runtime_checkable
class Verifier(Protocol):
    def score(self, candidate: str, query: dict) -> VerifierResult: ...
