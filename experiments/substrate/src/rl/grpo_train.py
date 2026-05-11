"""GRPO training loop on the 4090 — component 6, the substrate's keystone.

Minimum-viable v0.0.1: train Qwen-2.5-1.5B-Instruct via TRL's GRPOTrainer
on a small set of MCQ-style training questions, with the substrate's QA
verifier as the reward function.

Goal of v0.0.1: prove the loop runs end-to-end on the 4090 without
crashing and produces a checkpoint. NOT yet "trained model is better
than base." That comes in v0.1+ with bigger training set + more steps.

Usage:
  TMPDIR=/data/tmp HF_HOME=/data/cache/huggingface \\
    python -m experiments.substrate.src.rl.grpo_train \\
      --train-questions <path-to-jsonl> \\
      --base-model Qwen/Qwen2.5-1.5B-Instruct \\
      --output-dir experiments/substrate/models/qwen-1.5b-rl-v0.0.1 \\
      --max-steps 5 \\
      --num-generations 4
"""
import argparse
import json
from pathlib import Path
from typing import Optional

import torch
from .env import RLEnvSpec, build_query_text, mcq_reward, mcq_reward_with_format


def load_train_questions(path: Path) -> list[RLEnvSpec]:
    """Load training questions from a JSONL file with the GPQA Diamond schema."""
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        rows.append(RLEnvSpec(
            id=r["id"],
            domain=r["domain"],
            subdomain=r["subdomain"],
            question=r["question"],
            choices=r["choices"],
            answer=r["answer"],
        ))
    return rows


def make_dataset(specs: list[RLEnvSpec]):
    """TRL's GRPOTrainer expects a HuggingFace Dataset with a 'prompt' column.
    We attach the spec as 'spec_id' so the reward function can look up the
    ground-truth answer."""
    from datasets import Dataset
    return Dataset.from_list([
        {"prompt": build_query_text(s), "spec_id": s.id}
        for s in specs
    ])


