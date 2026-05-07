#!/bin/bash
# scripts/board/dispatch-codex.sh — wrap the codex-spawn pattern with
# pre-flight budget gate, background dispatch, and post-hoc cost log.
#
# Captures the pattern proved out in tick 6 (north-star-execution.md):
#
#   1. cost-track.sh check-spawn <estimate>   — refuse if over budget
#   2. codex exec --dangerously-bypass-approvals-and-sandbox -            (background)
#   3. log to <conv>/.driver-state/dispatches/<slug>-<ts>.log
#   4. on completion: cost-track.sh add ... with token count from log
#
# Usage:
#   dispatch-codex.sh \
#     --slug <kebab-id>                # e.g. issue-6-tiers-apply
#     --prompt-file <path>             # markdown prompt file fed on stdin
#     --estimate-usd <float>           # for budget gate (refuses if over)
#     --spawn-type <type>              # codex-investigate|codex-fix|codex-review
#     --ref <ref>                      # context handle for ledger
#     [--cwd <path>]                   # cwd for codex (default $PWD)
#     [--watcher-out <path>]           # where the post-completion summary lands
#                                      # (default: stdout when foreground; for
#                                      #  background use, capture --watcher-out
#                                      #  via a separate `Bash run_in_background`
#                                      #  call that tail-watches it)
#     [--verify-tests <command>]       # optional post-spawn verification.
#                                      # Run as `bash -c <command>` in --cwd
#                                      # with GIT_* env unset. Non-zero exit
#                                      # flips status to verify-fail in ledger.
#                                      # Lesson: dispatch-verify-tests-required
#
# Exits non-zero if budget gate refuses or arguments missing.
# Prints a JSON summary on stdout: {pid, log, started_at, slug, prompt_chars}.

set +e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
COST_TRACK="$SCRIPT_DIR/cost-track.sh"

CONV_DIR=${AGENT_CHAT_CONVERSATIONS_DIR:-/data/lumeyon/agent-chat/conversations}
DISPATCH_DIR="$CONV_DIR/.driver-state/dispatches"
mkdir -p "$DISPATCH_DIR"

SLUG=""
PROMPT_FILE=""
ESTIMATE_USD=""
SPAWN_TYPE="codex-investigate"
REF=""
CODEX_CWD="$PWD"
WATCHER_OUT=""
VERIFY_CMD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)          SLUG=$2; shift 2 ;;
    --prompt-file)   PROMPT_FILE=$2; shift 2 ;;
    --estimate-usd)  ESTIMATE_USD=$2; shift 2 ;;
    --spawn-type)    SPAWN_TYPE=$2; shift 2 ;;
    --ref)           REF=$2; shift 2 ;;
    --cwd)           CODEX_CWD=$2; shift 2 ;;
    --watcher-out)   WATCHER_OUT=$2; shift 2 ;;
    --verify-tests)  VERIFY_CMD=$2; shift 2 ;;
    -h|--help)
      grep -E "^#" "$0" | head -50
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -z "$SLUG" ]         && { echo "missing --slug" >&2; exit 2; }
[ -z "$PROMPT_FILE" ]  && { echo "missing --prompt-file" >&2; exit 2; }
[ -z "$ESTIMATE_USD" ] && { echo "missing --estimate-usd" >&2; exit 2; }
[ ! -f "$PROMPT_FILE" ] && { echo "prompt file not found: $PROMPT_FILE" >&2; exit 2; }

# ─── Pre-flight: budget gate ─────────────────────────────────────────────

CHECK_OUT=$("$COST_TRACK" check-spawn "$ESTIMATE_USD" 2>&1)
CHECK_RC=$?
if [ "$CHECK_RC" -ne 0 ]; then
  echo "BUDGET_REFUSED: $CHECK_OUT" >&2
  exit 1
fi
echo "budget OK: $CHECK_OUT" >&2

# ─── Set up dispatch artifacts ───────────────────────────────────────────

TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$DISPATCH_DIR/${SLUG}-${TS}.log"
START_TS=$(date -u +%s)
PROMPT_CHARS=$(wc -c < "$PROMPT_FILE")

# ─── Dispatch ────────────────────────────────────────────────────────────

(
  cd "$CODEX_CWD" || exit 1
  cat "$PROMPT_FILE" | codex exec --dangerously-bypass-approvals-and-sandbox - \
    > "$LOG" 2>&1
) &
CODEX_PID=$!

