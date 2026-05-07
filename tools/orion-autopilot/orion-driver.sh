#!/bin/bash
# tools/orion-autopilot/orion-driver.sh — long-running orion-as-orchestrator driver.
#
# Equivalent to ruflo's daemon pattern but using agent-chat's filesystem-
# mediated wire protocol. orion (this process) is the identity; the loop
# below is the orchestrator. When reasoning is needed, it shells out to
# `claude -p` for that specific decision (per-PR review uses ephemeral
# codex via tools/orion-autopilot/review.sh).
#
# Lifecycle:
#   1. Acquire orion presence record (refuse if another live orion exists)
#   2. Poll upstream PR list every POLL_SEC seconds
#   3. For each unreviewed-recently PR, dispatch the 9-agent board review
#      via tools/orion-autopilot/review.sh (self-contained pipeline)
#   4. If the consensus is ambiguous (e.g. high disagreement, low
#      reliability mean), invoke `claude -p` for a tie-break decision
#      before posting
#   5. Log every action to <conv>/.driver-state/orion-driver.log + the
#      backlog-drain.jsonl ledger
#   6. Loop until: backlog drops below STOP_THRESHOLD PRs, or SIGTERM
#
# Usage:
#   AGENT_CHAT_CONVERSATIONS_DIR=/data/lumeyon/agent-chat/conversations \
#     tools/orion-autopilot/orion-driver.sh \
#     [--upstream <owner/repo>] [--threshold N] [--poll-sec N] [--max-prs N]
#     [--once]   # process at most one PR then exit (for testing)
#
# Designed to be installable as a systemd user service via the existing
# install-autowatch-systemd.ts pattern. For interactive runs, just
# foreground it and watch the log.

set +e  # bash gotchas with arithmetic; tolerate failures in inner loops

# ─── Defaults + arg parse ────────────────────────────────────────────────

UPSTREAM=lumeyon/lumeyon-security-skills
STOP_THRESHOLD=15           # founder pause threshold
POLL_SEC=120                # 2 min between cycles
MAX_PRS=50                  # safety cap per driver lifetime
RE_REVIEW_HOURS=24          # don't re-review the same PR within N hours
ONCE=0
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REVIEW_SH="$SCRIPT_DIR/review.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM=$2; shift 2 ;;
    --threshold) STOP_THRESHOLD=$2; shift 2 ;;
    --poll-sec) POLL_SEC=$2; shift 2 ;;
    --max-prs) MAX_PRS=$2; shift 2 ;;
    --re-review-hours) RE_REVIEW_HOURS=$2; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help)
      grep -E "^#" "$0" | head -40
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CONV_DIR=${AGENT_CHAT_CONVERSATIONS_DIR:-/data/lumeyon/agent-chat/conversations}
DRIVER_DIR="$CONV_DIR/.driver-state"
LOG="$DRIVER_DIR/orion-driver.log"
PRESENCE="$DRIVER_DIR/orion.json"
LEDGER="$CONV_DIR/board-reviews/backlog-drain.jsonl"
mkdir -p "$DRIVER_DIR" "$CONV_DIR/board-reviews"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
}

# ─── Presence acquisition (refuse if another orion-driver is live) ───────

