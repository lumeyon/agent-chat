"""Track B — generative residual sampler with local LLM logits.

The pipeline:
  1. Calibration: capture logit vectors from a base model on a corpus of
     "typical" prompts. Stack them into a (n_calibration, vocab_size)
     matrix M.
  2. Compute V_k = top-k right singular vectors of M. This is the basis
     of the "typical continuation" subspace.
  3. At generation time: residual_logits = logits - V_k.T (V_k @ logits).
     Apply softmax(residual_logits / τ) to sample the next token.

Tokens that lie predominantly inside the typical-continuation subspace
have residual ≈ 0 and become unlikely. Tokens with components in the
orthogonal subspace are upweighted relative to typical.

Default model: Qwen2.5-1.5B-Instruct (Apache 2.0, no HF login required,
~3GB FP16, fits with massive headroom on a 4090)."""
import os
from typing import Optional
import torch


def compute_residual_basis(M: torch.Tensor, k: int) -> torch.Tensor:
    """Top-k right singular vectors as ROWS. Returns (k, V).

    The basis represents the dominant directions in row-space — i.e., the
    "typical continuation" subspace. Use with project_to_residual to remove
    a vector's projection onto this subspace."""
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    if k > min(M.shape):
        raise ValueError(f"k={k} > min(M.shape)={min(M.shape)}")
    M_f = M.float()
    # Center M before SVD so residuals are around the mean.
    Mc = M_f - M_f.mean(dim=0, keepdim=True)
    U, S, Vh = torch.linalg.svd(Mc, full_matrices=False)
    return Vh[:k, :]


def project_to_residual(logits: torch.Tensor, basis: torch.Tensor) -> torch.Tensor:
    """Returns logits - basis^T @ (basis @ logits) — the component of logits
    orthogonal to every row of basis."""
    if logits.dim() != 1:
        raise ValueError(f"logits must be 1-D, got shape {tuple(logits.shape)}")
    if basis.shape[1] != logits.shape[0]:
        raise ValueError(f"basis cols ({basis.shape[1]}) != logits dim ({logits.shape[0]})")
    coeffs = basis @ logits                # (k,)
    proj = basis.T @ coeffs                # (V,)
    return logits - proj


def sample_from_residual_logits(
    residual_logits: torch.Tensor,
    temperature: float,
    seed: Optional[int] = None,
) -> int:
    """Softmax-sample (or argmax at τ=0)."""
    if temperature == 0.0:
        return int(torch.argmax(residual_logits).item())
    scaled = residual_logits / temperature
    probs = torch.softmax(scaled, dim=-1)
    g = torch.Generator(device=residual_logits.device).manual_seed(seed if seed is not None else 0)
    tok = torch.multinomial(probs, 1, generator=g).item()
    return int(tok)


def load_model(model_name: str = "Qwen/Qwen2.5-1.5B-Instruct", device: str = "cuda"):
    os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model_name)
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_name, dtype=dtype)
    model = model.to(device)
    model.eval()
    return model, tok


def _format_chat(tokenizer, prompt: str) -> str:
    """Use the model's chat template if available."""
    try:
        return tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False, add_generation_prompt=True,
        )
    except Exception:
        return prompt


def calibrate_on_prompts(
    model,
    tokenizer,
    prompts: list[str],
    k: int = 16,
    device: str = "cuda",
) -> torch.Tensor:
    """Run model on prompts, capture the logit vector at the FIRST generation
    step for each, and return the top-k SVD basis of those logit vectors."""
    rows = []
    for p in prompts:
        text = _format_chat(tokenizer, p)
        enc = tokenizer(text, return_tensors="pt").to(device)
        with torch.no_grad():
            out = model(**enc)
        logits_last = out.logits[0, -1, :].float().cpu()
        rows.append(logits_last)
    M = torch.stack(rows)
    return compute_residual_basis(M, k=k)


def generate_with_residual(
    model,
    tokenizer,
    prompt: str,
    basis: torch.Tensor,
    max_new_tokens: int = 64,
    temperature: float = 0.8,
    seed: int = 0,
    device: str = "cuda",
) -> str:
    """Greedy/sampling loop where each step's logits get residual-projected
    before softmax sampling."""
    text = _format_chat(tokenizer, prompt)
    enc = tokenizer(text, return_tensors="pt").to(device)
    input_ids = enc["input_ids"]
    basis_d = basis.to(device).float()
    eos_id = tokenizer.eos_token_id
    for step in range(max_new_tokens):
        with torch.no_grad():
            out = model(input_ids=input_ids)
        logits = out.logits[0, -1, :].float()
        residual = project_to_residual(logits, basis_d)
        next_tok = sample_from_residual_logits(residual, temperature, seed=seed + step)
        input_ids = torch.cat([input_ids, torch.tensor([[next_tok]], device=device)], dim=1)
        if eos_id is not None and next_tok == eos_id:
            break
    new_ids = input_ids[0, enc["input_ids"].shape[1]:].tolist()
    return tokenizer.decode(new_ids, skip_special_tokens=True)


def generate_baseline(
    model,
    tokenizer,
    prompt: str,
    mode: str = "greedy",
    max_new_tokens: int = 64,
    temperature: float = 0.8,
    seed: int = 0,
    device: str = "cuda",
) -> str:
    """Reference baselines: greedy or temperature sampling without residual projection."""
    text = _format_chat(tokenizer, prompt)
    enc = tokenizer(text, return_tensors="pt").to(device)
    input_ids = enc["input_ids"]
    eos_id = tokenizer.eos_token_id
    g = torch.Generator(device=device).manual_seed(seed)
    for _ in range(max_new_tokens):
        with torch.no_grad():
            out = model(input_ids=input_ids)
        logits = out.logits[0, -1, :].float()
        if mode == "greedy":
            tok = int(torch.argmax(logits).item())
        else:  # temperature
            probs = torch.softmax(logits / temperature, dim=-1)
            tok = int(torch.multinomial(probs, 1, generator=g).item())
        input_ids = torch.cat([input_ids, torch.tensor([[tok]], device=device)], dim=1)
        if eos_id is not None and tok == eos_id:
            break
    new_ids = input_ids[0, enc["input_ids"].shape[1]:].tolist()
    return tokenizer.decode(new_ids, skip_special_tokens=True)
