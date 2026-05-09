"""Evaluation: oracle ceiling, domain-argmax baseline, K-fold learning curve, plotting."""
import csv
import json
from collections import defaultdict
from pathlib import Path
import numpy as np
import torch
from .data import load_triples, count_correct
from .featurize import build_features, embed_queries, EXPERTS
from .train import train_supervised
from .model import RouterQNet

RESULTS_DIR = Path(__file__).resolve().parents[1] / "results"


def oracle_ceiling(triples: list[dict]) -> tuple[int, int]:
    """Perfect-router upper bound: max over experts on each question."""
    n = 0
    for t in triples:
        if t["codex_correct"] or t["claude_correct"]:
            n += 1
    return n, len(triples)


def domain_argmax_router(triples: list[dict]) -> int:
    """Trivial router: per-domain pick whichever expert has higher accuracy on that domain."""
    by_dom_cx = defaultdict(lambda: [0, 0])
    by_dom_cl = defaultdict(lambda: [0, 0])
    for t in triples:
        d = t["domain"]
        by_dom_cx[d][1] += 1
        by_dom_cl[d][1] += 1
        if t["codex_correct"]:
            by_dom_cx[d][0] += 1
        if t["claude_correct"]:
            by_dom_cl[d][0] += 1
    best = {
        d: ("codex" if by_dom_cx[d][0] >= by_dom_cl[d][0] else "claude")
        for d in by_dom_cx
    }
    return sum(1 for t in triples if t[f"{best[t['domain']]}_correct"])


def _eval_router(model: RouterQNet, X: torch.Tensor, y: torch.Tensor, triples: list[dict], expert_idx: dict, device: str) -> int:
    """Use trained model to pick argmax expert per question; count correct picks."""
    model.eval()
    correct = 0
    with torch.no_grad():
        for i, t in enumerate(triples):
            cx_row = X[2 * i + expert_idx["codex"]].to(device).unsqueeze(0)
            cl_row = X[2 * i + expert_idx["claude"]].to(device).unsqueeze(0)
            q_cx = torch.sigmoid(model(cx_row)).item()
            q_cl = torch.sigmoid(model(cl_row)).item()
            chosen = "codex" if q_cx >= q_cl else "claude"
            if t[f"{chosen}_correct"]:
                correct += 1
    return correct


