"""Score every candidate from an EnsembleResult with a Verifier.

Returns a structured per-agent breakdown so we can compare which agent
produced verifier-passing candidates at what rate. This is the input to
component 6's reward signal."""
from dataclasses import dataclass, field
from .base import Verifier, VerifierResult
from ..ensemble.run_ensemble import EnsembleResult


@dataclass
class ScoredCandidate:
    agent: str
    text: str
    elapsed_ms: int
    verifier: VerifierResult


@dataclass
class ScoredEnsemble:
    query_id: str
    expected: str | None
    per_agent_candidates: dict[str, list[ScoredCandidate]]
    meta: dict = field(default_factory=dict)

    def best_per_agent(self) -> dict[str, ScoredCandidate | None]:
        """Return the highest-scoring candidate per agent (or None if all empty)."""
        out = {}
        for agent, scored in self.per_agent_candidates.items():
            if not scored:
                out[agent] = None
            else:
                out[agent] = max(scored, key=lambda s: s.verifier.score)
        return out

    def per_agent_pass_rate(self) -> dict[str, float]:
        """Fraction of candidates per agent with score >= 1.0."""
        out = {}
        for agent, scored in self.per_agent_candidates.items():
            if not scored:
                out[agent] = 0.0
            else:
                n_pass = sum(1 for s in scored if s.verifier.score >= 1.0)
                out[agent] = n_pass / len(scored)
        return out


def score_ensemble(
    ensemble: EnsembleResult,
    verifier: Verifier,
    query: dict,
) -> ScoredEnsemble:
    """Score every candidate in the ensemble result against the verifier."""
    per_agent_scored: dict[str, list[ScoredCandidate]] = {}
    for agent, runs in ensemble.per_agent.items():
        per_agent_scored[agent] = [
            ScoredCandidate(
                agent=agent,
                text=r.text,
                elapsed_ms=r.elapsed_ms,
                verifier=verifier.score(r.text, query),
            )
            for r in runs
        ]
    return ScoredEnsemble(
        query_id=query.get("id", "?"),
        expected=query.get("answer"),
        per_agent_candidates=per_agent_scored,
        meta={"ensemble_meta": ensemble.meta},
    )
