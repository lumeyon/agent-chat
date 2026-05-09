"""v1.1 full-scale: re-run the REVISE step on ALL 198 agent-chat questions
with the prescribed v1.1 prompt change. Reuses existing draft + critique
from agent-chat.jsonl so cost is 1 LLM call per question instead of 3.

Resumable: skips ids already in the output file. Adds a defensive
fast-fail circuit-breaker (bail on 3 consecutive sub-1-second exits, the
disk-fill failure mode pattern from NL40).

Usage:
  TMPDIR=/data/tmp python -m experiments.residual.src.run_v11_full \\
    [--out PATH] [--limit N] [--timeout-ms N]
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"
PROBLEMS_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "data" / "problems.jsonl"
AC_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "results" / "agent-chat.jsonl"

DISK_FILL_MARKER = "claude draft cli exited 1: Configuration error"
ANSWER_RE = re.compile(r"(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}(?![A-Za-z])", re.MULTILINE)


def extract_answer(text: str) -> str | None:
    if not text:
        return None
    matches = ANSWER_RE.findall(text)
    if matches:
        return matches[-1]
    for line in reversed(text.strip().splitlines()):
        s = line.strip().strip(".() ").rstrip("*")
        if len(s) == 1 and s in "ABCD":
            return s
    return None


def build_v11_revise_prompt(problem: dict, draft: str, critique: str, peer: str) -> str:
    return "\n".join([
        "You are an expert answering a multiple-choice question.",
        "",
        "Below is your earlier DRAFT answer and a CRITIQUE from a peer reviewer.",
        "Consider the critique carefully. If the critique is right, update your reasoning.",
        "If the critique is wrong, defend your original reasoning. Do not change your answer reflexively just because the peer disagreed — only change if their argument is actually correct.",
        "",
        f"Domain: {problem['domain']} / {problem['subdomain']}",
        "",
        f"Question: {problem['question']}",
        "",
        "Choices:",
        f"(A) {problem['choices']['A']}",
        f"(B) {problem['choices']['B']}",
        f"(C) {problem['choices']['C']}",
        f"(D) {problem['choices']['D']}",
        "",
        "Your DRAFT answer:",
        "---",
        draft,
        "---",
        "",
        f"CRITIQUE from peer ({peer}):",
        "---",
        critique,
        "---",
        "",
        "**Before producing your final answer, list each substantive claim made in the critique and mark it VALID [with one-sentence reason] or INVALID [with one-sentence counter-argument]. Only flip your answer if at least one VALID claim directly demonstrates your draft is wrong.**",
        "",
        "Now produce your final answer. Think step by step, then on the LAST line of your response output exactly:",
        "Answer: X",
        "",
        "where X is one of A, B, C, or D.",
    ])


def parse_args(argv: list[str]) -> dict:
    out = {"out": str(RESULTS_DIR / "v11_full.jsonl"), "limit": None, "timeout_ms": 1_200_000}
    for i, a in enumerate(argv):
        if a == "--out":
            out["out"] = argv[i + 1]
        elif a == "--limit":
            out["limit"] = int(argv[i + 1])
        elif a == "--timeout-ms":
            out["timeout_ms"] = int(argv[i + 1])
    return out


def load_completed_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {json.loads(l)["id"] for l in path.read_text().splitlines() if l.strip()}


def main() -> None:
    args = parse_args(sys.argv[1:])
    out_path = Path(args["out"])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    problems = {json.loads(l)["id"]: json.loads(l) for l in open(PROBLEMS_PATH)}
    ac = []
    for line in open(AC_PATH):
        if not line.strip():
            continue
        r = json.loads(line)
        if (r.get("error") or "").startswith(DISK_FILL_MARKER):
            continue
        # Need draft AND critique to re-run revise.
        if not (r.get("claude_draft_response") and r.get("codex_critique_response")):
            continue
        ac.append(r)

    completed = load_completed_ids(out_path)
    todo = [r for r in ac if r["id"] not in completed]
    if args["limit"] is not None:
        todo = todo[: args["limit"]]
    print(f"# v11-full: {len(todo)} pending ({len(completed)} done; {len(ac)} total with draft+critique)")
    print(f"# out={out_path}, timeout-ms={args['timeout_ms']}")

    consecutive_fast_fails = 0
    for i, r_old in enumerate(todo):
        qid = r_old["id"]
        p = problems.get(qid)
        if p is None:
            continue
        draft = r_old["claude_draft_response"]
        critique = r_old["codex_critique_response"]
        peer = r_old.get("peer", "?")
        prompt = build_v11_revise_prompt(p, draft, critique, peer)
        t0 = time.time()
        try:
            res = subprocess.run(
                ["claude", "-p", "--output-format", "text", prompt],
                capture_output=True, text=True, timeout=args["timeout_ms"] / 1000.0,
            )
            stdout = (res.stdout or "").strip()
            status = res.returncode
            stderr = (res.stderr or "")
        except subprocess.TimeoutExpired:
            stdout, status, stderr = "", -1, "(timeout)"
        elapsed_ms = int((time.time() - t0) * 1000)

        new_letter = extract_answer(stdout)
        old_letter = r_old.get("answer_extracted")
        expected = r_old.get("answer_expected")
        new_correct = new_letter == expected
        old_correct = bool(r_old.get("correct"))

        # Defensive fast-fail circuit-breaker.
        if status != 0 and not stdout and elapsed_ms < 1000:
            consecutive_fast_fails += 1
            if consecutive_fast_fails >= 3:
                print(f"# FATAL: 3 consecutive sub-1s claude exits — claude.json may be corrupt")
                print(f"# stderr from last: {stderr[:200]}")
                sys.exit(2)
        else:
            consecutive_fast_fails = 0

        outcome = (
            "FIX" if new_correct and not old_correct else
            "BREAK" if not new_correct and old_correct else
            "STAY-RIGHT" if new_correct and old_correct else
            "STAY-WRONG"
        )

        entry = {
            "id": qid,
            "domain": r_old.get("domain"),
            "subdomain": r_old.get("subdomain"),
            "peer": peer,
            "draft_letter": r_old.get("claude_draft_letter"),
            "old_revised_letter": old_letter,
            "new_revised_letter": new_letter,
            "expected": expected,
            "old_correct": old_correct,
            "new_correct": new_correct,
            "outcome": outcome,
            "elapsed_ms": elapsed_ms,
            "status": status,
            "new_response": stdout,
        }
        if status != 0 and not stdout:
            entry["error"] = f"claude exited {status}: {stderr[:300]}"
        with open(out_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

        old_mark = "✓" if old_correct else "✗"
        new_mark = "✓" if new_correct else "✗"
        print(f"# [{i+1}/{len(todo)}] {qid} {old_letter or '?'}{old_mark}→{new_letter or '?'}{new_mark} expected={expected} {outcome} ({elapsed_ms}ms)")

    print(f"# done; results in {out_path}")


if __name__ == "__main__":
    main()
