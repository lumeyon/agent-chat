"""v1.2 prompt-fix experiment: extends v1.1 with a "strongest-draft-argument"
step to address v1.1's two failure modes (over-defensive AND over-eager).

v1.1 forced rebuttal of each critique claim (VALID/INVALID). It worked on net
(+4 vs v1.0) but had two new failure modes:
  - over-defensive: orion marked all valid claims INVALID and kept wrong draft
  - over-eager: orion misjudged a claim VALID and flipped a correct draft

v1.2 hypothesis: force orion to also articulate the STRONGEST specific argument
FOR its draft, then compare strength head-to-head with the strongest VALID
critique claim. Tie goes to the critique (asymmetric prior — the critic has
fresh perspective).

Tested on the 8 cases that flipped under v1.1 (6 FIX + 2 BREAK). If v1.2
preserves the 6 FIX and repairs the 2 BREAK, agent-chat hits 181/198 = 91.4%."""
import json
import re
import subprocess
import time
import sys
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


def build_v12_revise_prompt(problem: dict, draft: str, critique: str, peer: str) -> str:
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
        # ↓↓↓ THE v1.2 ADDITION ↓↓↓
        "**Before producing your final answer, do this in three steps:**",
        "",
        "**Step 1.** List each substantive claim made in the critique. Mark each VALID [with one-sentence reason] or INVALID [with one-sentence counter-argument].",
        "",
        "**Step 2.** State the SINGLE strongest specific argument FOR your draft answer — the one most directly supported by the question's evidence (not a general principle).",
        "",
        "**Step 3.** Compare. If at least one VALID critique claim directly attacks your strongest draft argument and is approximately as strong or stronger, flip your answer. If all critique claims are INVALID and your strongest draft argument stands, defend the draft. **In a tie, flip — the critic has fresh perspective and is harder to fool than you yourself.**",
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

    # Test cases: all v1.1 FIX + BREAK (the cases where v1.1 changed something).
    test_ids = [qid for qid, r in v11.items() if r["outcome"] in ("FIX", "BREAK")]
    print(f"# v1.2 test on {len(test_ids)} v1.1-flipped cases")

    rows = []
    for qid in test_ids:
        r_old = ac[qid]
        r_v11 = v11[qid]
        p = problems[qid]
        prompt = build_v12_revise_prompt(p, r_old["claude_draft_response"], r_old["codex_critique_response"], r_old.get("peer", "?"))
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
        v12_correct = new_letter == expected
        v11_correct = r_v11["new_correct"]
        v10_correct = r_v11["old_correct"]
        v11_outcome = r_v11["outcome"]
        # v1.2 outcome relative to v1.1: did we keep, fix, break, or stay-wrong?
        if v12_correct and v11_correct:
            v12_vs_v11 = "BOTH-CORRECT"
        elif v12_correct and not v11_correct:
            v12_vs_v11 = "v12-FIXES-v11"  # v1.2 repaired a v1.1 mistake
        elif not v12_correct and v11_correct:
            v12_vs_v11 = "v12-BREAKS-v11"  # v1.2 lost a v1.1 win
        else:
            v12_vs_v11 = "BOTH-WRONG"
        rows.append({
            "id": qid,
            "domain": p["domain"], "subdomain": p["subdomain"],
            "v11_outcome": v11_outcome,
            "draft_letter": r_old.get("claude_draft_letter"),
            "v10_letter": v10_letter, "v10_correct": v10_correct,
            "v11_letter": v11_letter, "v11_correct": v11_correct,
            "v12_letter": new_letter, "v12_correct": v12_correct,
            "expected": expected,
            "v12_vs_v11": v12_vs_v11,
            "elapsed_ms": elapsed_ms,
            "peer": r_old.get("peer", "?"),
            "v12_response": stdout,
        })
        v10m = "✓" if v10_correct else "✗"
        v11m = "✓" if v11_correct else "✗"
        v12m = "✓" if v12_correct else "✗"
        print(f"# [{qid}] v1.0={v10_letter}{v10m} → v1.1={v11_letter}{v11m} → v1.2={new_letter}{v12m} expected={expected} (was {v11_outcome} → {v12_vs_v11})")

    out = RESULTS_DIR / "v12_revise.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"\n# wrote {out}")
    fix_count = sum(1 for r in rows if r["v12_vs_v11"] == "v12-FIXES-v11")
    break_count = sum(1 for r in rows if r["v12_vs_v11"] == "v12-BREAKS-v11")
    both_right = sum(1 for r in rows if r["v12_vs_v11"] == "BOTH-CORRECT")
    both_wrong = sum(1 for r in rows if r["v12_vs_v11"] == "BOTH-WRONG")
    print(f"\n# v1.2 vs v1.1 on the {len(rows)} v1.1-flipped cases:")
    print(f"  v12-FIXES-v11 (v1.2 right where v1.1 wrong):   {fix_count}")
    print(f"  v12-BREAKS-v11 (v1.2 wrong where v1.1 right):  {break_count}")
    print(f"  BOTH-CORRECT:                                  {both_right}")
    print(f"  BOTH-WRONG:                                    {both_wrong}")
    print(f"  net delta v1.2 - v1.1:                         {fix_count - break_count:+d}")


if __name__ == "__main__":
    main()
