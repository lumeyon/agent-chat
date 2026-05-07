#!/bin/bash
# Self-contained board-review pipeline. Runs end-to-end without needing
# a Claude tick to glue stages together.
#
# Usage: board-review.sh <PR-number> <skill-slug> <fork-branch> [<head-repo>]
#
# Example: board-review.sh 52 cloud-metadata-ssrf skill/cloud-metadata-ssrf lumeyonagent1
#
# Pipeline:
#   1. Pull PR diff + skill content
#   2. Spawn 9 ephemeral codex reviewers in parallel
#   3. Wait for all to complete
#   4. Aggregate decision via veto rules
#   5. Post PR comment with consensus
#   6. Crystallize the consensus's strongest lessons into orion's lessons
#   7. Log result to a backlog-drain ledger for later review
#
# Exits 0 on success (decision posted), nonzero on dispatcher/aggregator
# failure. The exit code does NOT reflect the consensus decision — a
# successful BLOCKED-BY-VETO post is exit 0; only infrastructure failure
# is nonzero.

set +e  # bash gotcha with (( var++ )) when var was 0

PR=$1
SLUG=$2
BRANCH=$3
HEAD_REPO=${4:-lumeyonagent1}

if [ -z "$PR" ] || [ -z "$SLUG" ] || [ -z "$BRANCH" ]; then
  echo "usage: board-review.sh <PR-number> <skill-slug> <fork-branch> [<head-repo>]" >&2
  exit 2
fi

UPSTREAM_REPO=lumeyon/lumeyon-security-skills
WORKTREE=/data/eyon/git/lumeyonagent1-skills
OUT_BASE=/data/lumeyon/agent-chat/conversations/board-reviews
OUT="$OUT_BASE/PR-$PR-$SLUG"
LEDGER="$OUT_BASE/backlog-drain.jsonl"
mkdir -p "$OUT"

echo "[board-review] PR #$PR ($SLUG) branch=$BRANCH"
echo "[board-review] starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# === STAGE 1: gather PR content ==============================================

(
  cd "$WORKTREE"
  git fetch origin "$BRANCH" 2>/dev/null || true
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q "origin/$BRANCH"
)

SKILL_DIR=$(find "$WORKTREE/skills" -maxdepth 1 -type d -name "*$SLUG*" 2>/dev/null | head -1)
if [ -z "$SKILL_DIR" ]; then
  # Fallback: derive from branch name
  SKILL_DIR="$WORKTREE/skills/$SLUG"
fi

cp "$SKILL_DIR/SKILL.md" "$OUT/_skill.md" 2>/dev/null || echo "(missing SKILL.md)" > "$OUT/_skill.md"
cp "$SKILL_DIR/scan.yaml" "$OUT/_scan.yaml" 2>/dev/null || echo "(missing scan.yaml)" > "$OUT/_scan.yaml"
cp "$SKILL_DIR/README.md" "$OUT/_readme.md" 2>/dev/null || echo "(missing README.md)" > "$OUT/_readme.md"

# Diff scoped to the skill + tests, excluding state/ heartbeat noise
git -C "$WORKTREE" diff "main..$BRANCH" -- skills/ tests/ > "$OUT/_diff.txt" 2>/dev/null || true

# === STAGE 2: spawn 9 reviewers in parallel ==================================

NORTH_STAR=$(cat /data/lumeyon/agent-chat/conversations/north-star.md)
SKILL_MD=$(cat "$OUT/_skill.md")
SCAN_YAML=$(cat "$OUT/_scan.yaml")
README=$(cat "$OUT/_readme.md")
DIFF=$(cat "$OUT/_diff.txt")

PREAMBLE="You are reviewing PR #$PR of $UPSTREAM_REPO:
**skill: $SLUG**

PR URL: https://github.com/$UPSTREAM_REPO/pull/$PR
Driven through agent-chat board pipeline (Round-15p+).

═══ NORTH-STAR (read first) ═══
$NORTH_STAR

═══ SKILL.md ═══
$SKILL_MD

═══ scan.yaml ═══
$SCAN_YAML

═══ README.md ═══
$README

