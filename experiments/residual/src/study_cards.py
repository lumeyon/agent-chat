"""Apprenticeship Substrate bridge: format cluster data as study cards.

Each cluster from cluster.py becomes a structured markdown card with:
  - failure-mode name (auto-derived from top features)
  - signature (the residual feature signature with z-scores)
  - exemplar queries (top-5 most extreme cluster members)
  - lesson (what an apprentice should learn from these examples)

Plus a cross-agent overlap report: which queries appear as anomalies in
multiple agents' clusters → shared (substrate-independent) hard questions
vs single-agent anomalies."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = ROOT / "experiments" / "residual" / "results"
STUDY_DIR = RESULTS_DIR / "study_cards"


def name_failure_mode(signature: list[dict]) -> str:
    """Derive a human-readable label from the top-2 signature features.
    Heuristics map known feature combinations to recognized failure modes."""
    if not signature:
        return "unknown"
    features = {s["feature"]: s["mean_signed"] for s in signature[:3]}
    sc = features.get("n_self_correction", 0)
    cw = features.get("n_certainty_words", 0)
    hw = features.get("n_hedge_words", 0)
    cb = features.get("n_codeblocks", 0)
    lt = features.get("n_latex", 0)
    qm = features.get("n_questions", 0)
    rl = features.get("response_len", 0)
    lu = features.get("letter_unknown", 0)
    # Specific known patterns (ordered by specificity).
    if sc > 0.3 and cw < -0.3:
        return "soft-pushback / deferral"
    if cw > 1.5 and lu > 0.5:
        return "confidently asserts no answer (refusal-adjacent)"
    if cb > 1.0:
        return "code-block-heavy reasoning"
    if lt > 1.5 and rl <= 0:
        return "math-notation-heavy (latex)"
    if hw > 1.5:
        return "hedge-heavy uncertain"
    if qm > 2.0:
        return "asks-back questioning"
    if rl > 0.5 and cb >= 0:
        return "verbose technical reasoning"
    # Fallback: top-feature description.
    top_feat = signature[0]
    direction = "+" if top_feat["mean_signed"] >= 0 else "-"
    return f"{top_feat['feature']} dominant ({direction}{abs(top_feat['mean_signed']):.1f}σ)"


def build_study_card_markdown(cluster_data: dict, cluster_idx: int) -> str:
    agent = cluster_data["agent"]
    clusters = cluster_data["clusters"]
    if cluster_idx >= len(clusters):
        raise ValueError(f"cluster {cluster_idx} not in {len(clusters)} available")
    c = clusters[cluster_idx]
    name = name_failure_mode(c["signature"])
    n_high = cluster_data["n_high_residual"]

    lines = [
        f"# Study Card — {agent} cluster {c['cluster_id']}",
        "",
        f"## Failure Mode",
        f"**{name}** (n={c['n_members']} / {n_high} high-residual rows = {100 * c['n_members'] / n_high:.0f}%)",
        "",
        f"## Residual Signature",
        f"Driving features (mean signed residual, in z-score units across high-residual rows):",
        "",
    ]
    for feat in c["signature"]:
        sign = "+" if feat["mean_signed"] >= 0 else ""
        lines.append(f"- `{feat['feature']}`: {sign}{feat['mean_signed']:.2f}σ (mean abs {feat['mean_abs']:.2f})")
    lines.append("")
    lines.append(f"## Exemplars (top {len(c['exemplars'])} most-extreme cluster members)")
    lines.append("")
    for i, e in enumerate(c["exemplars"]):
        lines.append(f"### {i+1}. `{e['id']}` [{e['domain']}/{e['subdomain']}] (residual ‖² = {e['residual_norm_sq']:.2f})")
        lines.append("")
        lines.append(f"> {e['response_excerpt'][:250].strip()}")
        lines.append("")
    lines.append(f"## What to learn")
    lines.append("")
    lines.append(_lesson_text(name, agent))
    return "\n".join(lines)


def _lesson_text(failure_name: str, agent: str) -> str:
    """Mini-domain-knowledge lookup for what to learn from this failure mode."""
    lessons = {
        "soft-pushback / deferral": (
            "When `draft → revise` flips, require the agent to mark each substantive critique "
            "claim VALID or INVALID with one sentence of reasoning before accepting. The current "
            "revise prompt says 'don't change reflexively' but doesn't enforce the rebuttal "
            "discipline. **Fix:** append `For each substantive claim in the critique, state: "
            "VALID [why] or INVALID [counter-argument]. Then produce your final answer.` to the "
            "revise template."
        ),
        "confidently asserts no answer (refusal-adjacent)": (
            "The agent is hedging into ambiguity rather than committing. Watch for high "
            "`n_certainty_words` paired with `letter_unknown` — confident-sounding non-answers. "
            "**Fix:** require an explicit final letter even when uncertain; refusal-adjacent "
            "responses should be detected and re-prompted."
        ),
        "code-block-heavy reasoning": (
            "Agent uses code blocks where prose would suffice. Often correlates with "
            "over-formalization on questions that don't require code. **Fix:** for non-code "
            "domains (Chemistry, Physics, Biology), require justification-in-prose with code "
            "blocks reserved for actual computation."
        ),
        "math-notation-heavy (latex)": (
            "Agent uses unusually heavy LaTeX. Often a signal of a hard quantitative question "
            "where typical reasoning isn't sufficient. **Fix:** these are good candidates for "
            "the residual-explore boundary scout to flag for human review."
        ),
        "hedge-heavy uncertain": (
            "Agent is hedging excessively. Indicates genuine uncertainty (good signal!) but the "
            "final answer may still be wrong. **Fix:** for hedge-heavy responses, automatically "
            "trigger a peer-review pass (Track C boundary scout)."
        ),
        "asks-back questioning": (
            "Agent is asking sub-questions instead of answering. The question may be "
            "ill-specified, OR the agent is dodging. **Fix:** detect via `n_questions > 2σ` and "
            "either re-prompt with clarification or escalate to a stronger model."
        ),
        "verbose technical reasoning": (
            "Long, technical responses. May indicate the question is genuinely hard (good) OR "
            "the agent is rambling (bad). **Fix:** distinguish by checking `correct` flag; if "
            "high-verbose-but-wrong, the agent's reasoning is broken, not just thorough."
        ),
    }
    return lessons.get(failure_name, (
        f"Cluster pattern: {failure_name}. No predefined lesson — examine the exemplar "
        f"responses above and characterize manually."
    ))


def cross_agent_query_overlap(by_agent: dict[str, dict]) -> list[dict]:
    """Find queries that appear as exemplars in multiple agents' clusters.
    Returns list of {query_id, found_in: [{agent, cluster_id}, ...]}."""
    by_qid: dict[str, list[dict]] = {}
    for agent_name, data in by_agent.items():
        for c in data.get("clusters", []):
            for e in c.get("exemplars", []):
                qid = e["id"]
                by_qid.setdefault(qid, []).append({"agent": agent_name, "cluster_id": c["cluster_id"]})
    overlaps = []
    for qid, found in by_qid.items():
        if len({f["agent"] for f in found}) >= 2:
            overlaps.append({"query_id": qid, "found_in": found})
    overlaps.sort(key=lambda o: -len(o["found_in"]))
    return overlaps


def main() -> None:
    STUDY_DIR.mkdir(parents=True, exist_ok=True)
    by_agent: dict[str, dict] = {}
    cards_written = 0
    for agent in ("codex", "claude", "agent_chat"):
        path = RESULTS_DIR / f"clusters_{agent}.json"
        if not path.exists():
            print(f"# missing {path}")
            continue
        data = json.loads(path.read_text())
        by_agent[agent] = data
        for i in range(len(data["clusters"])):
            md = build_study_card_markdown(data, cluster_idx=i)
            out = STUDY_DIR / f"{agent}_cluster_{data['clusters'][i]['cluster_id']}.md"
            out.write_text(md)
            cards_written += 1
    print(f"# wrote {cards_written} study cards to {STUDY_DIR}")

    # Cross-agent overlap.
    overlaps = cross_agent_query_overlap(by_agent)
    out_path = RESULTS_DIR / "cross_agent_overlap.json"
    out_path.write_text(json.dumps(overlaps, indent=2))
    print(f"# wrote {out_path}: {len(overlaps)} queries appear in ≥2 agents' clusters")
    if overlaps[:5]:
        print(f"# top overlaps:")
        for o in overlaps[:5]:
            tag = " | ".join(f"{f['agent']}#{f['cluster_id']}" for f in o["found_in"])
            print(f"#   {o['query_id']}: {tag}")


if __name__ == "__main__":
    main()
