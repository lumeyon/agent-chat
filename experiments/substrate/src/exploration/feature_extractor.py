"""Feature extraction for ensemble candidates.

Per TANG_EXPLORATION.md §4: ~400-dim feature vector per candidate combining
a 384-dim BGE-small embedding with 12 scalar reasoning-style markers.

Reuses the regex extractors from experiments/residual/src/response_features.py
(canonical) so the diagnostic substrate's findings transfer to the inference
substrate's exploration."""
import os
import re
from typing import Optional
import torch
from sentence_transformers import SentenceTransformer


EMBEDDER_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

# Regex markers — match those used in NL42's residual_features so the
# Track A clustering work transfers consistently. See
# experiments/residual/src/response_features.py for the canonical source.
HEDGE_RE = re.compile(r"\b(possibly|maybe|uncertain|might|perhaps|approximately|roughly|likely|seems|appears|tend to|tends to)\b", re.IGNORECASE)
CERTAIN_RE = re.compile(r"\b(clearly|definitely|certainly|undoubtedly|obviously|exactly|precisely|absolutely)\b", re.IGNORECASE)
SELF_CORRECT_RE = re.compile(r"\b(wait|actually|reconsider|let me reconsider|on second thought|hmm|hold on|scratch that|i was wrong|correction)\b", re.IGNORECASE)
LATEX_INLINE_RE = re.compile(r"\$[^$\n]+\$|\\\([^\)]+\\\)")
CODEBLOCK_RE = re.compile(r"```", re.MULTILINE)
ANSWER_LETTER_RE = re.compile(r"(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}(?![A-Za-z])", re.MULTILINE)


# Order is the canonical feature-vector layout. Update build_candidate_features
# in lockstep if you add a feature here.
FEATURE_NAMES = [
    "response_len",
    "n_latex",
    "n_codeblocks",
    "n_hedge_words",
    "n_certainty_words",
    "n_self_correction",
    "n_questions",
    "letter_A", "letter_B", "letter_C", "letter_D",
    "letter_unknown",
]


def extract_scalar_features(text: str) -> dict:
    """Return raw (un-z-scored) scalar features for one candidate."""
    if not text:
        text = ""
    matches = ANSWER_LETTER_RE.findall(text)
    final_letter: Optional[str] = matches[-1] if matches else None
    n_codeblocks_total = len(CODEBLOCK_RE.findall(text))
    return {
        "response_len": float(len(text)),
        "n_latex": float(len(LATEX_INLINE_RE.findall(text))),
        "n_codeblocks": float(n_codeblocks_total // 2),
        "n_hedge_words": float(len(HEDGE_RE.findall(text))),
        "n_certainty_words": float(len(CERTAIN_RE.findall(text))),
        "n_self_correction": float(len(SELF_CORRECT_RE.findall(text))),
        "n_questions": float(text.count("?")),
        "letter_A": 1.0 if final_letter == "A" else 0.0,
        "letter_B": 1.0 if final_letter == "B" else 0.0,
        "letter_C": 1.0 if final_letter == "C" else 0.0,
        "letter_D": 1.0 if final_letter == "D" else 0.0,
        "letter_unknown": 1.0 if final_letter is None else 0.0,
    }


_embedder_cache: SentenceTransformer | None = None


def _get_embedder(device: str = "cuda") -> SentenceTransformer:
    global _embedder_cache
    if _embedder_cache is None:
        os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
        dev = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
        _embedder_cache = SentenceTransformer(EMBEDDER_NAME, device=dev)
    return _embedder_cache


def build_candidate_features(
    candidates: list[str],
    device: str = "cuda",
    z_score_scalars: bool = True,
) -> torch.Tensor:
    """Build (n_candidates, EMBED_DIM + len(FEATURE_NAMES)) feature matrix.

    Embedding dims are unit-normalized by sentence-transformers; scalar dims
    are z-scored across the candidate pool so they're comparable in scale to
    the embedding."""
    if not candidates:
        return torch.zeros((0, EMBED_DIM + len(FEATURE_NAMES)))
    embedder = _get_embedder(device)
    embs = embedder.encode(
        candidates,
        convert_to_tensor=True,
        show_progress_bar=False,
        normalize_embeddings=True,
    ).float().cpu()
    rows = []
    for i, text in enumerate(candidates):
        f = extract_scalar_features(text)
        scalar_vec = torch.tensor([f[n] for n in FEATURE_NAMES], dtype=torch.float32)
        rows.append(torch.cat([embs[i], scalar_vec]))
    M = torch.stack(rows)
    if z_score_scalars and M.shape[0] > 1:
        cols = M[:, EMBED_DIM:]
        mu = cols.mean(dim=0, keepdim=True)
        sd = cols.std(dim=0, keepdim=True).clamp(min=1e-6)
        M[:, EMBED_DIM:] = (cols - mu) / sd
    return M