═══ Diff (skills/ + tests/ only, state/ excluded) ═══
$DIFF

═══ STRUCTURED OUTPUT REQUIRED ═══

Output EXACTLY this format, no preamble:

DECISION: <APPROVE | CHANGES_REQUESTED | REJECT>
AXES: clarity=<1-10> depth=<1-10> reliability=<1-10> speed=<1-10>
RED_FLAGS: <comma-separated short slugs, or NONE>
LESSONS: <short kebab-case-slug | NONE>
REASONING:
<2-5 paragraphs of role-specific analysis>
"

declare -A ROLES
ROLES[lumeyon]="Your role: ARCHITECTURE & SYSTEMS ANALYST. Review for structural soundness, load-bearing primitives vs marketing surfaces, hidden coupling, deep code reading. Question: does this skill's mechanism actually do what its claim says? Where could the harness/skill abstraction break under stress?"
ROLES[keystone]="Your role: DOCS, COMMUNITY, MANIFEST COMPARISON SPECIALIST. Review README clarity, scan.yaml field completeness, payout fairness, contributor-template fitness. User-visible surface review."
ROLES[sentinel]="Your role: SAFETY & PROTOCOL-VIOLATION SPECIALIST. **YOUR VOTE HAS VETO POWER.** Review for prompt injection vectors, allocation sanity bounds, silence-≠-success gaps, regulatory red flags, unsafe shell calls. If you find a load-bearing safety gap, REJECT with the invariant cited."
ROLES[vanguard]="Your role: BEAR-CASE ADVOCATE & VERDICT-RIGOR ENFORCER. Argue the STRONGEST case AGAINST merging. Apply verdict-rigor frame: every ADOPT requires Downgrade trigger; every REJECT requires Invariant cited."
ROLES[cadence]="Your role: DEVIL'S ADVOCATE & FINAL-PASS QUALITY GATE. **YOUR VOTE HAS VETO POWER.** What edge case did everyone miss? What's the failure mode that wouldn't surface in test harness validation but would bite in production?"
ROLES[carina]="Your role: DEV PROCESS & DISTRIBUTION MECHANICS SPECIALIST. Does this skill follow the plugin manifest format correctly? Does the harness actually run on a clean clone? Are test fixtures well-formed? Is the directory structure consistent with peer skills?"
ROLES[rhino]="Your role: BULL-CASE ADVOCATE & PATTERN-CATALOG SPECIALIST. Argue the STRONGEST case FOR merging. What does this skill add that's currently missing? Why is the world materially safer with this skill in the wild?"
ROLES[lyra]="Your role: HISTORICAL PATTERN MATCHER. Find similar past PR shapes, prior board decisions on similar CWE-class skills. Has this CWE family been reviewed before? Were there prior reject reasons this PR addresses (or doesn't)?"
ROLES[pulsar]="Your role: QUANTITATIVE ANALYST & RISK SPECIALIST. Compute meaningful numbers about this PR. Confidence interval on the harness PASS results. False-positive/false-negative risk profile. If this skill runs on 1000 customer targets, what's the expected variance?"

REVIEWERS=(lumeyon keystone sentinel vanguard cadence carina rhino lyra pulsar)

for reviewer in "${REVIEWERS[@]}"; do
  PROMPT="${PREAMBLE}\n\n═══ ROLE-SPECIFIC FRAMING ═══\n${ROLES[$reviewer]}"
  OUTFILE="$OUT/${reviewer}-review.md"
  ERRFILE="$OUT/${reviewer}-stderr.log"
  echo "[board-review] spawning $reviewer"
  (
    echo "# Review by $reviewer (codex ephemeral)"
    echo
    echo "Spawned: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "PR: #$PR ($SLUG)"
    echo
    echo "---"
    echo
    codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" 2>"$ERRFILE" || echo "DISPATCH_FAILED status=$?"
  ) > "$OUTFILE" &
done

echo "[board-review] all 9 spawned, waiting for completion..."
wait
echo "[board-review] all 9 completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# === STAGE 3: aggregate consensus ============================================

