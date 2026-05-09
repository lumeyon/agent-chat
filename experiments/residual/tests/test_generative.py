"""Tests for the generative residual sampler (Track B).

The math primitives (basis computation, projection, sampling) are tested
on synthetic data without needing to load the actual LLM. The end-to-end
smoke test that loads Qwen2.5-1.5B is gated on AGENT_CHAT_RUN_LLM_TESTS=1
so the cheap-and-fast unit tests run by default."""
import os
import pytest
import torch
from experiments.residual.src.generative import (
    compute_residual_basis, project_to_residual, sample_from_residual_logits,
)


def test_basis_shape_matches_documented():
    """compute_residual_basis(M, k) should return V_k of shape (k, V).

    The basis represents the top-k right singular vectors as ROWS, so applying
    it as `basis @ logits` projects onto the typical-direction subspace."""
    torch.manual_seed(0)
    M = torch.randn(50, 256)
    basis = compute_residual_basis(M, k=4)
    assert basis.shape == (4, 256), f"expected (4, 256), got {tuple(basis.shape)}"


def test_residual_orthogonal_to_basis():
    """After project_to_residual, the residual should be (numerically) orthogonal
    to every basis vector: basis @ residual ≈ 0."""
    torch.manual_seed(1)
    M = torch.randn(100, 200)
    basis = compute_residual_basis(M, k=8)
    test_logits = torch.randn(200)
    residual = project_to_residual(test_logits, basis)
    inner = basis @ residual
    assert inner.abs().max() < 1e-4, f"residual not orthogonal to basis: max abs = {inner.abs().max().item()}"


def test_residual_preserves_norm_decomposition():
    """||v||² = ||proj_basis(v)||² + ||residual(v)||²  (Pythagorean for orthogonal projection)."""
    torch.manual_seed(2)
    M = torch.randn(80, 150)
    basis = compute_residual_basis(M, k=6)
    v = torch.randn(150)
    residual = project_to_residual(v, basis)
    proj_part = v - residual
    n2_total = (v ** 2).sum().item()
    n2_split = (proj_part ** 2).sum().item() + (residual ** 2).sum().item()
    assert abs(n2_total - n2_split) < 1e-4, f"norm decomposition broken: {n2_total} vs {n2_split}"


def test_sample_from_residual_logits_returns_valid_token_id():
    torch.manual_seed(3)
    V = 1000
    logits = torch.randn(V) * 5
    tok = sample_from_residual_logits(logits, temperature=1.0, seed=0)
    assert isinstance(tok, int)
    assert 0 <= tok < V


def test_sample_temperature_zero_picks_argmax():
    """At τ=0+ (very small) we should pick argmax. Use τ=0 explicitly handled as greedy."""
    torch.manual_seed(4)
    V = 100
    logits = torch.randn(V)
    argmax_tok = int(torch.argmax(logits).item())
    tok = sample_from_residual_logits(logits, temperature=0.0, seed=0)
    assert tok == argmax_tok, f"τ=0 should pick argmax {argmax_tok}, got {tok}"


@pytest.mark.skipif(
    os.environ.get("AGENT_CHAT_RUN_LLM_TESTS") != "1",
    reason="set AGENT_CHAT_RUN_LLM_TESTS=1 to run the slow integration test that loads Qwen2.5-1.5B",
)
def test_generate_with_residual_runs():
    """Smoke: load the model, calibrate on a few prompts, generate one short
    completion in residual mode without crashing. Verifies the integration."""
    from experiments.residual.src.generative import (
        load_model, calibrate_on_prompts, generate_with_residual,
    )
    model, tokenizer = load_model("Qwen/Qwen2.5-1.5B-Instruct", device="cuda")
    cal_prompts = [
        "What is 2+2?", "Define gravity briefly.", "Name a primary color.",
        "What is the capital of France?", "Describe the water cycle.",
        "What is photosynthesis?", "Name a chemical element.", "What is DNA?",
        "Explain Newton's first law.", "What is osmosis?",
    ]
    basis = calibrate_on_prompts(model, tokenizer, cal_prompts, k=4, device="cuda")
    out = generate_with_residual(model, tokenizer, "Tell me one fact about photons.",
                                 basis, max_new_tokens=20, temperature=0.7, seed=0,
                                 device="cuda")
    assert isinstance(out, str)
    assert len(out) > 0
