#!/bin/bash
# tools/orion-autopilot/orion-driver-v2.sh — generalized autopilot driver.
#
# Closes the ruflo autopilot-loop pattern (status → predict → execute →
# log → schedule) using agent-chat's three primitives:
#
#   task-source.sh    — yields prioritized tasks (status step)
#   cost-track.sh     — pre-spawn budget gate (predict step)
#   dispatch-codex.sh — background spawn + cost-log (execute + log)
#
# v1 (orion-driver.sh) only knew about PR-review tasks. v2 routes
# across multiple task types using a per-type handler table.
#
# Lifecycle (single cycle, --once mode by default for safety):
#   1. Acquire driver presence (refuse if another v2 is alive)
#   2. Call task-source.sh, get JSON queue
#   3. Filter out tasks already in flight (claims.jsonl) or already
#      complete (per-type completion check)
#   4. Pick highest-priority remaining task
#   5. Route to handler:
#       pr-review      → review.sh <pr> <slug> <branch>
#       website-issue  → diagnose-or-skip (NOT auto-spawned in v2;
#                        marks task as "needs-orion-prompt" and emits
#                        a recommendation for the next loop tick)
#       gh-issue       → same as website-issue for now
#   6. Update claims.jsonl
#   7. Log to driver log
#
# Why website-issue isn't auto-spawned yet: the issue-text from
# WEBSITE_ISSUES.md isn't enough context for a useful codex spawn.
# Each issue needs an orion-curated prompt (like the issue-6 plan
# prompt). v2 surfaces "this is the next task to scope a prompt for"
# rather than firing blindly.
#
# Usage:
#   AGENT_CHAT_CONVERSATIONS_DIR=/data/lumeyon/agent-chat/conversations \
#     tools/orion-autopilot/orion-driver-v2.sh
#     [--once]      # default; one cycle then exit
#     [--loop]      # run continuously (sleeps POLL_SEC between cycles)
#     [--poll-sec N]
#     [--dry-run]   # don't dispatch; just print the chosen task
#
# Exits non-zero on configuration error; exits 0 with empty output if
# there are no actionable tasks.

set +e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TASK_SOURCE="$SCRIPT_DIR/task-source.sh"
REVIEW_SH="$SCRIPT_DIR/review.sh"
COST_TRACK="$SCRIPT_DIR/cost-track.sh"

CONV_DIR=${AGENT_CHAT_CONVERSATIONS_DIR:-/data/lumeyon/agent-chat/conversations}
DRIVER_DIR="$CONV_DIR/.driver-state"
PRESENCE="$DRIVER_DIR/orion-v2.json"
LOG="$DRIVER_DIR/orion-driver-v2.log"
CLAIMS="$DRIVER_DIR/claims.jsonl"
RECOMMENDATIONS="$DRIVER_DIR/v2-next-recommendation.md"
mkdir -p "$DRIVER_DIR"

POLL_SEC=120
ONCE=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --once)        ONCE=1; shift ;;
    --loop)        ONCE=0; shift ;;
    --poll-sec)    POLL_SEC=$2; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      grep -E "^#" "$0" | head -50
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
}

# ─── Presence ────────────────────────────────────────────────────────────