DECISION_FILE="$OUT/CONSENSUS.md"
VETO_REVIEWERS=(sentinel cadence)
declare -A DECISIONS AXES_RAW RED_FLAGS LESSONS_RAW
approve=0; changes=0; reject=0; missing=0
declare -a veto_rejects=() all_red_flags=() all_lessons=()

for reviewer in "${REVIEWERS[@]}"; do
  f="$OUT/${reviewer}-review.md"
  if [ ! -s "$f" ] || ! grep -q "^DECISION:" "$f"; then
    DECISIONS[$reviewer]="MISSING"
    ((missing++))
    continue
  fi
  decision=$(grep -m1 "^DECISION:" "$f" | sed 's/^DECISION:[[:space:]]*//' | awk '{print $1}')
  axes=$(grep -m1 "^AXES:" "$f" | sed 's/^AXES:[[:space:]]*//')
  flags=$(grep -m1 "^RED_FLAGS:" "$f" | sed 's/^RED_FLAGS:[[:space:]]*//')
  lesson=$(grep -m1 "^LESSONS:" "$f" | sed 's/^LESSONS:[[:space:]]*//')
  case "$decision" in
    APPROVE) ((approve++)) ;;
    CHANGES_REQUESTED) ((changes++)) ;;
    REJECT) ((reject++)) ;;
    *) decision="MISSING"; ((missing++)) ;;
  esac
  DECISIONS[$reviewer]="$decision"; AXES_RAW[$reviewer]="$axes"
  RED_FLAGS[$reviewer]="$flags"; LESSONS_RAW[$reviewer]="$lesson"
  for v in "${VETO_REVIEWERS[@]}"; do
    [ "$reviewer" = "$v" ] && [ "$decision" = "REJECT" ] && veto_rejects+=("$v")
  done
  [ "$flags" != "NONE" ] && [ -n "$flags" ] && all_red_flags+=("$reviewer: $flags")
  [ "$lesson" != "NONE" ] && [ -n "$lesson" ] && all_lessons+=("$reviewer: $lesson")
done

final="UNCLEAR"
if [ ${#veto_rejects[@]} -gt 0 ]; then
  final="BLOCKED-BY-VETO (${veto_rejects[*]})"
elif [ "$reject" -ge 4 ]; then
  final="REJECT"
elif [ "$approve" -ge 4 ] && [ "$reject" -le 1 ]; then
  final="MERGE-READY"
else
  final="CHANGES_REQUESTED"
fi

# Per-axis means
clarity_sum=0; clarity_n=0; depth_sum=0; depth_n=0
reliability_sum=0; reliability_n=0; speed_sum=0; speed_n=0
for reviewer in "${REVIEWERS[@]}"; do
  for kv in ${AXES_RAW[$reviewer]}; do
    case "$kv" in
      clarity=*) v="${kv#clarity=}"; clarity_sum=$((clarity_sum + v)); ((clarity_n++)) ;;
      depth=*) v="${kv#depth=}"; depth_sum=$((depth_sum + v)); ((depth_n++)) ;;
      reliability=*) v="${kv#reliability=}"; reliability_sum=$((reliability_sum + v)); ((reliability_n++)) ;;
      speed=*) v="${kv#speed=}"; speed_sum=$((speed_sum + v)); ((speed_n++)) ;;
    esac
  done
done
mean() { local s=$1 n=$2; [ "$n" -gt 0 ] && echo "scale=2; $s / $n" | bc || echo "—"; }

