"""Load + JOIN GPQA Diamond results into router training triples."""
import json
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[3]
PROBLEMS = ROOT / "benchmarks" / "gpqa-diamond" / "data" / "problems.jsonl"
RESULTS = ROOT / "benchmarks" / "gpqa-diamond" / "results"

DISK_FILL_MARKER = "claude draft cli exited 1: Configuration error"


def _load(path: Path) -> dict:
    by_id = {}
    if not path.exists():
        return by_id
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        by_id[r["id"]] = r
    return by_id


def _build_query(problem: dict) -> str:
    return (
        f"Domain: {problem['domain']} / {problem['subdomain']}\n\n"
        f"Question: {problem['question']}\n\n"
        f"(A) {problem['choices']['A']}\n"
        f"(B) {problem['choices']['B']}\n"
        f"(C) {problem['choices']['C']}\n"
        f"(D) {problem['choices']['D']}"
    )


def load_triples() -> list[dict]:
    """Return one row per problem with codex/claude (and optional agent-chat) outcomes joined."""
    problems = _load(PROBLEMS)
    codex = _load(RESULTS / "codex.jsonl")
    claude = _load(RESULTS / "claude.jsonl")
    ac_raw = _load(RESULTS / "agent-chat.jsonl")
    ac = {
        i: r for i, r in ac_raw.items()
        if not (r.get("error") or "").startswith(DISK_FILL_MARKER)
    }

    out = []
    for pid, p in problems.items():
        if pid not in codex or pid not in claude:
            continue
        out.append({
            "id": pid,
            "domain": p["domain"],
            "subdomain": p["subdomain"],
            "query": _build_query(p),
            "answer_letter": p["answer"],
            "codex_correct": bool(codex[pid]["correct"]),
            "claude_correct": bool(claude[pid]["correct"]),
            "agent_chat_correct": bool(ac[pid]["correct"]) if pid in ac else None,
        })
    out.sort(key=lambda r: r["id"])
    return out


def count_correct(triples: list[dict], expert: Literal["codex", "claude", "agent_chat"]) -> int:
    key = f"{expert}_correct"
    return sum(1 for t in triples if t.get(key))
