"""v1.3: narrower over-defensive fix targeting question-interpretation errors.

v1.1 over-defensive case (recDDxpS9s8cwkqfq): orion correctly identified the
critique as making weak claims, but then incorrectly defended its WRONG draft.
The actual error was at the QUESTION-INTERPRETATION level: orion confused
absorption color with emission color, not at the critique-strength level.

v1.3 hypothesis: add a "Step 0: restate what the question is actually asking"
BEFORE VALID/INVALID rebuttal. Forces orion to re-anchor on the question's
intent. Catches misunderstanding-at-the-question-level errors that v1.1's
critique-rebuttal alone can't.

Tested on the same 8 v1.1-flipped cases (6 FIX + 2 BREAK) as v1.2.
"""
import json
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"
PROBLEMS_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "data" / "problems.jsonl"
AC_PATH = ROOT / "benchmarks" / "gpqa-diamond" / "results" / "agent-chat.jsonl"
V11_PATH = RESULTS_DIR / "v11_full.jsonl"

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


def build_v13_revise_prompt(problem: dict, draft: str, critique: str, peer: str) -> str:
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
        # ↓↓↓ THE v1.3 ADDITION ↓↓↓
        "**Before producing your final answer, do this in two steps:**",
        "",
        "**Step 0 (question-interpretation check).** Restate what the question is *literally asking for* in one sentence. Does your draft answer the question that's actually asked, or did you answer a slightly different (related) question? Common pitfall: confusing 'what is X' with 'what causes X', or 'what is absorbed' with 'what is emitted', etc. If your draft answered the wrong question, flip to the answer that addresses the actual question.",
        "",
        "**Step 1 (critique rebuttal).** List each substantive claim made in the critique and mark it VALID [reason] or INVALID [counter-argument]. Only flip your answer if at least one VALID claim directly demonstrates your draft is wrong.",
        "",
        "Now produce your final answer. On the LAST line of your response output exactly:",
        "Answer: X",
        "",
        "where X is one of A, B, C, or D.",
    ])


def claude_call(prompt: str, timeout_sec: int = 1200) -> tuple[str, int]:
    r = subprocess.run(
        ["claude", "-p", "--output-format", "text", prompt],
        capture_output=True, text=True, timeout=timeout_sec,
    )
    return (r.stdout or "").strip(), r.returncode


def main() -> None:
    problems = {json.loads(l)["id"]: json.loads(l) for l in open(PROBLEMS_PATH)}
    ac = {}
    for line in open(AC_PATH):
        if not line.strip(): continue
        r = json.loads(line)
        if (r.get("error") or "").startswith("claude draft cli exited 1: Configuration error"):
            continue
        ac[r["id"]] = r
    v11 = {json.loads(l)["id"]: json.loads(l) for l in V11_PATH.read_text().splitlines() if l.strip()}

    test_ids = [qid for qid, r in v11.items() if r["outcome"] in ("FIX", "BREAK")]
    print(f"# v1.3 test on {len(test_ids)} v1.1-flipped cases")

    rows = []
    for qid in test_ids:
        r_old = ac[qid]; r_v11 = v11[qid]; p = problems[qid]
        prompt = build_v13_revise_prompt(p, r_old["claude_draft_response"],
                                         r_old["codex_critique_response"], r_old.get("peer", "?"))
        t0 = time.time()
        try:
            stdout, status = claude_call(prompt)
        except subprocess.TimeoutExpired:
            stdout, status = "", -1
        elapsed_ms = int((time.time() - t0) * 1000)
        new_letter = extract_answer(stdout)
        v11_letter = r_v11["new_revised_letter"]
        v10_letter = r_v11["old_revised_letter"]
        expected = r_v11["expected"]
        v13_correct = new_letter == expected
        v11_correct = r_v11["new_correct"]
        v10_correct = r_v11["old_correct"]
        v11_outcome = r_v11["outcome"]

        if v13_correct and v11_correct:
            v13_vs_v11 = "BOTH-CORRECT"
        elif v13_correct and not v11_correct:
            v13_vs_v11 = "v13-FIXES-v11"
        elif not v13_correct and v11_correct:
            v13_vs_v11 = "v13-BREAKS-v11"
        else:
            v13_vs_v11 = "BOTH-WRONG"

        rows.append({
            "id": qid, "domain": p["domain"], "subdomain": p["subdomain"],
            "v11_outcome": v11_outcome,
            "draft_letter": r_old.get("claude_draft_letter"),
            "v10_letter": v10_letter, "v10_correct": v10_correct,
            "v11_letter": v11_letter, "v11_correct": v11_correct,
            "v13_letter": new_letter, "v13_correct": v13_correct,
            "expected": expected, "v13_vs_v11": v13_vs_v11,
            "elapsed_ms": elapsed_ms, "peer": r_old.get("peer", "?"),
            "v13_response": stdout,
        })
        m10 = "✓" if v10_correct else "✗"
        m11 = "✓" if v11_correct else "✗"
        m13 = "✓" if v13_correct else "✗"
        print(f"# [{qid}] v1.0={v10_letter}{m10} → v1.1={v11_letter}{m11} → v1.3={new_letter}{m13} expected={expected} (was {v11_outcome} → {v13_vs_v11})")

    out = RESULTS_DIR / "v13_revise.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"\n# wrote {out}")
    fix = sum(1 for r in rows if r["v13_vs_v11"] == "v13-FIXES-v11")
    brk = sum(1 for r in rows if r["v13_vs_v11"] == "v13-BREAKS-v11")
    br = sum(1 for r in rows if r["v13_vs_v11"] == "BOTH-CORRECT")
    bw = sum(1 for r in rows if r["v13_vs_v11"] == "BOTH-WRONG")
    print(f"\n# v1.3 vs v1.1 on the {len(rows)} flipped cases:")
    print(f"  v13-FIXES-v11:    {fix}")
    print(f"  v13-BREAKS-v11:   {brk}")
    print(f"  BOTH-CORRECT:     {br}")
    print(f"  BOTH-WRONG:       {bw}")
    print(f"  net delta v1.3 - v1.1:  {fix - brk:+d}")


if __name__ == "__main__":
    main()
