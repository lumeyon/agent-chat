"""Tests for the router Q-network."""
import torch
from experiments.router.src.model import RouterQNet


def test_forward_pass_shape():
    m = RouterQNet(in_dim=420, hidden=128)
    x = torch.randn(8, 420)
    out = m(x)
    assert out.shape == (8,), f"expected (8,) got {tuple(out.shape)}"
    assert torch.isfinite(out).all()


def test_param_count_under_100k():
    m = RouterQNet(in_dim=420, hidden=128)
    n = sum(p.numel() for p in m.parameters())
    assert n < 100_000, f"too many params: {n}"


def test_can_overfit_tiny_dataset():
    """Sanity: model can memorize 32 random samples in <500 epochs."""
    torch.manual_seed(42)
    X = torch.randn(32, 420)
    y = torch.randint(0, 2, (32,)).float()
    m = RouterQNet(in_dim=420, hidden=128)
    opt = torch.optim.Adam(m.parameters(), lr=1e-2)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    for _ in range(500):
        opt.zero_grad()
        loss = loss_fn(m(X), y)
        loss.backward()
        opt.step()
    preds = (torch.sigmoid(m(X)) > 0.5).float()
    acc = (preds == y).float().mean().item()
    assert acc >= 0.9, f"can't even overfit 32 samples (acc={acc:.2f}); model is broken"
