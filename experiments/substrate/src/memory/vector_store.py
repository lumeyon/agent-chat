"""Cross-session vector memory.

Embeds (query, response, score, meta) tuples via BGE-small-en-v1.5,
stores in a FAISS IndexFlatIP (inner product on unit-normalized
embeddings = cosine similarity), persists to disk on /data.

This is component 4 of the substrate. Two roles:
  1. Inference enrichment: at query time, retrieve top-K relevant past
     (query, response, outcome) tuples as in-context examples for the
     ensemble's generators.
  2. Training data accumulation: every (query, candidate, reward)
     triple the substrate emits gets persisted; future RL training
     runs can replay this corpus.
"""
import json
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch


@dataclass
class MemoryEntry:
    query: str
    response: str
    score: float
    meta: dict = field(default_factory=dict)


_embedder_cache: object | None = None


def _get_embedder(device: str = "cuda"):
    global _embedder_cache
    if _embedder_cache is None:
        os.environ.setdefault("HF_HOME", "/data/cache/huggingface")
        from sentence_transformers import SentenceTransformer
        dev = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
        _embedder_cache = SentenceTransformer("BAAI/bge-small-en-v1.5", device=dev)
    return _embedder_cache


class VectorStore:
    """FAISS-backed vector index. Embeds queries (not responses) for retrieval."""

    EMBED_DIM = 384

    def __init__(self, index_dir: Path | str, device: str = "cuda"):
        import faiss
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self.entries_path = self.index_dir / "entries.jsonl"
        self.index_path = self.index_dir / "faiss.idx"
        self._device = device
        self._faiss = faiss
        self._index: Optional[object] = None
        self._entries: list[MemoryEntry] = []
        self._load_or_init()

    def _load_or_init(self):
        if self.index_path.exists() and self.entries_path.exists():
            self._index = self._faiss.read_index(str(self.index_path))
            self._entries = []
            for line in self.entries_path.read_text().splitlines():
                if not line.strip():
                    continue
                d = json.loads(line)
                self._entries.append(MemoryEntry(**d))
        else:
            self._index = self._faiss.IndexFlatIP(self.EMBED_DIM)
            self._entries = []

    def __len__(self) -> int:
        return len(self._entries)

    def _embed(self, texts: list[str]) -> np.ndarray:
        emb = _get_embedder(self._device).encode(
            texts, convert_to_numpy=True, show_progress_bar=False,
            normalize_embeddings=True,
        ).astype("float32")
        return emb

    def add(self, entry: MemoryEntry) -> None:
        emb = self._embed([entry.query])
        self._index.add(emb)
        self._entries.append(entry)

    def retrieve(self, query: str, k: int = 5) -> list[MemoryEntry]:
        if len(self._entries) == 0:
            return []
        emb = self._embed([query])
        k_eff = min(k, len(self._entries))
        scores, indices = self._index.search(emb, k_eff)
        return [self._entries[int(i)] for i in indices[0] if i >= 0]

    def save(self) -> None:
        self._faiss.write_index(self._index, str(self.index_path))
        with open(self.entries_path, "w") as f:
            for e in self._entries:
                f.write(json.dumps(asdict(e)) + "\n")
