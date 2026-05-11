"""Tests for memory.vector_store — cross-session persistent memory."""
import json
from pathlib import Path
import pytest
from experiments.substrate.src.memory.vector_store import (
    VectorStore, MemoryEntry,
)


def test_add_and_retrieve_returns_self(tmp_path: Path):
    store = VectorStore(index_dir=tmp_path / "idx", device="cpu")
    e = MemoryEntry(
        query="What is gravity?",
        response="Gravity is a force.",
        score=1.0,
        meta={"agent": "claude", "qid": "q1"},
    )
    store.add(e)
    results = store.retrieve("Tell me about gravity", k=1)
    assert len(results) == 1
    assert results[0].query == "What is gravity?"
    assert results[0].score == 1.0


def test_retrieves_more_relevant_first(tmp_path: Path):
    store = VectorStore(index_dir=tmp_path / "idx", device="cpu")
    store.add(MemoryEntry(query="Prime numbers theory", response="2,3,5,7", score=1.0, meta={}))
    store.add(MemoryEntry(query="Cooking pasta recipe", response="boil water", score=1.0, meta={}))
    store.add(MemoryEntry(query="Number theory basics", response="primes are", score=1.0, meta={}))
    results = store.retrieve("What is a prime number?", k=2)
    # Top-2 should be the two number-theory entries, not pasta
    queries = [r.query for r in results]
    assert "Cooking pasta recipe" not in queries


def test_persists_across_instances(tmp_path: Path):
    idx_dir = tmp_path / "idx"
    s1 = VectorStore(index_dir=idx_dir, device="cpu")
    s1.add(MemoryEntry(query="Alpha", response="A", score=0.5, meta={"k": "v"}))
    s1.save()

    s2 = VectorStore(index_dir=idx_dir, device="cpu")
    results = s2.retrieve("Alpha question", k=1)
    assert len(results) == 1
    assert results[0].response == "A"
    assert results[0].meta == {"k": "v"}


def test_returns_empty_when_index_empty(tmp_path: Path):
    store = VectorStore(index_dir=tmp_path / "idx", device="cpu")
    results = store.retrieve("anything", k=3)
    assert results == []


def test_size_tracking(tmp_path: Path):
    store = VectorStore(index_dir=tmp_path / "idx", device="cpu")
    assert len(store) == 0
    store.add(MemoryEntry(query="a", response="b", score=1.0, meta={}))
    store.add(MemoryEntry(query="c", response="d", score=0.0, meta={}))
    assert len(store) == 2
