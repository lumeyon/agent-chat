"""Tests for rl.env — the (query → candidate → reward) wrapper that sits
between the substrate's components and TRL's training loop."""
from experiments.substrate.src.rl.env import (
    RLEnvSpec, build_query_text, mcq_reward,
)


def test_build_query_text_includes_choices():
    spec = RLEnvSpec(
        id="q1", domain="Physics", subdomain="Mechanics",
        question="What is the velocity?",
        choices={"A": "10 m/s", "B": "20 m/s", "C": "30 m/s", "D": "40 m/s"},
        answer="B",
    )
    text = build_query_text(spec)
    assert "Physics" in text
    assert "What is the velocity?" in text
    assert "(A) 10 m/s" in text
    assert "(B) 20 m/s" in text
    assert "Answer: X" in text


def test_mcq_reward_correct_returns_1():
    spec = RLEnvSpec(
        id="q1", domain="X", subdomain="Y",
        question="?", choices={"A":"","B":"","C":"","D":""}, answer="C",
    )
    r = mcq_reward("Reasoning. Answer: C", spec)
    assert r == 1.0


def test_mcq_reward_wrong_returns_0():
    spec = RLEnvSpec(
        id="q1", domain="X", subdomain="Y",
        question="?", choices={"A":"","B":"","C":"","D":""}, answer="C",
    )
    r = mcq_reward("Reasoning. Answer: A", spec)
    assert r == 0.0


def test_mcq_reward_unparseable_returns_0():
    spec = RLEnvSpec(
        id="q1", domain="X", subdomain="Y",
        question="?", choices={"A":"","B":"","C":"","D":""}, answer="C",
    )
    r = mcq_reward("I dunno", spec)
    assert r == 0.0
