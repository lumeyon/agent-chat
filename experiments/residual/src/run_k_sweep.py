"""Track B k-sweep: vary the basis dimension k across {1, 4, 16, 64} and
inspect how the residual-projected generation diverges from greedy.

Same calibration set, same demo prompts, same temperature (0.8), same seed.
Only k changes. Saves all outputs to results/k_sweep.json + appended digest
to summary.md."""
import json
from pathlib import Path
import torch
from .generative import (
    load_model, calibrate_on_prompts, generate_with_residual, generate_baseline,
)
from .run_generative_demo import CALIBRATION_PROMPTS, DEMO_PROMPTS, RESULTS_DIR


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")
    model, tokenizer = load_model("Qwen/Qwen2.5-1.5B-Instruct", device=device)
    print("# loaded; sweeping k ∈ {1, 4, 16, 64}")

    # Greedy reference is k-independent; compute once.
    greedy_outputs = []
    for prompt in DEMO_PROMPTS[:4]:
        out = generate_baseline(model, tokenizer, prompt, mode="greedy",
                                max_new_tokens=80, device=device)
        greedy_outputs.append(out)

    sweep = {}
    for k in (1, 4, 16, 64):
        if k > len(CALIBRATION_PROMPTS):
            print(f"# skipping k={k}: > calibration set size")
            continue
        print(f"# k={k} basis...")
        basis = calibrate_on_prompts(model, tokenizer, CALIBRATION_PROMPTS, k=k, device=device)
        outputs = []
        for i, prompt in enumerate(DEMO_PROMPTS[:4]):
            resid = generate_with_residual(model, tokenizer, prompt, basis,
                                           max_new_tokens=80, temperature=0.8,
                                           seed=i, device=device)
            outputs.append(resid)
        sweep[k] = outputs

    out = {
        "model": "Qwen/Qwen2.5-1.5B-Instruct",
        "calibration_n": len(CALIBRATION_PROMPTS),
        "k_values": list(sweep.keys()),
        "prompts": DEMO_PROMPTS[:4],
        "greedy_reference": greedy_outputs,
        "residual_per_k": sweep,
    }
    out_path = RESULTS_DIR / "k_sweep.json"
    out_path.write_text(json.dumps(out, indent=2))
    print(f"# wrote {out_path}")

    # Append digest.
    summary = RESULTS_DIR / "summary.md"
    existing = summary.read_text() if summary.exists() else ""
    lines = ["\n## Track B — k-sweep (Qwen2.5-1.5B-Instruct)\n"]
    lines.append(f"calibration n={len(CALIBRATION_PROMPTS)}, k values: {list(sweep.keys())}\n")
    for i, prompt in enumerate(DEMO_PROMPTS[:4]):
        lines.append(f"\n### Prompt: {prompt}\n")
        lines.append(f"- **greedy** (k=N/A): {greedy_outputs[i][:200]}")
        for k in sweep:
            lines.append(f"- **k={k}**: {sweep[k][i][:200]}")
    summary.write_text(existing + "\n".join(lines))
    print(f"# appended k-sweep section to {summary}")


if __name__ == "__main__":
    main()
