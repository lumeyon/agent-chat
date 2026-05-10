"""v2.0: STRUCTURAL change to the agent_chat protocol.

Previous v1.x experiments only modified the REVISE prompt. v1.2 and v1.3
both refuted with identical -3 net deltas — there's no prompt change to
v1.1's revise step that fixes the over-defensive case without breaking
v1.1's gains.

v2.0 is a structural intervention: modify the CRITIQUE prompt instead.
Codex must FIRST restate the question in its own words BEFORE critiquing.
The hypothesis is that question-misinterpretation errors (like
recDDxpS9s8cwkqfq's absorption-vs-emission confusion) are best caught at
the critique-generator side (codex has fresh eyes, no anchoring on draft)
rather than the revise-generator side (orion is anchored on its own draft).

Tested on the same 8 v1.1-flipped cases. 16 LLM calls total (8 codex + 8
claude). The agent_chat draft is reused; both critique and revise are new.

Uses v1.1's revise prompt (the production winner).
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


def build_v20_critique_prompt(problem: dict, peer: str, draft: str, draft_letter: str) -> str:
    return "\n".join([
        f"You are {peer}, a peer reviewer with expertise in graduate-level science.",
        "",
        "Another agent (orion) has produced a draft answer to a multiple-choice question.",
        "Your job is to (a) restate the question in your own words to confirm understanding, and (b) critique the reasoning.",
        "You do NOT know the correct answer.",
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
        f"orion's draft answer (chose {draft_letter or '[unparseable]'}):",
        "---",
        draft,
        "---",
        "",
        "Your response, in two parts:",
        "",
        "**Part 1: Question restatement.** Restate in one sentence what the question is *literally* asking for. Identify common pitfalls (e.g., 'what is X' vs 'what causes X', 'absorption' vs 'emission'). If orion's draft answered a slightly different question than what's asked, flag it explicitly.",
        "",
        "**Part 2: Reasoning critique.** Be terse and rigorous. Name specific errors. If you disagree with the chosen answer, argue for a different one. If the reasoning is sound, endorse it.",
    ])


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


def claude_call(prompt: str, timeout_sec: int = 1200) -> tuple[str, int]:
    r = subprocess.run(
        ["claude", "-p", "--output-format", "text", prompt],
        capture_output=True, text=True, timeout=timeout_sec,
    )
    return (r.stdout or "").strip(), r.returncode


def codex_call(prompt: str, timeout_sec: int = 1200) -> tuple[str, int]:
    r = subprocess.run(
        ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
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
    print(f"# v2.0 test on {len(test_ids)} v1.1-flipped cases (16 LLM calls total)")

    rows = []
    for qid in test_ids:
        r_old = ac[qid]; r_v11 = v11[qid]; p = problems[qid]
        peer = r_old.get("peer", "?")
        draft = r_old["claude_draft_response"]
        draft_letter = r_old.get("claude_draft_letter")

        # New codex critique with question-restatement
        crit_prompt = build_v20_critique_prompt(p, peer, draft, draft_letter)
        t0 = time.time()
        try:
            critique, status_c = codex_call(crit_prompt)
        except subprocess.TimeoutExpired:
            critique, status_c = "", -1
        crit_ms = int((time.time() - t0) * 1000)

        # Revise with v1.1 prompt + new critique
        rev_prompt = build_v11_revise_prompt(p, draft, critique, peer)
        t1 = time.time()
        try:
            stdout, status_r = claude_call(rev_prompt)
        except subprocess.TimeoutExpired:
            stdout, status_r = "", -1
        rev_ms = int((time.time() - t1) * 1000)

        new_letter = extract_answer(stdout)
        v11_letter = r_v11["new_revised_letter"]
        v10_letter = r_v11["old_revised_letter"]
        expected = r_v11["expected"]
        v20_correct = new_letter == expected
        v11_correct = r_v11["new_correct"]
        v10_correct = r_v11["old_correct"]
        v11_outcome = r_v11["outcome"]

        if v20_correct and v11_correct: v20_vs_v11 = "BOTH-CORRECT"
        elif v20_correct: v20_vs_v11 = "v20-FIXES-v11"
        elif v11_correct: v20_vs_v11 = "v20-BREAKS-v11"
        else: v20_vs_v11 = "BOTH-WRONG"

        rows.append({
            "id": qid, "domain": p["domain"], "subdomain": p["subdomain"],
            "v11_outcome": v11_outcome,
            "draft_letter": draft_letter,
            "v10_letter": v10_letter, "v10_correct": v10_correct,
            "v11_letter": v11_letter, "v11_correct": v11_correct,
            "v20_letter": new_letter, "v20_correct": v20_correct,
            "expected": expected, "v20_vs_v11": v20_vs_v11,
            "crit_ms": crit_ms, "rev_ms": rev_ms,
            "peer": peer,
            "v20_critique": critique, "v20_revise_response": stdout,
        })
        m10 = "✓" if v10_correct else "✗"
        m11 = "✓" if v11_correct else "✗"
        m20 = "✓" if v20_correct else "✗"
        print(f"# [{qid}] v1.0={v10_letter}{m10} → v1.1={v11_letter}{m11} → v2.0={new_letter}{m20} expected={expected} (was {v11_outcome} → {v20_vs_v11}) crit={crit_ms}ms rev={rev_ms}ms")

    out = RESULTS_DIR / "v20_revise.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"\n# wrote {out}")
    fix = sum(1 for r in rows if r["v20_vs_v11"] == "v20-FIXES-v11")
    brk = sum(1 for r in rows if r["v20_vs_v11"] == "v20-BREAKS-v11")
    br = sum(1 for r in rows if r["v20_vs_v11"] == "BOTH-CORRECT")
    bw = sum(1 for r in rows if r["v20_vs_v11"] == "BOTH-WRONG")
    print(f"\n# v2.0 vs v1.1 on the {len(rows)} flipped cases:")
    print(f"  v20-FIXES-v11:    {fix}")
    print(f"  v20-BREAKS-v11:   {brk}")
    print(f"  BOTH-CORRECT:     {br}")
    print(f"  BOTH-WRONG:       {bw}")
    print(f"  net delta v2.0 - v1.1:  {fix - brk:+d}")


if __name__ == "__main__":
    main()
