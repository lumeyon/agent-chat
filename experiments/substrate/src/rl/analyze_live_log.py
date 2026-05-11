"""Parse a live (running or finished) GRPO log and report training progress.

TRL's GRPOTrainer prints a dict-shaped log entry per step (when
`logging_steps=1`) to stdout. This tool extracts those dicts via regex,
so we can see reward trajectory + completion-length pathology in
real-time, without waiting for `trainer_state.json` (which is only
written at save_steps).

Usage:
  python -m experiments.substrate.src.rl.analyze_live_log \
    experiments/substrate/results/train_v0.4b.log
"""
import argparse
import json
import re
import statistics
from pathlib import Path

# TRL log entries look like:
# {'loss': '-8.94e-08', 'grad_norm': '0.124', 'learning_rate': '4.99e-06',
#  'num_tokens': '9256', 'completions/mean_length': '1024', ...,
#  'reward': '0.65', 'reward_std': '0.4041', 'frac_reward_zero_std': '0',
#  'entropy': '...', ..., 'epoch': '0.002'}
ENTRY_RE = re.compile(r"\{'loss':[^}]*\}")
KEY_RE = re.compile(r"'([^']+)':\s*'([^']*)'")


def parse_log(log_path: Path) -> list[dict]:
    text = log_path.read_text(errors="replace")
    text = text.replace("\r", "\n")
    entries = []
    for m in ENTRY_RE.finditer(text):
        d = {}
        for km in KEY_RE.finditer(m.group()):
            k, v = km.group(1), km.group(2)
            try:
                d[k] = float(v)
            except ValueError:
                d[k] = v
        if d:
            entries.append(d)
    return entries


def report(entries: list[dict]) -> str:
    n = len(entries)
    if n == 0:
        return "No entries parsed."
    lines = [f"Parsed {n} step entries from log."]

    # Reward trajectory
    rewards = [e.get("reward", 0) for e in entries]
    seg = max(1, min(50, n // 4))
    first_seg = rewards[:seg]
    last_seg = rewards[-seg:]
    first = statistics.mean(first_seg)
    last = statistics.mean(last_seg)
    # Standard error of the difference of means (assuming independence,
    # equal-size segments). For small n, this is more honest than just
    # reporting the delta — most early-training "climbs" are within 1-2σ.
    var_first = statistics.variance(first_seg) if len(first_seg) > 1 else 0.0
    var_last = statistics.variance(last_seg) if len(last_seg) > 1 else 0.0
    se_delta = ((var_first + var_last) / seg) ** 0.5 if seg > 0 else 0.0
    delta = last - first
    z_score = delta / se_delta if se_delta > 0 else 0.0

    lines.append("")
    lines.append(f"=== Reward trajectory (n={n}, seg={seg}) ===")
    lines.append(f"  first {seg} mean : {first:.3f}  (var {var_first:.3f})")
    if n > 2 * seg:
        mid_start = n // 2 - seg // 2
        mid = statistics.mean(rewards[mid_start:mid_start + seg])
        lines.append(f"  mid {seg} mean   : {mid:.3f}")
    lines.append(f"  last {seg} mean  : {last:.3f}  (var {var_last:.3f})")
    # Verdict: requires |z| > 2 to call "CLIMBED" or "DECLINED"
    if z_score > 2.0:
        verdict = "CLIMBED (z > 2σ, real signal)"
    elif z_score < -2.0:
        verdict = "DECLINED (z < -2σ, real signal)"
    else:
        verdict = f"INCONCLUSIVE (|z|={abs(z_score):.2f}, within noise — need more steps)"
    lines.append(f"  delta first→last : {delta:+.3f}  σ_Δ={se_delta:.3f}  z={z_score:+.2f}  {verdict}")
    lines.append(f"  overall mean     : {statistics.mean(rewards):.3f}")

    # Reward distribution (histogram of reward values per step)
    from collections import Counter
    reward_buckets = Counter()
    for r in rewards:
        if r >= 0.95:
            reward_buckets["all_correct"] += 1
        elif r >= 0.7:
            reward_buckets["mostly_correct"] += 1
        elif r >= 0.4:
            reward_buckets["mixed"] += 1
        elif r >= 0.25:
            reward_buckets["mostly_wrong"] += 1
        else:
            reward_buckets["all_wrong_or_unparseable"] += 1
    lines.append(f"  distribution: " + " ".join(f"{k}={v}" for k, v in reward_buckets.most_common()))

    # Completion-length pathology
    if "completions/clipped_ratio" in entries[0]:
        clip = [e.get("completions/clipped_ratio", 0) for e in entries]
        term = [e.get("completions/max_terminated_length", 0) for e in entries]
        lines.append("")
        lines.append(f"=== Completion length ===")
        lines.append(f"  mean clip_ratio       : {statistics.mean(clip):.3f}")
        lines.append(f"  steps 100% clipped    : {sum(1 for c in clip if c >= 0.999)}/{n} = {sum(1 for c in clip if c >= 0.999)/n*100:.1f}%")
        lines.append(f"  steps with any termination : {sum(1 for t in term if t > 0)}/{n} = {sum(1 for t in term if t > 0)/n*100:.1f}%")
        lines.append(f"  max terminated length : {max(term):.0f}")

    # GRPO signal density
    if "frac_reward_zero_std" in entries[0]:
        zs = [e.get("frac_reward_zero_std", 0) for e in entries]
        lines.append("")
        lines.append(f"=== GRPO signal ===")
        lines.append(f"  zero-variance group steps : {sum(1 for z in zs if z > 0)}/{n} = {sum(1 for z in zs if z > 0)/n*100:.1f}%")

    # Loss / grad-norm
    losses = [abs(e.get("loss", 0)) for e in entries]
    grads = [e.get("grad_norm", 0) for e in entries]
    lines.append("")
    lines.append(f"=== Loss / grad ===")
    lines.append(f"  max |loss|     : {max(losses):.2e}")
    lines.append(f"  mean grad_norm : {statistics.mean(grads):.3f}")

    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log_path", type=Path,
                    help="Path to grpo_train.py stdout log")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    entries = parse_log(args.log_path)
    if args.json:
        print(json.dumps({"n": len(entries), "entries": entries}, indent=2, default=str))
    else:
        print(report(entries))


if __name__ == "__main__":
    main()