if [ -s "$PRESENCE" ]; then
  OLD_PID=$(jq -r .pid "$PRESENCE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "REFUSE: another orion-driver is alive at pid $OLD_PID — not starting"
    exit 1
  fi
fi

cat > "$PRESENCE" <<EOF
{"agent":"orion","role":"driver","pid":$$,"started_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","upstream":"$UPSTREAM","threshold":$STOP_THRESHOLD,"poll_sec":$POLL_SEC,"once":$ONCE}
EOF

trap 'log "shutdown signal received"; rm -f "$PRESENCE"; exit 0' SIGTERM SIGINT
trap 'log "exiting normally"; rm -f "$PRESENCE"' EXIT

# ─── Helpers ─────────────────────────────────────────────────────────────

# Extract the skill slug from a PR title. Handles a few common shapes:
#   "skill: foo-bar (CWE-...)" → foo-bar
#   "skill foo-bar" → foo-bar
#   "Add foo-bar skill" → foo-bar
#   "fix: relax cors null_origin..." → cors-null-origin (best effort)
slug_from_title() {
  local title="$1"
  echo "$title" | grep -oP '(?:skill:\s*|skill\s+|Add\s+)\K[a-z0-9-]+' | head -1 \
    || echo "$title" | grep -oP '[a-z0-9]+(?:-[a-z0-9]+)+' | head -1 \
    || echo "unknown-slug"
}

# Was this PR reviewed in the last N hours?
already_reviewed_recently() {
  local pr=$1
  [ -s "$LEDGER" ] || return 1
  local last_ts
  last_ts=$(grep "\"pr\":$pr," "$LEDGER" 2>/dev/null | tail -1 | jq -r .ts 2>/dev/null)
  [ -z "$last_ts" ] && return 1
  local last_epoch now_epoch hours_since
  last_epoch=$(date -d "$last_ts" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  hours_since=$(( (now_epoch - last_epoch) / 3600 ))
  [ "$hours_since" -lt "$RE_REVIEW_HOURS" ]
}

# ─── Main loop ───────────────────────────────────────────────────────────

log "orion-driver starting (upstream=$UPSTREAM threshold=$STOP_THRESHOLD poll=$POLL_SEC max=$MAX_PRS once=$ONCE)"
log "presence: $PRESENCE"
log "log: $LOG"
log "ledger: $LEDGER"

processed=0
cycles=0

while true; do
  ((cycles++))

  # Fetch open PR list
  PRS_JSON=$(gh pr list --repo "$UPSTREAM" --state open --limit 100 \
             --json number,headRefName,title,updatedAt 2>>"$LOG")
  REMAINING=$(echo "$PRS_JSON" | jq 'length')

  log "cycle #$cycles: $REMAINING open PRs upstream"

  if [ "$REMAINING" -lt "$STOP_THRESHOLD" ]; then
    log "STOP: backlog $REMAINING < threshold $STOP_THRESHOLD; founder pause threshold cleared"
    exit 0
  fi

  if [ "$processed" -ge "$MAX_PRS" ]; then
    log "STOP: reached MAX_PRS=$MAX_PRS this lifetime; restart driver to continue"
    exit 0
  fi

  # Find oldest-updated unreviewed-recently PR
  PICKED=""
  while read -r row; do
    pr=$(echo "$row" | jq -r .number)
    if already_reviewed_recently "$pr"; then
      continue
    fi
    PICKED="$row"
    break
  done < <(echo "$PRS_JSON" | jq -c 'sort_by(.updatedAt) | .[]')

  if [ -z "$PICKED" ]; then
    log "no PR needs review this cycle (all $REMAINING reviewed within $RE_REVIEW_HOURS h); sleeping"
    [ "$ONCE" -eq 1 ] && exit 0
    sleep "$POLL_SEC"
    continue
  fi

  PR=$(echo "$PICKED" | jq -r .number)
  TITLE=$(echo "$PICKED" | jq -r .title)
  BRANCH=$(echo "$PICKED" | jq -r .headRefName | sed 's|^[^:]*:||')
  SLUG=$(slug_from_title "$TITLE")

  log "→ PR #$PR ($SLUG): \"$TITLE\""
  log "  branch: $BRANCH"

  # Run the self-contained review pipeline
  if "$REVIEW_SH" "$PR" "$SLUG" "$BRANCH" >>"$LOG" 2>&1; then
    log "✓ PR #$PR pipeline completed"
  else
    log "✗ PR #$PR pipeline FAILED (exit $?)"
  fi

  ((processed++))
  [ "$ONCE" -eq 1 ] && { log "ONCE mode — exiting after one PR"; exit 0; }

  # Politeness delay
  sleep "$POLL_SEC"
done
