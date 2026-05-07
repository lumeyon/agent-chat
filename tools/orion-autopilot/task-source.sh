#!/bin/bash
# tools/orion-autopilot/task-source.sh — unified task discovery for the orion driver.
#
# Inspired by ruflo's autopilot task-source layer (TaskList / MCP swarm /
# file-checklist). Yields candidate tasks from multiple sources as JSON
# lines on stdout. The orion driver picks the next task based on priority
# and dispatches to the right handler.
#
# Output format (one JSON object per line):
#   {
#     "type": "website-issue" | "gh-issue" | "pr-review" | "skill-fix",
#     "source": "<file path or repo>",
#     "ref": "<issue number / PR number / line range>",
#     "priority": 0..3 (0=P0 critical, 3=P3 cleanup),
#     "slug": "<short kebab-case identifier>",
#     "title": "<human-readable title>",
#     "repo": "<owner/repo for dispatch context>",
#     "handler": "<tools/orion-autopilot/handlers/<name>.sh>"  // future
#   }
#
# Priority encoding:
#   - WEBSITE_ISSUES.md numbered items: priority follows the founder's
#     P0/P1/P2 column in north-star-execution.md (table of issues)
#   - GitHub issues with label `priority:p0`/`p1`/`p2`/`p3` use that
#   - PR reviews default to priority 2 (catalog quality, important but
#     not customer-blocking)
#
# Today's emit (this commit, MVP): only website-issue + pr-review sources.
# Next iteration: gh-issue + skill-fix.

set +e

OUTPUT_FORMAT=${1:-jsonl}   # jsonl (default) or pretty
LIMIT=${2:-100}              # max tasks to emit

LUMEYON_REPO_PATH=/data/eyon/git/lumeyon
WEBSITE_ISSUES="$LUMEYON_REPO_PATH/WEBSITE_ISSUES.md"
PR_REPO=lumeyon/lumeyon-security-skills

emit() {
  if [ "$OUTPUT_FORMAT" = "pretty" ]; then
    echo "$1" | jq -r '"\(.priority) \(.type | .[0:12]) \(.ref) \(.title // .slug)"' 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

count=0

# ─── Source 1: WEBSITE_ISSUES.md ─────────────────────────────────────────
#
# Parse the numbered list. Each item gets priority based on the
# north-star-execution.md mapping table (P0/P1/P2). Hard-coded for now;
# could be derived from a YAML preamble in WEBSITE_ISSUES.md later.

declare -A WI_PRIORITY=(
  [1]=2  # cookie dialog (P1 in north-star but lower-impact)
  [2]=2  # mobile (P1)
  [3]=1  # skills checkbox (P1, blocks main UX)
  [4]=2  # grouping
  [5]=0  # firestore permission-denied (P0)
  [6]=0  # subscription tier coupling (P0 — can't bill)
  [7]=3  # menu animation (cosmetic)
  [8]=3  # remove API key (cleanup)
  [9]=2  # main-page promises need skills
  [10]=1 # scan execution service
  [11]=3 # show AI Author
  [12]=3 # devnet Solana address per skill
  [13]=2 # skills repo versioning
)

if [ -f "$WEBSITE_ISSUES" ]; then
  # Parse numbered items. Each starts with "<N>. " at line start.
  # Use awk to capture each item including continuation lines.
  awk '
    /^[0-9]+\. / {
      if (n) print num "|" buf
      num = $0; sub(/\..*/, "", num)
      buf = $0
      n = 1
      next
    }
    n { buf = buf " " $0 }
    END { if (n) print num "|" buf }
  ' "$WEBSITE_ISSUES" | while IFS='|' read -r num body; do
    [ -z "$num" ] && continue
    priority=${WI_PRIORITY[$num]:-2}
    # First sentence as title
    title=$(echo "$body" | sed 's/^[0-9]*\. //' | head -c 120 | tr -d '\n' | sed 's/[[:space:]]*$//')
    slug=$(echo "$title" | head -c 40 | tr '[:upper:]' '[:lower:]' \
           | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | head -c 40)
    json=$(jq -nc \
      --arg type "website-issue" \
      --arg source "$WEBSITE_ISSUES" \
      --arg ref "$num" \
      --argjson priority "$priority" \
      --arg slug "$slug" \
      --arg title "$title" \
      --arg repo "lumeyon/lumeyon" \
      '{type:$type, source:$source, ref:$ref, priority:$priority, slug:$slug, title:$title, repo:$repo}')
    emit "$json"
    ((count++))
    [ "$count" -ge "$LIMIT" ] && exit 0
  done
fi

# ─── Source 2: PR backlog on lumeyon-security-skills ────────────────────

if [ "$count" -lt "$LIMIT" ]; then
  if command -v gh >/dev/null 2>&1; then
    PRS=$(gh pr list --repo "$PR_REPO" --state open --limit 100 \
          --json number,headRefName,title,updatedAt 2>/dev/null)
    if [ -n "$PRS" ]; then
      echo "$PRS" | jq -c '. | sort_by(.updatedAt) | .[]' 2>/dev/null \
      | while read -r row; do
        pr=$(echo "$row" | jq -r .number)
        title=$(echo "$row" | jq -r .title)
        branch=$(echo "$row" | jq -r .headRefName | sed 's|^[^:]*:||')
        slug=$(echo "$title" | grep -oP '(?:skill:\s*|skill\s+|Add\s+)\K[a-z0-9-]+' | head -1)
        [ -z "$slug" ] && slug=$(echo "$title" | head -c 40 | tr '[:upper:]' '[:lower:]' \
                                  | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | head -c 40)
        json=$(jq -nc \
          --arg type "pr-review" \
          --arg source "$PR_REPO" \
          --arg ref "$pr" \
          --argjson priority 2 \
          --arg slug "$slug" \
          --arg title "$title" \
          --arg repo "$PR_REPO" \
          --arg branch "$branch" \
          '{type:$type, source:$source, ref:$ref, priority:$priority, slug:$slug, title:$title, repo:$repo, branch:$branch}')
        emit "$json"
        ((count++))
        [ "$count" -ge "$LIMIT" ] && break
      done
    fi
  fi
fi

# ─── Future sources (stubs) ──────────────────────────────────────────────
#
# Source 3: GitHub Issues on lumeyon/lumeyon
#   gh issue list --repo lumeyon/lumeyon ... → emit type="gh-issue"
#
# Source 4: Skill-fix work (PRs that were BLOCKED-BY-VETO and need
#   author-side fixes — orion could dispatch a codex spawn AS the
#   skill author to fix the bugs the board flagged, then re-review)
#   Read backlog-drain.jsonl for BLOCKED-BY-VETO entries; emit
#   type="skill-fix" with the consensus reasoning attached
#
# Source 5: Discovery — main-page promises that lack backing skills.
#   Cross-reference WEBSITE_ISSUES.md #9 against actual skills list.
#   Emit type="skill-author" tasks for each missing topic.

# Empty-output handling: if no tasks emitted at all, exit nonzero so
# the orion driver can decide whether to wait or stop.
[ "$count" -eq 0 ] && exit 1
exit 0
