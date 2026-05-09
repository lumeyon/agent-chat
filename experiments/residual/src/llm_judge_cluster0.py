"""Validate the NL50 hypothesis: an LLM-judge CAN distinguish deferential
vs rebuttal-driven self-correction where the regex feature cannot.

For each of N exemplars in v1.0 cluster 0 and N in v1.1 cluster 0, ask
claude (the judge) to classify the agent_chat response as:
  - DEFERENTIAL (orion is folding to peer critique without verifying)
  - REBUTTAL (orion is examining critique claim-by-claim, defending or accepting)
  - AMBIGUOUS

Hypothesis: v1.0 cluster-0 exemplars skew DEFERENTIAL; v1.1 cluster-0
exemplars skew REBUTTAL. If confirmed, this is the richer feature for the
next Track A iteration.
"""
import json
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"

JUDGE_PROMPT_TEMPLATE = """You are evaluating a response that an AI agent (orion) wrote AFTER receiving a peer critique.

Classify orion's response into one of three categories:

- DEFERENTIAL: orion folded to the peer critique without verifying or rebutting specific claims. Phrases like "let me redo this with the peer's corrections", "the peer raises a valid point that I missed", "reconsidering with the peer's points in mind". The response accepts the critique's framing rather than examining it.

- REBUTTAL: orion examined the critique claim-by-claim, marking each one valid or invalid with reasoning. The response actively engages with critique claims and justifies whether to accept or reject each.

- AMBIGUOUS: doesn't clearly fit either pattern.

Here is orion's response (excerpt):
---
{response}
---

Reply with EXACTLY one word: DEFERENTIAL, REBUTTAL, or AMBIGUOUS. No explanation."""


def classify_response(response_text: str) -> tuple[str, str]:
    prompt = JUDGE_PROMPT_TEMPLATE.format(response=response_text[:2500])
    r = subprocess.run(
        ["claude", "-p", "--output-format", "text", prompt],
        capture_output=True, text=True, timeout=120,
    )
    out = (r.stdout or "").strip().upper()
    # Robust extraction
    for label in ("DEFERENTIAL", "REBUTTAL", "AMBIGUOUS"):
        if label in out:
            return label, r.stdout.strip()
    return "PARSE_FAIL", r.stdout.strip()


def main() -> None:
    v10 = json.loads((RESULTS_DIR / "clusters_agent_chat.json").read_text())
    v11 = json.loads((RESULTS_DIR / "clusters_agent_chat_v11.json").read_text())

    v10_c0 = v10["clusters"][0]
    v11_c0 = v11["clusters"][0]
    print(f"# v1.0 cluster 0: n={v10_c0['n_members']}, exemplars stored: {len(v10_c0['exemplars'])}")
    print(f"# v1.1 cluster 0: n={v11_c0['n_members']}, exemplars stored: {len(v11_c0['exemplars'])}")
    print()

    rows = []
    for label, exemplars, version in [
        ("v1.0_cluster0", v10_c0["exemplars"], "v1.0"),
        ("v1.1_cluster0", v11_c0["exemplars"], "v1.1"),
    ]:
        print(f"# === Classifying {label} exemplars (n={len(exemplars)}) ===")
        for i, e in enumerate(exemplars):
            t0 = time.time()
            cls, raw = classify_response(e["response_excerpt"])
            elapsed = int((time.time() - t0) * 1000)
            rows.append({
                "version": version,
                "cluster": label,
                "id": e["id"],
                "domain": e.get("domain", ""),
                "classification": cls,
                "raw": raw,
                "elapsed_ms": elapsed,
            })
            print(f"  [{i+1}/{len(exemplars)}] {e['id']} → {cls} ({elapsed}ms)")

    out = RESULTS_DIR / "llm_judge_cluster0.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"\n# wrote {out}")

    # Summary
    print()
    from collections import Counter
    for version in ("v1.0", "v1.1"):
        sub = [r for r in rows if r["version"] == version]
        c = Counter(r["classification"] for r in sub)
        print(f"# {version} cluster 0: {dict(c)}")

    v10_def = sum(1 for r in rows if r["version"] == "v1.0" and r["classification"] == "DEFERENTIAL")
    v11_reb = sum(1 for r in rows if r["version"] == "v1.1" and r["classification"] == "REBUTTAL")
    v10_total = sum(1 for r in rows if r["version"] == "v1.0")
    v11_total = sum(1 for r in rows if r["version"] == "v1.1")
    print()
    print(f"# Hypothesis check:")
    print(f"  v1.0 cluster-0 DEFERENTIAL: {v10_def}/{v10_total}")
    print(f"  v1.1 cluster-0 REBUTTAL:    {v11_reb}/{v11_total}")
    if v10_def >= 4 and v11_reb >= 4:
        print(f"  → HYPOTHESIS CONFIRMED: LLM-judge can distinguish where regex cannot")
    else:
        print(f"  → HYPOTHESIS NOT CLEANLY CONFIRMED")


if __name__ == "__main__":
    main()
