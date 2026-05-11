"""Held-out evaluation of trained checkpoints.

Loads a base model + optional LoRA adapter, runs on a JSONL eval set,
extracts answer letters via the substrate's QA verifier, computes
accuracy and bootstrap CI for trained-vs-base comparisons.

This is the A/B gate from TANG_EXPLORATION.md: trained model must beat
base by ≥3% with 95% bootstrap CI excluding 0.
"""
import argparse
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch

from .env import RLEnvSpec, build_query_text, mcq_reward
from ..verifier.qa_verifier import extract_answer_letter


@dataclass
class EvalResult:
    n: int
    n_correct: int
    accuracy: float
    per_question: list[dict] = field(default_factory=list)


def _load_model_and_tokenizer(base_model: str, adapter_path: Optional[Path], device: str = "cuda"):
    """Load the base model and optionally apply a LoRA adapter."""
    os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(base_model)
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(base_model, dtype=dtype).to(device)
    if adapter_path is not None:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter_path))
    model.eval()
    return model, tok


def _format_chat(tokenizer, prompt: str) -> str:
    try:
        return tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False, add_generation_prompt=True,
        )
    except Exception:
        return prompt


def evaluate_model_on_jsonl(
    eval_jsonl: Path,
    base_model: str = "Qwen/Qwen2.5-1.5B-Instruct",
    adapter_path: Optional[Path] = None,
    max_new_tokens: int = 512,
    temperature: float = 0.0,  # greedy by default for reproducible eval
    device: str = "cuda",
) -> EvalResult:
    """Run model on each row of the JSONL; return accuracy + per-question detail."""
    rows = []
    for line in Path(eval_jsonl).read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        rows.append(RLEnvSpec(
            id=r["id"], domain=r["domain"], subdomain=r["subdomain"],
            question=r["question"], choices=r["choices"], answer=r["answer"],
        ))

    model, tok = _load_model_and_tokenizer(base_model, adapter_path, device=device)

    n_correct = 0
    per_question = []
    for spec in rows:
        prompt_text = _format_chat(tok, build_query_text(spec))
        enc = tok(prompt_text, return_tensors="pt").to(device)
        with torch.no_grad():
            out = model.generate(
                **enc,
                max_new_tokens=max_new_tokens,
                do_sample=temperature > 0,
                temperature=temperature if temperature > 0 else 1.0,
                pad_token_id=tok.eos_token_id,
            )
        new_ids = out[0, enc["input_ids"].shape[1]:].tolist()
        text = tok.decode(new_ids, skip_special_tokens=True)
        extracted = extract_answer_letter(text)
        is_correct = extracted == spec.answer
        if is_correct:
            n_correct += 1
        per_question.append({
            "id": spec.id, "expected": spec.answer,
            "extracted": extracted, "correct": bool(is_correct),
            "response": text[:500],
        })
    return EvalResult(
        n=len(rows), n_correct=n_correct,
        accuracy=n_correct / max(1, len(rows)), per_question=per_question,
    )


def bootstrap_delta_ci(
    arr_a: list[int],
    arr_b: list[int],
    n_bootstrap: int = 10000,
    seed: int = 0,
    one_sided_alt: str = "a > b",
) -> dict:
    """Bootstrap the difference (sum_a - sum_b) on paired correct/incorrect arrays."""
    a = np.array(arr_a, dtype=np.int64)
    b = np.array(arr_b, dtype=np.int64)
    assert a.shape == b.shape, "paired comparison requires same length"
    n = len(a)
    rng = np.random.default_rng(seed)
    deltas = np.empty(n_bootstrap, dtype=np.int64)
    for i in range(n_bootstrap):
        idx = rng.integers(0, n, size=n)
        deltas[i] = a[idx].sum() - b[idx].sum()
    ci_low = float(np.percentile(deltas, 2.5))
    ci_high = float(np.percentile(deltas, 97.5))
    if one_sided_alt == "a > b":
        p_one_sided = float((deltas <= 0).mean())
    else:
        p_one_sided = float((deltas >= 0).mean())
    return {
        "n": int(n),
        "mean_delta": float(deltas.mean()),
        "ci_low": ci_low,
        "ci_high": ci_high,
        "ci_low_pct": ci_low / n * 100,
        "ci_high_pct": ci_high / n * 100,
        "p_one_sided": p_one_sided,
        "raw_a_correct": int(a.sum()),
        "raw_b_correct": int(b.sum()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--base-model", default="Qwen/Qwen2.5-1.5B-Instruct")
    ap.add_argument("--adapter", type=Path, default=None,
                    help="Optional LoRA adapter to apply on top of base model")
    ap.add_argument("--output", type=Path, default=None)
    ap.add_argument("--max-new-tokens", type=int, default=512)
    args = ap.parse_args()

    print(f"# evaluating {args.base_model}" + (f" + adapter {args.adapter}" if args.adapter else ""))
    print(f"# eval set: {args.eval_set}")
    r = evaluate_model_on_jsonl(args.eval_set, args.base_model, args.adapter,
                                max_new_tokens=args.max_new_tokens)
    print(f"# accuracy: {r.n_correct}/{r.n} = {r.accuracy*100:.1f}%")
    if args.output:
        args.output.write_text(json.dumps({
            "n": r.n, "n_correct": r.n_correct, "accuracy": r.accuracy,
            "per_question": r.per_question,
            "base_model": args.base_model,
            "adapter": str(args.adapter) if args.adapter else None,
        }, indent=2))
        print(f"# wrote {args.output}")


if __name__ == "__main__":
    main()
