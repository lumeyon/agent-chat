"""Local-model runner via HuggingFace transformers.

v0.0.2 uses HF transformers directly (already installed). vLLM swap-in is
queued as v0.0.3; not blocking on the heavier install when HF works.

Default: Qwen-2.5-1.5B-Instruct — fits comfortably on the 4090 in FP16
(~3GB), matches the v0.1 RL training target per prompt.md, fast generation
(~3-5s per K=64 tokens). Graduate to Qwen-2.5-7B-Instruct later via the
`model_name` parameter.

Module-level cache: model + tokenizer load once per process. Generation
is sequential (no thread pool) since GPU contention slows things down
more than parallelism saves."""
import os
import time
from typing import Optional
import torch
from .api_runners import RunResult

DEFAULT_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"

_cache: dict = {}


def get_local_model(model_name: str = DEFAULT_MODEL, device: str = "cuda"):
    """Load (and cache) the model + tokenizer. Returns (model, tokenizer)."""
    key = (model_name, device)
    if key in _cache:
        return _cache[key]
    os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model_name)
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_name, dtype=dtype)
    model = model.to(device)
    model.eval()
    _cache[key] = (model, tok)
    return _cache[key]


def _format_chat(tokenizer, prompt: str) -> str:
    try:
        return tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False, add_generation_prompt=True,
        )
    except Exception:
        return prompt


def run_qwen_local(
    prompt: str,
    *,
    model_name: str = DEFAULT_MODEL,
    max_new_tokens: int = 512,
    temperature: float = 1.0,
    top_p: float = 0.95,
    seed: Optional[int] = None,
    device: str = "cuda",
) -> RunResult:
    """Generate one completion. Reflects same RunResult shape as API runners."""
    t0 = time.time()
    try:
        model, tokenizer = get_local_model(model_name, device=device)
        text_in = _format_chat(tokenizer, prompt)
        enc = tokenizer(text_in, return_tensors="pt").to(device)
        if seed is not None:
            torch.manual_seed(seed)
        with torch.no_grad():
            out = model.generate(
                **enc,
                max_new_tokens=max_new_tokens,
                do_sample=temperature > 0,
                temperature=temperature if temperature > 0 else 1.0,
                top_p=top_p,
                pad_token_id=tokenizer.eos_token_id,
            )
        new_ids = out[0, enc["input_ids"].shape[1]:].tolist()
        text = tokenizer.decode(new_ids, skip_special_tokens=True).strip()
        elapsed_ms = int((time.time() - t0) * 1000)
        agent_label = f"qwen-{model_name.split('/')[-1].lower().replace('-instruct','')}"
        return RunResult(text=text, elapsed_ms=elapsed_ms, status=0,
                         agent=agent_label, error=None)
    except Exception as e:
        return RunResult(
            text="", elapsed_ms=int((time.time() - t0) * 1000),
            status=-1, agent=f"qwen-{model_name.split('/')[-1].lower()}",
            error=f"{type(e).__name__}: {str(e)[:300]}",
        )
