#!/bin/bash
# tools/orion-autopilot/dispatch-claude.sh — claude-runtime sibling of dispatch-codex.sh.
#
# When to use which:
#   dispatch-codex.sh — non-security work (architecture, docs, generic
#     code edits). Codex's OpenAI safety filter rejects CWE-adjacent
#     prompts (lesson: codex-safety-filter-blocks-cwe).
#   dispatch-claude.sh — security-skill authoring, security review,
#     CWE-tagged content. Claude does not have an analogous filter.
#
# Both scripts share the same CLI shape so callers can substitute by
# changing the script name.
#
# Lifecycle (mirrors dispatch-codex.sh):
#   1. cost-track.sh check-spawn <estimate>  — refuse if over budget
#   2. claude -p (background) with prompt fed on stdin
#   3. log to <conv>/.driver-state/dispatches/<slug>-<ts>.log
#   4. on completion: cost-track.sh add ... with token count from log
#                    or from output-size estimate when count unavailable
#
# Differences from dispatch-codex.sh:
#   - default model is claude-opus-4-7 (orion's model)
#   - sets AGENT_CHAT_INSIDE_LLM_CALL=1 to prevent claude inside agent-
#     chat session from re-entering identity/locking machinery
#   - claude -p doesn't emit a "tokens used\n<count>" footer; the cost
#     log estimates from OUTPUT byte count (4 bytes ≈ 1 token rough
#     average for English text)
#
# Usage:
#   dispatch-claude.sh \
#     --slug <kebab-id>
#     --prompt-file <path>
#     --estimate-usd <float>
#     --spawn-type <type>      # claude-investigate|claude-fix|claude-review
#     --ref <ref>
#     [--model <id>]           # default claude-opus-4-7
#     [--cwd <path>]           # default $PWD
#     [--watcher-out <path>]   # for run_in_background watcher integration
#     [--verify-tests <cmd>]   # optional post-spawn verification.
#                              # Run as `bash -c <cmd>` in --cwd with GIT_*
#                              # env unset. Non-zero exit → status=verify-fail.
#                              # Lesson: dispatch-verify-tests-required
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
SPAWN_TYPE="claude-investigate"
REF=""
MODEL="claude-opus-4-7"
CLAUDE_CWD="$PWD"
WATCHER_OUT=""
VERIFY_CMD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)          SLUG=$2; shift 2 ;;
    --prompt-file)   PROMPT_FILE=$2; shift 2 ;;
    --estimate-usd)  ESTIMATE_USD=$2; shift 2 ;;
    --spawn-type)    SPAWN_TYPE=$2; shift 2 ;;
    --ref)           REF=$2; shift 2 ;;
    --model)         MODEL=$2; shift 2 ;;
    --cwd)           CLAUDE_CWD=$2; shift 2 ;;
    --watcher-out)   WATCHER_OUT=$2; shift 2 ;;
    --verify-tests)  VERIFY_CMD=$2; shift 2 ;;
    -h|--help)
      grep -E "^#" "$0" | head -55
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
#
# AGENT_CHAT_INSIDE_LLM_CALL=1 prevents re-entrancy if the dispatched
# claude itself loads the agent-chat skill (which would try to claim a
# session identity and lock files). See lib.ts reentrancy guard.

(
  cd "$CLAUDE_CWD" || exit 1
  AGENT_CHAT_INSIDE_LLM_CALL=1 \
    cat "$PROMPT_FILE" | claude -p --model "$MODEL" \
      --dangerously-skip-permissions \
      > "$LOG" 2>&1
) &
CLAUDE_PID=$!

STATE_FILE="$DISPATCH_DIR/${SLUG}-${TS}.state.json"
jq -nc \
  --arg slug "$SLUG" \
  --arg ts "$TS" \
  --argjson pid "$CLAUDE_PID" \
  --argjson start_ts "$START_TS" \
  --arg log "$LOG" \
  --arg prompt_file "$PROMPT_FILE" \
  --arg spawn_type "$SPAWN_TYPE" \
  --arg ref "$REF" \
  --argjson estimate_usd "$ESTIMATE_USD" \
  --arg cwd "$CLAUDE_CWD" \
  --arg model "$MODEL" \
  --argjson prompt_chars "$PROMPT_CHARS" \
  '{slug:$slug, ts:$ts, pid:$pid, start_ts:$start_ts, log:$log,
    prompt_file:$prompt_file, spawn_type:$spawn_type, ref:$ref,
    estimate_usd:$estimate_usd, cwd:$cwd, model:$model,
    prompt_chars:$prompt_chars, runtime:"claude"}' \
  > "$STATE_FILE"

echo "{\"pid\":$CLAUDE_PID,\"log\":\"$LOG\",\"state\":\"$STATE_FILE\",\"slug\":\"$SLUG\",\"ts\":\"$TS\",\"runtime\":\"claude\",\"model\":\"$MODEL\"}"

# ─── Optional: watcher-out summary on completion ────────────────────────

if [ -n "$WATCHER_OUT" ]; then
  (
    while kill -0 "$CLAUDE_PID" 2>/dev/null; do
      sleep 5
    done
    END_TS=$(date -u +%s)
    ELAPSED=$((END_TS - START_TS))

    # Token count: claude -p doesn't emit a count footer. Estimate from
    # output byte size: ~4 bytes per token for English text.
    OUTPUT_BYTES=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" 2>/dev/null || echo 0)
    EST_INPUT_TOKENS=$((PROMPT_BYTES / 4))
    EST_OUTPUT_TOKENS=$((OUTPUT_BYTES / 4))

    # Status: if log exists and is non-trivial size, treat as ok
    STATUS="ok"
    [ "$OUTPUT_BYTES" -lt 100 ] && STATUS="incomplete"

    # Optional post-spawn verification (mirrors dispatch-codex.sh).
    VERIFY_RC=""
    VERIFY_LOG=""
    if [ -n "$VERIFY_CMD" ] && [ "$STATUS" = "ok" ]; then
      VERIFY_LOG="${LOG%.log}.verify.log"
      (
        cd "$CLAUDE_CWD"
        unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
        bash -c "$VERIFY_CMD" > "$VERIFY_LOG" 2>&1
      )
      VERIFY_RC=$?
      [ "$VERIFY_RC" -ne 0 ] && STATUS="verify-fail"
    fi

    NOTES="auto-logged by dispatch-claude.sh ($SLUG; tokens estimated from byte sizes)"
    [ -n "$VERIFY_CMD" ] && NOTES="$NOTES; verify rc=$VERIFY_RC log=$VERIFY_LOG"

    "$COST_TRACK" add \
      --agent orion-driver \
      --spawn-type "$SPAWN_TYPE" \
      --ref "$REF" \
      --runtime claude \
      --model "$MODEL" \
      --input-tok "$EST_INPUT_TOKENS" \
      --output-tok "$EST_OUTPUT_TOKENS" \
      --duration-s "$ELAPSED" \
      --status "$STATUS" \
      --notes "$NOTES" >/dev/null 2>&1

    echo "DISPATCH_DONE slug=$SLUG runtime=claude status=$STATUS elapsed=${ELAPSED}s est_in=$EST_INPUT_TOKENS est_out=$EST_OUTPUT_TOKENS log=$LOG verify_rc=${VERIFY_RC:-NA} verify_log=${VERIFY_LOG:-NA}" >> "$WATCHER_OUT"
  ) &
fi