if [ -s "$PRESENCE" ]; then
  OLD_PID=$(jq -r .pid "$PRESENCE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "REFUSE: another orion-driver-v2 is alive at pid $OLD_PID"
    exit 1
  fi
fi
cat > "$PRESENCE" <<EOF
{"agent":"orion","role":"driver-v2","pid":$$,"started_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","once":$ONCE,"dry_run":$DRY_RUN}
EOF
trap 'rm -f "$PRESENCE"' EXIT

# ─── Task filtering ──────────────────────────────────────────────────────

# A task is "complete" if there's a diagnosis OR a worktree commit
# OR a posted PR comment for it. Cheap per-type checks:
is_complete() {
  local type=$1 ref=$2
  case "$type" in
    website-issue)
      # diagnosis file exists with non-trivial size
      local f="$CONV_DIR/diagnoses/issue-$ref-"*.md
      ls $f 2>/dev/null | grep -q . && [ -s "$(ls $f 2>/dev/null | head -1)" ]
      ;;
    pr-review)
      # last review in ledger within RE_REVIEW_HOURS
      local ledger="$CONV_DIR/board-reviews/backlog-drain.jsonl"
      [ -s "$ledger" ] || return 1
      local last_ts
      last_ts=$(grep "\"pr\":$ref," "$ledger" 2>/dev/null | tail -1 | jq -r .ts 2>/dev/null)
      [ -z "$last_ts" ] && return 1
      local last_epoch now hours
      last_epoch=$(date -d "$last_ts" +%s 2>/dev/null || echo 0)
      now=$(date +%s)
      hours=$(( (now - last_epoch) / 3600 ))
      [ "$hours" -lt 24 ]
      ;;
    *)
      return 1 ;;
  esac
}

# A task is "in flight" if claims.jsonl has an entry for it without
# a corresponding "release" within the last 1 hour.
is_in_flight() {
  local type=$1 ref=$2
  [ -s "$CLAIMS" ] || return 1
  local last_action
  last_action=$(jq -c --arg type "$type" --arg ref "$ref" \
    'select(.type == $type and .ref == $ref)' "$CLAIMS" 2>/dev/null \
    | tail -1)
  [ -z "$last_action" ] && return 1
  local action ts
  action=$(echo "$last_action" | jq -r .action)
  ts=$(echo "$last_action" | jq -r .ts)
  if [ "$action" = "claim" ]; then
    # If claim is older than 1h, treat as stale
    local last_epoch now diff
    last_epoch=$(date -d "$ts" +%s 2>/dev/null || echo 0)
    now=$(date +%s)
    diff=$(( now - last_epoch ))
    [ "$diff" -lt 3600 ]
  else
    return 1
  fi
}

claim_task() {
  local type=$1 ref=$2 slug=$3
  jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action claim --arg type "$type" --arg ref "$ref" --arg slug "$slug" \
    '{ts:$ts, action:$action, type:$type, ref:$ref, slug:$slug}' >> "$CLAIMS"
}
release_task() {
  local type=$1 ref=$2 slug=$3 status=$4
  jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action release --arg type "$type" --arg ref "$ref" \
    --arg slug "$slug" --arg status "$status" \
    '{ts:$ts, action:$action, type:$type, ref:$ref, slug:$slug, status:$status}' >> "$CLAIMS"
}

# ─── Handlers ────────────────────────────────────────────────────────────

handle_pr_review() {
  local task_json=$1
  local pr slug branch
  pr=$(echo "$task_json" | jq -r .ref)
  slug=$(echo "$task_json" | jq -r .slug)
  branch=$(echo "$task_json" | jq -r '.branch // ""')
  log "→ pr-review #$pr ($slug) branch=$branch"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  DRY-RUN: would dispatch $REVIEW_SH $pr $slug $branch"
    return 0
  fi
  claim_task pr-review "$pr" "$slug"
  if "$REVIEW_SH" "$pr" "$slug" "$branch" >>"$LOG" 2>&1; then
    release_task pr-review "$pr" "$slug" ok
    log "✓ pr-review #$pr completed"
    return 0
  else
    release_task pr-review "$pr" "$slug" fail
    log "✗ pr-review #$pr failed"
    return 1
  fi
}

