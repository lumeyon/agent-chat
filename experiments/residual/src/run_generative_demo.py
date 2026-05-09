"""Headline demo for Track B: side-by-side comparison of three decoding modes
on a fixed prompt set.

For each prompt, generates:
  - greedy (argmax)
  - temperature τ=0.8 (the standard sampling baseline)
  - residual-projected sampling (Track B's contribution)

Saves to experiments/residual/results/generative_demo.json with the prompts,
all three responses, calibration set summary, and basis info."""
import json
import os
import sys
from pathlib import Path
import torch
from .generative import (
    load_model, calibrate_on_prompts, generate_with_residual, generate_baseline,
)

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"

# Calibration set: simple, instruction-following queries (the "typical assistant
# behavior" subspace we want to project AWAY from).
CALIBRATION_PROMPTS = [
    "What is 2+2?",
    "Define gravity briefly.",
    "Name a primary color.",
    "What is the capital of France?",
    "Describe the water cycle.",
    "What is photosynthesis?",
    "Name a chemical element.",
    "What is DNA?",
    "Explain Newton's first law.",
    "What is osmosis?",
    "What is the boiling point of water?",
    "Define mitosis.",
    "What is the speed of light?",
    "Name an organ in the human body.",
    "What is the chemical formula for water?",
    "Define an atom.",
    "What is the largest planet?",
    "Name a famous physicist.",
    "What is electricity?",
    "Define entropy briefly.",
    "What is a cell?",
    "Define velocity.",
    "What is friction?",
    "Name a noble gas.",
    "What is photovoltaic effect?",
]

# Demo prompts: harder / more open-ended queries where we expect the residual
# sampler to produce noticeably different continuations from greedy/temperature.
DEMO_PROMPTS = [
    "Write one creative metaphor connecting quantum mechanics to art.",
    "Imagine an unconventional use of a paperclip and describe it briefly.",
    "Name three things people get wrong about black holes.",
    "Suggest a research direction that combines biology and information theory.",
    "Describe how you would explain photosynthesis to a 5-year-old.",
    "What is one underappreciated property of the number zero?",
    "Suggest an unusual analogy for how memory works.",
    "Name a question that physicists are still arguing about.",
]


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"# device={device}")
    print("# loading Qwen2.5-1.5B-Instruct...")
    model, tokenizer = load_model("Qwen/Qwen2.5-1.5B-Instruct", device=device)
    print("# loaded; calibrating residual basis...")
    basis = calibrate_on_prompts(model, tokenizer, CALIBRATION_PROMPTS, k=8, device=device)
    print(f"# basis shape {tuple(basis.shape)}")

    rows = []
    for i, prompt in enumerate(DEMO_PROMPTS):
        print(f"# [{i+1}/{len(DEMO_PROMPTS)}] {prompt[:60]}...")
        greedy = generate_baseline(model, tokenizer, prompt, mode="greedy",
                                   max_new_tokens=100, device=device)
        temp = generate_baseline(model, tokenizer, prompt, mode="temperature",
                                 max_new_tokens=100, temperature=0.8, seed=i, device=device)
        resid = generate_with_residual(model, tokenizer, prompt, basis,
                                       max_new_tokens=100, temperature=0.8, seed=i, device=device)
        rows.append({
            "prompt": prompt,
            "greedy": greedy,
            "temperature_0.8": temp,
            "residual_projected": resid,
        })

    out = {
        "model": "Qwen/Qwen2.5-1.5B-Instruct",
        "calibration_n": len(CALIBRATION_PROMPTS),
        "basis_k": int(basis.shape[0]),
        "basis_vocab_size": int(basis.shape[1]),
        "demo": rows,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RESULTS_DIR / "generative_demo.json"
    out_path.write_text(json.dumps(out, indent=2))
    print(f"# wrote {out_path}")

    # Append a side-by-side digest to summary.md.
    summary = RESULTS_DIR / "summary.md"
    existing = summary.read_text() if summary.exists() else ""
    lines = ["\n## Track B — generative residual sampler (Qwen2.5-1.5B-Instruct)\n"]
    lines.append(f"calibration n={len(CALIBRATION_PROMPTS)}, basis k={out['basis_k']}, vocab={out['basis_vocab_size']}\n")
    for r in rows:
        lines.append(f"\n### Prompt: {r['prompt']}\n")
        lines.append(f"- **greedy**: {r['greedy'][:300]}")
        lines.append(f"- **temperature 0.8**: {r['temperature_0.8'][:300]}")
        lines.append(f"- **residual-projected**: {r['residual_projected'][:300]}")
    summary.write_text(existing + "\n".join(lines))
    print(f"# appended Track B section to {summary}")


if __name__ == "__main__":
    main()
