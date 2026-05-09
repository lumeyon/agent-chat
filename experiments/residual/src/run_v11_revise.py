"""v1.1 prompt-fix experiment: re-run the REVISE step on a hand-picked set of
soft-pushback failures with the prescribed v1.1 prompt change appended.

Hypothesis: forcing orion to mark each critique claim VALID/INVALID with
one sentence of reasoning before producing the final answer will:
  (a) prevent BREAK cases (draft correct → wrong-revise) by exposing
      unfounded critique claims, and
  (b) help WRONG-stayed-WRONG cases by surfacing where the critique
      actually has a point that orion was missing.

Reuses the existing draft + critique from agent-chat.jsonl — only re-runs
the third (revise) call. Saves new responses to v11_revise.json for paired
comparison. Each test case: 1 LLM call (claude). Total: 6 calls."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"
PROBLEMS_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "data" / "problems.jsonl"
AC_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "results" / "agent-chat.jsonl"

# 3 cluster-0 wrong-and-didn't-flip cases + 3 NL40 break cases.
TEST_CASE_IDS = [
    # Cluster-0 wrong-stayed-wrong:
    "recWxGU8Q4YReJ1tb",
    "recUOePh79cp4T2Bg",
    "recUBgVlkKzcRPDdK",
    # NL40 break cases:
    "recEmTBhx2hgw6tPQ",
    "recZWeueB7lSPR6wN",
    "recZbxrocrxh9YENH",
]


ANSWER_RE = re.compile(r"(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}(?![A-Za-z])", re.MULTILINE)


def extract_answer(text: str) -> str | None:
    if not text:
        return None
    matches = ANSWER_RE.findall(text)
    if matches:
        return matches[-1]
    # fallback: bare letter on last non-empty line
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
        # ↓↓↓ THE v1.1 ADDITION ↓↓↓
        "**Before producing your final answer, list each substantive claim made in the critique and mark it VALID [with one-sentence reason] or INVALID [with one-sentence counter-argument]. Only flip your answer if at least one VALID claim directly demonstrates your draft is wrong.**",
        "",
        "Now produce your final answer. Think step by step, then on the LAST line of your response output exactly:",
        "Answer: X",
        "",
        "where X is one of A, B, C, or D.",
    ])


def claude_call(prompt: str, timeout_sec: int = 1200) -> tuple[str, int | None]:
    """Returns (stdout, status). Empty stdout + non-zero status means failure."""
    r = subprocess.run(
        ["claude", "-p", "--output-format", "text", prompt],
        capture_output=True, text=True, timeout=timeout_sec,
    )
    return r.stdout.strip(), r.returncode


def main() -> None:
    problems = {json.loads(l)["id"]: json.loads(l) for l in open(PROBLEMS_PATH)}
    ac = {}
    for line in open(AC_PATH):
        if not line.strip():
            continue
        r = json.loads(line)
        if (r.get("error") or "").startswith("claude draft cli exited 1: Configuration error"):
            continue
        ac[r["id"]] = r

    rows = []
    for qid in TEST_CASE_IDS:
        if qid not in ac:
            print(f"# missing in agent-chat.jsonl: {qid}; skipping")
            continue
        if qid not in problems:
            print(f"# missing problem definition: {qid}; skipping")
            continue
        r_old = ac[qid]
        p = problems[qid]
        draft = r_old.get("claude_draft_response", "") or ""
        critique = r_old.get("codex_critique_response", "") or ""
        peer = r_old.get("peer", "?")
        if not draft or not critique:
            print(f"# {qid}: missing draft or critique; skipping")
            continue
        prompt = build_v11_revise_prompt(p, draft, critique, peer)
        print(f"# [{qid}] running v1.1 revise (peer={peer}, draft_len={len(draft)}, crit_len={len(critique)})")
        try:
            stdout, status = claude_call(prompt)
        except subprocess.TimeoutExpired:
            stdout, status = "", -1
        new_letter = extract_answer(stdout)
        old_letter = r_old.get("answer_extracted")
        expected = r_old.get("answer_expected")
        new_correct = new_letter == expected
        old_correct = bool(r_old.get("correct"))
        outcome = (
            "FIX" if new_correct and not old_correct else
            "BREAK" if not new_correct and old_correct else
            "STAY-RIGHT" if new_correct and old_correct else
            "STAY-WRONG"
        )
        rows.append({
            "id": qid,
            "domain": p["domain"],
            "subdomain": p["subdomain"],
            "draft_letter": r_old.get("claude_draft_letter"),
            "old_revised_letter": old_letter,
            "new_revised_letter": new_letter,
            "expected": expected,
            "old_correct": old_correct,
            "new_correct": new_correct,
            "outcome": outcome,
            "peer": peer,
            "status": status,
            "new_response_excerpt": stdout[:600] if stdout else "",
        })
        print(f"# [{qid}] old={old_letter}{'✓' if old_correct else '✗'} → new={new_letter}{'✓' if new_correct else '✗'} expected={expected} → {outcome}")

    out_path = RESULTS_DIR / "v11_revise.json"
    out_path.write_text(json.dumps(rows, indent=2))
    print(f"\n# wrote {out_path}")
    print(f"# summary: {sum(r['outcome']=='FIX' for r in rows)} fix, "
          f"{sum(r['outcome']=='BREAK' for r in rows)} break, "
          f"{sum(r['outcome']=='STAY-RIGHT' for r in rows)} stay-right, "
          f"{sum(r['outcome']=='STAY-WRONG' for r in rows)} stay-wrong, "
          f"out of {len(rows)} total")


if __name__ == "__main__":
    main()