def kfold_learning_curve(
    triples: list[dict],
    embeddings: torch.Tensor,
    train_sizes: list[int] | None = None,
    n_seeds: int = 5,
    n_folds: int = 5,
    device: str = "cuda",
) -> list[dict]:
    """For each train_size, run n_seeds shuffles × n_folds CV. Train supervised, eval router accuracy on held-out fold."""
    if train_sizes is None:
        train_sizes = [10, 25, 50, 100, 158]
    X_full, y_full, meta = build_features(triples, embeddings)
    n_q = len(triples)
    rows: list[dict] = []
    for size in train_sizes:
        for seed in range(n_seeds):
            g = torch.Generator().manual_seed(seed * 100 + size)
            perm = torch.randperm(n_q, generator=g).tolist()
            for fold in range(n_folds):
                test_block = perm[fold * (n_q // n_folds): (fold + 1) * (n_q // n_folds)]
                test_set = set(test_block)
                non_test = [i for i in perm if i not in test_set]
                train_idx = non_test[:size]
                # Build indices into the (n_q*2)-row X matrix.
                tr_rows = []
                for qi in train_idx:
                    tr_rows.append(2 * qi + meta["expert_idx"]["codex"])
                    tr_rows.append(2 * qi + meta["expert_idx"]["claude"])
                Xtr = X_full[tr_rows]
                ytr = y_full[tr_rows]
                test_triples = [triples[i] for i in test_block]
                X_test_rows = []
                for qi in test_block:
                    X_test_rows.append(X_full[2 * qi + meta["expert_idx"]["codex"]])
                    X_test_rows.append(X_full[2 * qi + meta["expert_idx"]["claude"]])
                X_test = torch.stack(X_test_rows)
                y_test = torch.cat([y_full[2 * qi: 2 * qi + 2] for qi in test_block])
                model, _ = train_supervised(Xtr, ytr, n_epochs=150, lr=1e-3, device=device, verbose=False)
                router_correct = _eval_router(model, X_test, y_test, test_triples, meta["expert_idx"], device)
                acc = router_correct / len(test_triples)
                rows.append({
                    "train_size": size,
                    "seed": seed,
                    "fold": fold,
                    "test_n": len(test_triples),
                    "router_correct": router_correct,
                    "router_acc": acc,
                })
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def plot_learning_curve(csv_path: Path, png_path: Path, baselines: dict) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    rows = []
    with open(csv_path) as f:
        for r in csv.DictReader(f):
            r["train_size"] = int(r["train_size"])
            r["router_acc"] = float(r["router_acc"])
            rows.append(r)
    sizes = sorted(set(r["train_size"] for r in rows))
    means = [np.mean([r["router_acc"] for r in rows if r["train_size"] == s]) for s in sizes]
    stds = [np.std([r["router_acc"] for r in rows if r["train_size"] == s]) for s in sizes]
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.errorbar(sizes, [m * 100 for m in means], yerr=[s * 100 for s in stds], marker="o", linewidth=2, label="Router (learned)", color="C0")
    for label, val in baselines.items():
        ax.axhline(val * 100, linestyle="--", alpha=0.6, label=f"{label}: {val*100:.1f}%")
    ax.set_xlabel("Training questions seen")
    ax.set_ylabel("Held-out paired accuracy (%)")
    ax.set_title("Router learning curve — GPQA Diamond (n=198, 5-fold × 5-seed)")
    ax.legend(loc="lower right", fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(png_path, dpi=120)
    plt.close(fig)


def main() -> None:
    triples = load_triples()
    print(f"# loaded {len(triples)} triples")
    print(f"#   codex correct:  {count_correct(triples, 'codex')}/{len(triples)}")
    print(f"#   claude correct: {count_correct(triples, 'claude')}/{len(triples)}")
    n_oracle, n_total = oracle_ceiling(triples)
    print(f"#   oracle ceiling: {n_oracle}/{n_total} = {n_oracle/n_total*100:.1f}%")
    n_dom = domain_argmax_router(triples)
    print(f"#   domain-argmax:  {n_dom}/{n_total} = {n_dom/n_total*100:.1f}%")

    print("# embedding queries...")
    embeddings = embed_queries([t["query"] for t in triples])
    print(f"#   embeddings shape: {tuple(embeddings.shape)}")

    print("# kfold learning curve...")
    rows = kfold_learning_curve(triples, embeddings, device="cuda")
    csv_path = RESULTS_DIR / "learning_curve.csv"
    write_csv(rows, csv_path)
    print(f"#   wrote {csv_path}")

    cx = count_correct(triples, "codex") / len(triples)
    cl = count_correct(triples, "claude") / len(triples)
    baselines = {
        "oracle ceiling": n_oracle / n_total,
        "domain-argmax router": n_dom / n_total,
        "codex alone": cx,
        "claude alone": cl,
    }
    png_path = RESULTS_DIR / "learning_curve.png"
    plot_learning_curve(csv_path, png_path, baselines)
    print(f"#   wrote {png_path}")

    final = {
        "n_triples": len(triples),
        "oracle_ceiling": baselines["oracle ceiling"],
        "domain_argmax": baselines["domain-argmax router"],
        "codex_alone": baselines["codex alone"],
        "claude_alone": baselines["claude alone"],
        "router_curve": [
            {"train_size": s, "mean_acc": float(np.mean([r["router_acc"] for r in rows if r["train_size"] == s])),
             "std_acc": float(np.std([r["router_acc"] for r in rows if r["train_size"] == s]))}
            for s in sorted(set(r["train_size"] for r in rows))
        ],
    }
    final_path = RESULTS_DIR / "final_metrics.json"
    final_path.write_text(json.dumps(final, indent=2))
    print(f"#   wrote {final_path}")


if __name__ == "__main__":
    main()