# Write CONSENSUS.md
{
  echo "# PR #$PR — Board Review Consensus"; echo
  echo "**PR**: https://github.com/$UPSTREAM_REPO/pull/$PR"
  echo "**Skill**: $SLUG"
  echo "**Reviewers**: ${REVIEWERS[*]} (9 ephemeral codex spawns + orion driver)"
  echo "**Aggregated**: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo
  echo "## Decision: **$final**"; echo
  echo "## Vote breakdown"; echo
  echo "- APPROVE: $approve / 9"
  echo "- CHANGES_REQUESTED: $changes / 9"
  echo "- REJECT: $reject / 9"
  echo "- MISSING: $missing / 9"; echo
  echo "## Per-reviewer"; echo
  echo "| Reviewer | Decision | Red flags |"
  echo "|---|---|---|"
  for r in "${REVIEWERS[@]}"; do
    echo "| $r | ${DECISIONS[$r]} | ${RED_FLAGS[$r]:-NONE} |"
  done
  echo
  echo "## Per-axis aggregate (means across $((approve+changes+reject)) responding reviewers)"; echo
  echo "- clarity: $(mean $clarity_sum $clarity_n) / 10 (n=$clarity_n)"
  echo "- depth: $(mean $depth_sum $depth_n) / 10 (n=$depth_n)"
  echo "- reliability: $(mean $reliability_sum $reliability_n) / 10 (n=$reliability_n)"
  echo "- speed: $(mean $speed_sum $speed_n) / 10 (n=$speed_n)"
  echo
  echo "## Veto status"; echo
  if [ ${#veto_rejects[@]} -gt 0 ]; then
    echo "**BLOCKED by**: ${veto_rejects[*]}"
  else
    echo "No vetos triggered."
  fi
  echo
  echo "## Aggregated red flags"; echo
  if [ ${#all_red_flags[@]} -gt 0 ]; then
    for f in "${all_red_flags[@]}"; do echo "- $f"; done
  else
    echo "None reported."
  fi
  echo
  echo "## Per-reviewer reasoning"; echo
  for r in "${REVIEWERS[@]}"; do
    echo "### $r: ${DECISIONS[$r]}"; echo
    awk '/^REASONING:/,0' "$OUT/${r}-review.md" | tail -n +2
    echo
  done
} > "$DECISION_FILE"

echo "[board-review] consensus written: $DECISION_FILE"
echo "[board-review] decision: $final ($approve/$changes/$reject/$missing approve/changes/reject/missing)"

# === STAGE 4: post PR comment ================================================

COMMENT="$OUT/_pr-comment.md"
{
  echo "## Board Review — $final"; echo
  echo "Reviewed by 9 ephemeral codex agents through the agent-chat board pipeline."; echo
  echo "**Vote**: APPROVE=$approve, CHANGES_REQUESTED=$changes, REJECT=$reject, MISSING=$missing"; echo
  if [ ${#veto_rejects[@]} -gt 0 ]; then
    echo "**Veto by**: ${veto_rejects[*]} (Sentinel + Cadence have VETO power per the constitutional rules)"; echo
  fi
  echo "### Red flags"; echo
  if [ ${#all_red_flags[@]} -gt 0 ]; then
    for f in "${all_red_flags[@]}"; do echo "- $f"; done
  else
    echo "None reported."
  fi
  echo
  echo "### Per-axis aggregate (n=$((approve+changes+reject)))"
  echo "- clarity: $(mean $clarity_sum $clarity_n) / 10"
  echo "- depth: $(mean $depth_sum $depth_n) / 10"
  echo "- reliability: $(mean $reliability_sum $reliability_n) / 10"
  echo "- speed: $(mean $speed_sum $speed_n) / 10"
  echo
  echo "Full per-reviewer reasoning + audit trail: \`$DECISION_FILE\` (9 reviewer markdown files in same dir)"; echo
  echo "🤖 Generated through agent-chat board-review pipeline"
} > "$COMMENT"

if gh pr comment "$PR" --repo "$UPSTREAM_REPO" --body-file "$COMMENT" 2>"$OUT/_post-stderr.log"; then
  echo "[board-review] PR comment posted to PR #$PR"
else
  echo "[board-review] PR comment FAILED — see $OUT/_post-stderr.log"
fi

# === STAGE 5: ledger entry ===================================================

{
  echo -n "{"
  echo -n "\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo -n "\"pr\":$PR,"
  echo -n "\"slug\":\"$SLUG\","
  echo -n "\"decision\":\"$final\","
  echo -n "\"approve\":$approve,\"changes_requested\":$changes,\"reject\":$reject,\"missing\":$missing,"
  echo -n "\"reliability_mean\":$(mean $reliability_sum $reliability_n)"
  echo "}"
} >> "$LEDGER"

echo "[board-review] ledger updated: $LEDGER"
echo "[board-review] DONE — $final on PR #$PR"
exit 0
