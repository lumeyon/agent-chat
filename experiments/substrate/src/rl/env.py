"""RL environment glue between substrate components and TRL.

Provides:
  - RLEnvSpec: a dataclass for one training task (query + ground truth)
  - build_query_text: turns a spec into a prompt the policy model sees
  - mcq_reward: closed-form QA reward (uses substrate's verifier)

Future: math_reward, code_reward, adversarial_reward — each plugs in
the corresponding verifier from src/verifier/.
"""
from dataclasses import dataclass
from ..verifier.qa_verifier import QAVerifier

_qa = QAVerifier()


@dataclass
class RLEnvSpec:
    id: str
    domain: str
    subdomain: str
    question: str
    choices: dict
    answer: str


def build_query_text(spec: RLEnvSpec) -> str:
    """Format an RLEnvSpec as a prompt for the policy model. Same format
    as the GPQA baseline runners so trained models inherit the format."""
    return (
        f"Domain: {spec.domain} / {spec.subdomain}\n\n"
        f"Question: {spec.question}\n\n"
        f"Choices:\n"
        f"(A) {spec.choices['A']}\n"
        f"(B) {spec.choices['B']}\n"
        f"(C) {spec.choices['C']}\n"
        f"(D) {spec.choices['D']}\n\n"
        f"Think step by step, then on the LAST line of your response output exactly:\n"
        f"Answer: X\n\n"
        f"where X is one of A, B, C, or D."
    )


def mcq_reward(candidate_text: str, spec: RLEnvSpec) -> float:
    """Score a candidate response. 1.0 if extracted letter matches answer, 0.0 otherwise."""
    result = _qa.score(candidate_text, {"id": spec.id, "answer": spec.answer, "choices": spec.choices})
    return float(result.score)


def mcq_reward_with_format(candidate_text: str, spec: RLEnvSpec) -> float:
    """v0.2 reward: 0.3 for emitting any A/B/C/D, +0.7 if correct.

    Rationale: pure 0/1 correctness is too sparse — most steps have all K
    generations score 0, GRPO advantage = 0, no gradient signal. Adding a
    format reward breaks the sparsity: any candidate that emits a parseable
    answer letter earns reward >= 0.3 even if wrong. This gives GRPO real
    gradient signal early in training, when the base model can't yet
    answer correctly but might emit format-compliant answers."""
    result = _qa.score(candidate_text, {"id": spec.id, "answer": spec.answer, "choices": spec.choices})
    if result.score >= 1.0:
        return 1.0
    if result.extracted is not None:  # got a letter, just wrong one
        return 0.3
    return 0.0