handle_website_issue() {
  local task_json=$1
  local ref slug title
  ref=$(echo "$task_json" | jq -r .ref)
  slug=$(echo "$task_json" | jq -r .slug)
  title=$(echo "$task_json" | jq -r .title)
  log "→ website-issue #$ref ($slug)"
  log "  title: $title"
  log "  not auto-dispatching; orion needs to scope a prompt first"
  log "  emitting recommendation to: $RECOMMENDATIONS"
  cat > "$RECOMMENDATIONS" <<EOF
# v2 driver next-slice recommendation

The autopilot has selected the next task as a website-issue but cannot
auto-dispatch it without an orion-curated prompt. This file is rewritten
on each cycle.

## Selected task

\`\`\`json
$task_json
\`\`\`

## Why no auto-spawn

WEBSITE_ISSUES.md text is too brief to be a useful codex prompt. The
issue-6 dispatch worked because orion authored a 150-line prompt with
explicit constraints, file lists, and verification steps. That curation
is currently a human/orion bottleneck.

## Recommended next slice

orion (claude) writes a tight prompt at:

  \`<conv>/dispatches/issue-${ref}-investigate-prompt.md\`

scoped to investigate-only (no file edits). Then dispatches via:

  \`tools/orion-autopilot/dispatch-codex.sh \\
    --slug issue-${ref}-investigate \\
    --prompt-file <conv>/dispatches/issue-${ref}-investigate-prompt.md \\
    --estimate-usd 3.00 \\
    --spawn-type codex-investigate \\
    --ref "issue#${ref}-investigate"\`

Output: a diagnosis under \`<conv>/diagnoses/\` that the next loop tick
either approves into a "fix" dispatch or iterates on.

## Future improvement

Once 3-4 website-issue dispatches have produced diagnoses, harvest the
common prompt structure into a template at
\`<conv>/dispatches/_templates/website-issue-investigate.md\` so the
driver can auto-fill it from a task-source entry without orion
authoring each one from scratch.
EOF
  return 0
}

# ─── One cycle ──────────────────────────────────────────────────────────

run_cycle() {
  log "cycle start"
  local queue
  queue=$("$TASK_SOURCE" jsonl 100 2>/dev/null)
  if [ -z "$queue" ]; then
    log "task-source empty; nothing to do"
    return 0
  fi
  local total
  total=$(echo "$queue" | wc -l)
  log "task-source emitted $total candidates"

  # Sort by priority asc, take the first one not complete and not in flight
  local picked=""
  while read -r task; do
    [ -z "$task" ] && continue
    local type ref
    type=$(echo "$task" | jq -r .type)
    ref=$(echo "$task" | jq -r .ref)
    if is_complete "$type" "$ref"; then continue; fi
    if is_in_flight "$type" "$ref"; then continue; fi
    picked="$task"
    break
  done < <(echo "$queue" | jq -c '. | [inputs] | sort_by(.priority) | .[]' 2>/dev/null \
           || echo "$queue")  # jq -s alternative

  # Fallback: if jq -s with inputs failed, use jq -s style
  if [ -z "$picked" ]; then
    picked=$(echo "$queue" | jq -s -c 'sort_by(.priority) | .[]' 2>/dev/null \
             | while read -r task; do
                 type=$(echo "$task" | jq -r .type)
                 ref=$(echo "$task" | jq -r .ref)
                 is_complete "$type" "$ref" && continue
                 is_in_flight "$type" "$ref" && continue
                 echo "$task"
                 break
               done)
  fi

  if [ -z "$picked" ]; then
    log "no actionable task (all $total are complete or in flight)"
    return 0
  fi

  local picked_type
  picked_type=$(echo "$picked" | jq -r .type)
  log "picked: $picked"

  case "$picked_type" in
    pr-review)     handle_pr_review "$picked" ;;
    website-issue) handle_website_issue "$picked" ;;
    gh-issue)      handle_website_issue "$picked" ;;  # same shape for now
    *)             log "unknown type: $picked_type"; return 1 ;;
  esac
}

# ─── Main ───────────────────────────────────────────────────────────────

log "orion-driver-v2 starting (once=$ONCE dry_run=$DRY_RUN poll=$POLL_SEC)"

if [ "$ONCE" -eq 1 ]; then
  run_cycle
  exit $?
fi

while true; do
  run_cycle
  log "cycle complete; sleeping ${POLL_SEC}s"
  sleep "$POLL_SEC"
done
