"""Training loops: supervised Q-function + online (continuous-learning) variant."""
import torch
import torch.nn as nn
from .featurize import build_features, EXPERTS
from .model import RouterQNet


def train_supervised(
    X: torch.Tensor,
    y: torch.Tensor,
    n_epochs: int = 200,
    lr: float = 1e-3,
    weight_decay: float = 1e-4,
    hidden: int = 128,
    device: str = "cuda",
    verbose: bool = True,
) -> tuple[RouterQNet, list[dict]]:
    device = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
    model = RouterQNet(in_dim=X.shape[1], hidden=hidden).to(device)
    X = X.to(device)
    y = y.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=n_epochs)
    loss_fn = nn.BCEWithLogitsLoss()
    history = []
    model.train()
    for epoch in range(n_epochs):
        opt.zero_grad()
        logits = model(X)
        loss = loss_fn(logits, y)
        loss.backward()
        opt.step()
        sched.step()
        if epoch % 20 == 0 or epoch == n_epochs - 1:
            with torch.no_grad():
                model.eval()
                preds = (torch.sigmoid(model(X)) > 0.5).float()
                acc = (preds == y).float().mean().item()
                model.train()
            history.append({"epoch": epoch, "loss": loss.item(), "train_acc": acc})
            if verbose:
                print(f"  epoch {epoch:3d}  loss={loss.item():.4f}  train_acc={acc:.3f}")
    model.eval()
    return model, history


def train_online(
    triples: list[dict],
    embeddings: torch.Tensor,
    ordering_seed: int = 0,
    lr: float = 5e-4,
    epsilon: float = 0.1,
    window: int = 30,
    hidden: int = 64,
    minibatch: int = 16,
    sgd_steps_per_q: int = 4,
    device: str = "cuda",
    verbose: bool = True,
) -> list[dict]:
    """Stream questions in shuffled order; for each: route via ε-greedy on Q,
    observe both rewards (full-info), append both (x, y) to a replay buffer,
    do K SGD steps on a minibatch sampled from the buffer. Track rolling acc.

    Replay prevents online overfitting: model never forgets old triples."""
    device = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
    X, y, meta = build_features(triples, embeddings)
    in_dim = meta["feature_dim"]
    n_q = len(triples)

    g = torch.Generator().manual_seed(ordering_seed)
    order = torch.randperm(n_q, generator=g).tolist()

    model = RouterQNet(in_dim=in_dim, hidden=hidden).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.BCEWithLogitsLoss()

    rng = torch.Generator().manual_seed(ordering_seed + 1)
    buf_x: list[torch.Tensor] = []
    buf_y: list[float] = []
    trajectory: list[dict] = []
    recent_correct: list[int] = []

    for step, qi in enumerate(order):
        cx_row = X[2 * qi + meta["expert_idx"]["codex"]].to(device)
        cl_row = X[2 * qi + meta["expert_idx"]["claude"]].to(device)
        rewards = {
            "codex": float(triples[qi]["codex_correct"]),
            "claude": float(triples[qi]["claude_correct"]),
        }

        model.eval()
        with torch.no_grad():
            q_cx = torch.sigmoid(model(cx_row.unsqueeze(0))).item()
            q_cl = torch.sigmoid(model(cl_row.unsqueeze(0))).item()

        if torch.rand(1, generator=rng).item() < epsilon:
            chosen = "codex" if torch.rand(1, generator=rng).item() < 0.5 else "claude"
        else:
            chosen = "codex" if q_cx >= q_cl else "claude"

        outcome = int(rewards[chosen] == 1.0)
        recent_correct.append(outcome)
        if len(recent_correct) > window:
            recent_correct.pop(0)
        rolling_acc = sum(recent_correct) / len(recent_correct)

        # Append both expert rows to buffer (full-info).
        buf_x.append(cx_row); buf_y.append(rewards["codex"])
        buf_x.append(cl_row); buf_y.append(rewards["claude"])

        # Replay: K minibatch SGD steps.
        loss_val = 0.0
        if len(buf_x) >= 2:
            buf_x_t = torch.stack(buf_x)
            buf_y_t = torch.tensor(buf_y, device=device)
            model.train()
            for _ in range(sgd_steps_per_q):
                bs = min(minibatch, len(buf_x))
                idx = torch.randint(0, len(buf_x), (bs,), generator=rng)
                opt.zero_grad()
                logits = model(buf_x_t[idx])
                loss = loss_fn(logits, buf_y_t[idx])
                loss.backward()
                opt.step()
                loss_val = loss.item()

        trajectory.append({
            "step": step,
            "qid": triples[qi]["id"],
            "domain": triples[qi]["domain"],
            "q_codex": q_cx,
            "q_claude": q_cl,
            "chosen": chosen,
            "reward": rewards[chosen],
            "outcome_correct": outcome,
            "rolling_acc": rolling_acc,
            "loss": loss_val,
            "buf_size": len(buf_x),
        })
        if verbose and step % 20 == 0:
            print(f"  step {step:3d}  chose={chosen}  rolling_acc={rolling_acc:.3f}  loss={loss_val:.3f}")

    return trajectory