def make_reward_fn(specs: list[RLEnvSpec], reward_kind: str = "binary"):
    """Build a reward function GRPOTrainer can call.

    reward_kind ∈ {'binary', 'with_format'}:
      - 'binary': 1.0 correct, 0.0 wrong/unparseable (v0.1)
      - 'with_format': 1.0 correct, 0.3 wrong-but-parseable, 0.0 unparseable
        (v0.2 — addresses reward sparsity)
    """
    by_id = {s.id: s for s in specs}
    reward_func = mcq_reward_with_format if reward_kind == "with_format" else mcq_reward

    def reward_fn(completions, **kwargs):
        spec_ids = kwargs.get("spec_id", [])
        rewards = []
        for completion, sid in zip(completions, spec_ids):
            spec = by_id.get(sid)
            if spec is None:
                rewards.append(0.0)
                continue
            if isinstance(completion, list):
                text = "".join(m.get("content", "") for m in completion)
            else:
                text = str(completion)
            rewards.append(reward_func(text, spec))
        return rewards

    return reward_fn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-questions", type=Path, required=True,
                    help="Path to JSONL with GPQA-schema training questions")
    ap.add_argument("--base-model", default="Qwen/Qwen2.5-1.5B-Instruct")
    ap.add_argument("--output-dir", type=Path, default=Path("experiments/substrate/models/qwen-rl-v0.0.1"))
    ap.add_argument("--max-steps", type=int, default=5)
    ap.add_argument("--num-generations", type=int, default=4,
                    help="K candidates per query during rollout (GRPO group size)")
    ap.add_argument("--learning-rate", type=float, default=5e-6)
    ap.add_argument("--max-completion-length", type=int, default=1024,
                    help="Cap on per-rollout completion length. v0.1-v0.3 used 512 "
                         "and EVERY completion clipped at the cap "
                         "(completions/clipped_ratio=1.0, max_terminated_length=0). "
                         "Model never learned to terminate with an answer. 1024 "
                         "is the new default for graduate-MCQ reasoning tasks.")
    ap.add_argument("--save-steps", type=int, default=0,
                    help="Save adapter every N steps (0 = save only at end). "
                         "Use ~100 for v0.4+ runs so a kill mid-training still "
                         "yields a usable checkpoint.")
    ap.add_argument("--lora-rank", type=int, default=16,
                    help="LoRA r (default 16). For Qwen-7B QLoRA, the standard "
                         "QLoRA paper recommends r=64. v0.4e tests this.")
    ap.add_argument("--lora-alpha", type=int, default=0,
                    help="LoRA alpha (default = 2 * lora_rank, which is the "
                         "scaling factor convention used by v0.1-v0.4d).")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--reward-kind", default="binary",
                    choices=["binary", "with_format"],
                    help="binary: 1.0/0.0 (v0.1); with_format: 1.0/0.3/0.0 partial credit (v0.2)")
    ap.add_argument("--quantize", default="none",
                    choices=["none", "4bit", "8bit"],
                    help="QLoRA: load base model in 4-bit (NF4) or 8-bit. "
                         "Required to fit Qwen-2.5-7B on a 24GB 4090 with GRPO.")
    args = ap.parse_args()

    print(f"# substrate component 6: GRPO training v0.0.1")
    print(f"# base-model: {args.base_model}")
    print(f"# output-dir: {args.output_dir}")
    print(f"# max-steps: {args.max_steps}")
    print(f"# num-generations (K): {args.num_generations}")

    # Load training data
    specs = load_train_questions(args.train_questions)
    print(f"# loaded {len(specs)} training questions")

    dataset = make_dataset(specs)
    reward_fn = make_reward_fn(specs, reward_kind=args.reward_kind)
    print(f"# reward kind: {args.reward_kind}")

    # Imports here so a --help doesn't fork-bomb torch import
    from trl import GRPOConfig, GRPOTrainer
    from peft import LoraConfig

    # LoRA essential on a 24GB 4090: full fine-tune of Qwen-1.5B + GRPO's
    # frozen reference + Adam states exceeds 24GB (we hit OOM in v0.0.1
    # without LoRA). LoRA reduces trainable params from ~1.5B to ~5M and
    # optimizer state proportionally.
    lora_alpha = args.lora_alpha if args.lora_alpha > 0 else 2 * args.lora_rank
    print(f"# LoRA rank={args.lora_rank}, alpha={lora_alpha}")
    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=lora_alpha,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )

    # TRL GRPO requires generation_batch_size (= per_device_batch * gradient_accum)
    # to be divisible by num_generations. Set them equal so 1 prompt produces K
    # generations per step.
    training_args = GRPOConfig(
        output_dir=str(args.output_dir),
        learning_rate=args.learning_rate,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.num_generations,
        gradient_accumulation_steps=1,
        num_generations=args.num_generations,
        max_completion_length=args.max_completion_length,
        bf16=True,
        save_steps=(args.save_steps if args.save_steps > 0 else args.max_steps),
        logging_steps=1,
        report_to="none",
        seed=args.seed,
        gradient_checkpointing=True,  # trade compute for memory
    )

    # QLoRA path: pre-load the base model in 4-/8-bit so the LoRA adapters
    # train on top of a quantized backbone. This is what makes Qwen-2.5-7B
    # tractable on a 24GB 4090 — the quantized weights are ~5GB and the
    # frozen GRPO reference is also quantized.
    model_arg: object = args.base_model
    if args.quantize != "none":
        from transformers import AutoModelForCausalLM, BitsAndBytesConfig
        from peft import prepare_model_for_kbit_training
        bnb_kwargs = dict(
            load_in_4bit=(args.quantize == "4bit"),
            load_in_8bit=(args.quantize == "8bit"),
        )
        if args.quantize == "4bit":
            bnb_kwargs.update(
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
        bnb_config = BitsAndBytesConfig(**bnb_kwargs)
        print(f"# loading {args.base_model} with quantize={args.quantize}...")
        loaded = AutoModelForCausalLM.from_pretrained(
            args.base_model,
            quantization_config=bnb_config,
            device_map="auto",
            dtype=torch.bfloat16,
        )
        loaded = prepare_model_for_kbit_training(loaded, use_gradient_checkpointing=True)
        model_arg = loaded
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            print(f"# post-quant-load VRAM: free={free/1e9:.1f}GB / total={total/1e9:.1f}GB")

    print(f"# initializing GRPOTrainer with LoRA (loads model + tokenizer)...")
    trainer = GRPOTrainer(
        model=model_arg,
        args=training_args,
        train_dataset=dataset,
        reward_funcs=reward_fn,
        peft_config=lora_config,
    )

    # Show GPU state before training
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        print(f"# pre-train VRAM: free={free/1e9:.1f}GB / total={total/1e9:.1f}GB")

    print(f"# starting GRPO training for {args.max_steps} steps...")
    trainer.train()
    print(f"# training complete; saving final checkpoint to {args.output_dir}")
    trainer.save_model(str(args.output_dir))


if __name__ == "__main__":
    main()