# Persist state for the watcher script
STATE_FILE="$DISPATCH_DIR/${SLUG}-${TS}.state.json"
jq -nc \
  --arg slug "$SLUG" \
  --arg ts "$TS" \
  --argjson pid "$CODEX_PID" \
  --argjson start_ts "$START_TS" \
  --arg log "$LOG" \
  --arg prompt_file "$PROMPT_FILE" \
  --arg spawn_type "$SPAWN_TYPE" \
  --arg ref "$REF" \
  --argjson estimate_usd "$ESTIMATE_USD" \
  --arg cwd "$CODEX_CWD" \
  --argjson prompt_chars "$PROMPT_CHARS" \
  '{slug:$slug, ts:$ts, pid:$pid, start_ts:$start_ts, log:$log,
    prompt_file:$prompt_file, spawn_type:$spawn_type, ref:$ref,
    estimate_usd:$estimate_usd, cwd:$cwd, prompt_chars:$prompt_chars}' \
  > "$STATE_FILE"

# ─── Print summary for caller ───────────────────────────────────────────

echo "{\"pid\":$CODEX_PID,\"log\":\"$LOG\",\"state\":\"$STATE_FILE\",\"slug\":\"$SLUG\",\"ts\":\"$TS\"}"

# ─── Optional: emit a watcher-friendly summary on completion ────────────
#
# If --watcher-out was given, append a final summary line to that file
# when codex exits. This is the line a Bash run_in_background `until`
# loop or a Monitor can wake on.

if [ -n "$WATCHER_OUT" ]; then
  (
    while kill -0 "$CODEX_PID" 2>/dev/null; do
      sleep 5
    done
    END_TS=$(date -u +%s)
    ELAPSED=$((END_TS - START_TS))
    # Extract token count from codex log. Codex 0.128.0 emits the count
    # on the line AFTER a literal "tokens used" header line, e.g.:
    #   tokens used
    #   283,197
    # awk picks up the line after the header, strips commas.
    TOKENS=$(awk '/^tokens used\s*$/ {getline; gsub(/,/,""); print; exit}' "$LOG" 2>/dev/null)
    # Fallback: same-line format ("tokens used: 12345")
    [ -z "$TOKENS" ] && TOKENS=$(grep -oE 'tokens used[: ]+[0-9,]+' "$LOG" 2>/dev/null \
                                | grep -oE '[0-9,]+' | tr -d ',' | tail -1)
    [ -z "$TOKENS" ] && TOKENS=0
    DONE_LINE=$(grep -c "^DONE\s*$" "$LOG" 2>/dev/null)
    STATUS=$([ "$DONE_LINE" -gt 0 ] && echo "ok" || echo "incomplete")

    # Optional post-spawn verification — runs the caller-supplied command
    # in the dispatch's CWD with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
    # unset (per git-hook-flutter-version-leak lesson) so test runners
    # see a clean env. Failure flips status to verify-fail in the ledger.
    VERIFY_RC=""
    VERIFY_LOG=""
    if [ -n "$VERIFY_CMD" ] && [ "$STATUS" = "ok" ]; then
      VERIFY_LOG="${LOG%.log}.verify.log"
      (
        cd "$CODEX_CWD"
        unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
        bash -c "$VERIFY_CMD" > "$VERIFY_LOG" 2>&1
      )
      VERIFY_RC=$?
      [ "$VERIFY_RC" -ne 0 ] && STATUS="verify-fail"
    fi

    # Auto-log cost (assume 70/30 input/output split for codex-gpt-5 estimate)
    NOTES="auto-logged by dispatch-codex.sh ($SLUG)"
    [ -n "$VERIFY_CMD" ] && NOTES="$NOTES; verify rc=$VERIFY_RC log=$VERIFY_LOG"
    if [ "$TOKENS" -gt 0 ]; then
      ITOK=$((TOKENS * 70 / 100))
      OTOK=$((TOKENS - ITOK))
      "$COST_TRACK" add \
        --agent orion-driver \
        --spawn-type "$SPAWN_TYPE" \
        --ref "$REF" \
        --runtime codex \
        --model codex-gpt-5 \
        --input-tok "$ITOK" \
        --output-tok "$OTOK" \
        --duration-s "$ELAPSED" \
        --status "$STATUS" \
        --notes "$NOTES" >/dev/null 2>&1
    fi
    echo "DISPATCH_DONE slug=$SLUG status=$STATUS elapsed=${ELAPSED}s tokens=$TOKENS log=$LOG verify_rc=${VERIFY_RC:-NA} verify_log=${VERIFY_LOG:-NA}" >> "$WATCHER_OUT"
  ) &
fi
