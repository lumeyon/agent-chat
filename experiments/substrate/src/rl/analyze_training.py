"""Health report for a finished GRPO training run.

Reads `trainer_state.json` from a checkpoint and reports:
  - reward trajectory (first / mid / last 50 steps)
  - completion-length pathology (clip-bound? ever terminated naturally?)
  - signal density (fraction of steps with zero-variance reward groups)
  - loss magnitude
  - step time

Used to validate v0.4b's training was healthier than v0.1-v0.3 (which
were silently clip-bound at 512 tokens — `completions/clipped_ratio: 1.0`
across all 500 steps).

Usage:
  python -m experiments.substrate.src.rl.analyze_training \
    experiments/substrate/models/qwen-rl-v0.4b/checkpoint-500/trainer_state.json
"""
import argparse
import json
import statistics
from pathlib import Path


def analyze(state_path: Path) -> dict:
    state = json.loads(state_path.read_text())
    log = state["log_history"]
    if not log:
        return {"error": "log_history is empty"}

    rewards = [e["reward"] for e in log]
    losses = [e["loss"] for e in log]
    zero_std = [e["frac_reward_zero_std"] for e in log]
    mean_lens = [e["completions/mean_length"] for e in log]
    clip_ratios = [e["completions/clipped_ratio"] for e in log]
    term_lens = [e["completions/max_terminated_length"] for e in log]
    step_times = [e["step_time"] for e in log]
    grad_norms = [e["grad_norm"] for e in log]

    n = len(log)
    seg = max(1, min(50, n // 4))
    return {
        "max_steps": state.get("max_steps"),
        "global_step": state.get("global_step"),
        "n_logged": n,
        "reward": {
            "first_seg_mean": statistics.mean(rewards[:seg]),
            "mid_seg_mean": statistics.mean(rewards[n // 2 - seg // 2:n // 2 + seg // 2]),
            "last_seg_mean": statistics.mean(rewards[-seg:]),
            "delta_first_to_last": statistics.mean(rewards[-seg:]) - statistics.mean(rewards[:seg]),
            "overall_mean": statistics.mean(rewards),
        },
        "completion_length": {
            "max_completion_length": int(max(mean_lens)),
            "mean_clip_ratio": statistics.mean(clip_ratios),
            "frac_steps_fully_clipped": sum(1 for c in clip_ratios if c >= 0.999) / n,
            "frac_steps_with_any_termination": sum(1 for t in term_lens if t > 0) / n,
            "max_observed_terminated_len": max(term_lens),
        },
        "signal_density": {
            "frac_steps_with_zero_variance": sum(1 for z in zero_std if z > 0) / n,
        },
        "loss_magnitude": {
            "max_abs_loss": max(abs(l) for l in losses),
            "mean_abs_loss": statistics.mean(abs(l) for l in losses),
        },
        "grad_norm": {
            "max": max(grad_norms),
            "mean": statistics.mean(grad_norms),
        },
        "throughput": {
            "mean_step_time_sec": statistics.mean(step_times),
            "total_train_time_hr": sum(step_times) / 3600,
        },
    }


def format_report(r: dict) -> str:
    if "error" in r:
        return f"ERROR: {r['error']}"
    lines = []
    lines.append(f"Training run: {r['global_step']}/{r['max_steps']} steps logged ({r['n_logged']} entries)")
    lines.append("")
    rwd = r["reward"]
    lines.append("=== Reward trajectory ===")
    lines.append(f"  first 50 mean : {rwd['first_seg_mean']:.3f}")
    lines.append(f"  mid 50 mean   : {rwd['mid_seg_mean']:.3f}")
    lines.append(f"  last 50 mean  : {rwd['last_seg_mean']:.3f}")
    lines.append(f"  delta (last-first) : {rwd['delta_first_to_last']:+.3f}  "
                 f"{'CLIMBED' if rwd['delta_first_to_last'] > 0.05 else 'flat/declined'}")
    lines.append("")
    cl = r["completion_length"]
    lines.append("=== Completion length pathology ===")
    lines.append(f"  max completion length      : {cl['max_completion_length']}")
    lines.append(f"  mean clip_ratio (all steps): {cl['mean_clip_ratio']:.3f}  "
                 f"{'WARNING — clip-bound (v0.1-v0.3 pattern)' if cl['mean_clip_ratio'] >= 0.95 else 'OK'}")
    lines.append(f"  steps 100% clipped         : {cl['frac_steps_fully_clipped']*100:.1f}%")
    lines.append(f"  steps with ANY termination : {cl['frac_steps_with_any_termination']*100:.1f}%")
    lines.append(f"  max observed terminated len: {cl['max_observed_terminated_len']:.0f}")
    lines.append("")
    sd = r["signal_density"]
    lines.append(f"=== GRPO signal density ===")
    lines.append(f"  steps with zero-variance group : {sd['frac_steps_with_zero_variance']*100:.1f}%  "
                 f"(higher = more wasted compute)")
    lines.append("")
    lm = r["loss_magnitude"]
    lines.append(f"=== Loss / gradient magnitude ===")
    lines.append(f"  max |loss| : {lm['max_abs_loss']:.2e}")
    lines.append(f"  mean |loss|: {lm['mean_abs_loss']:.2e}")
    gn = r["grad_norm"]
    lines.append(f"  max grad norm : {gn['max']:.3f}")
    lines.append(f"  mean grad norm: {gn['mean']:.3f}")
    lines.append("")
    tp = r["throughput"]
    lines.append(f"=== Throughput ===")
    lines.append(f"  mean step time : {tp['mean_step_time_sec']:.1f}s")
    lines.append(f"  total time     : {tp['total_train_time_hr']:.2f} hr")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trainer_state", type=Path,
                    help="Path to checkpoint-N/trainer_state.json")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()
    r = analyze(args.trainer_state)
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        print(format_report(r))


if __name__ == "__main__":
    main()
