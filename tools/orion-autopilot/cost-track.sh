#!/bin/bash
# tools/orion-autopilot/cost-track.sh — filesystem-native per-spawn cost ledger.
#
# Inspired by ruflo's ruflo-cost-tracker plugin
# (/data/eyon/git/ruflo/plugins/ruflo-cost-tracker/) but using JSONL on
# disk instead of agentdb, and matched to the runtimes agent-chat
# actually spawns (claude -p + codex exec).
#
# Same alert thresholds as ruflo: 50% info, 75% warn, 90% critical,
# 100% hard stop.
#
# Subcommands:
#   add <fields...>    — append one entry to <conv>/cost-ledger.jsonl
#   report [period]    — aggregate by period (today|week|month|all)
#   budget set <usd>   — set monthly budget cap; written to .driver-state/budget.json
#   budget get         — print current budget + utilization
#   estimate <model> <input_tok> <output_tok> — print USD estimate without logging
#
# Ledger entry shape:
#   {
#     "ts": "ISO-8601 UTC",
#     "agent": "<who spawned it>",        // orion / orion-driver / review.sh / etc.
#     "spawn_type": "<class>",            // codex-review / claude-investigate / etc.
#     "ref": "<context handle>",          // PR#43 / issue#5 / slug
#     "runtime": "claude" | "codex",
#     "model": "<model id>",
#     "input_tokens": <int>,              // -1 if unknown
#     "output_tokens": <int>,             // -1 if unknown
#     "duration_s": <int>,
#     "cost_usd": <float>,                // computed if tokens known, else estimated
#     "status": "ok" | "fail" | "veto" | "abort",
#     "notes": "<freeform>"
#   }
#
# Pricing (USD per Mtok, as of 2026-05-06; update when models change):
#
#   claude-opus-4-7      input  15.00  output 75.00
#   claude-sonnet-4-6    input   3.00  output 15.00
#   claude-haiku-4-5     input   0.80  output  4.00
#   codex-gpt-5          input   2.50  output 10.00   (estimate; refine when known)
#   codex-gpt-5-mini     input   0.25  output  1.00   (estimate)
#
# Unknown model → use claude-sonnet-4-6 rates as conservative midpoint.

set +e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CONV_DIR=${AGENT_CHAT_CONVERSATIONS_DIR:-/data/lumeyon/agent-chat/conversations}
LEDGER="$CONV_DIR/cost-ledger.jsonl"
DRIVER_DIR="$CONV_DIR/.driver-state"
BUDGET_FILE="$DRIVER_DIR/budget.json"
mkdir -p "$DRIVER_DIR"
[ ! -f "$LEDGER" ] && touch "$LEDGER"

# ─── Pricing table (per 1M tokens, USD) ──────────────────────────────────

price_for() {
  local model="$1"
  case "$model" in
    claude-opus-4-7|opus-4-7)         echo "15.00 75.00" ;;
    claude-sonnet-4-6|sonnet-4-6)     echo "3.00 15.00" ;;
    claude-haiku-4-5|haiku-4-5)       echo "0.80 4.00" ;;
    codex-gpt-5|gpt-5)                echo "2.50 10.00" ;;
    codex-gpt-5-mini|gpt-5-mini)      echo "0.25 1.00" ;;
    *)                                 echo "3.00 15.00" ;;  # unknown → sonnet midpoint
  esac
}

cost_from_tokens() {
  local model="$1" itok="$2" otok="$3"
  read -r in_rate out_rate <<< "$(price_for "$model")"
  awk -v i="$itok" -v o="$otok" -v ir="$in_rate" -v orr="$out_rate" \
    'BEGIN { printf "%.4f", (i/1e6)*ir + (o/1e6)*orr }'
}

# Rough fallback estimate when tokens unknown — based on observed averages
# per spawn-type from the round-15 board reviews:
#   codex-review (per 1 reviewer)  ~$0.30 (haiku-class with mid-context)
#   claude-investigate            ~$0.10 (opus, short)
#   claude-fix                    ~$0.50 (opus, longer + edit cycles)
estimate_cost() {
  local spawn_type="$1" duration_s="$2"
  case "$spawn_type" in
    codex-review)         echo "0.30" ;;
    codex-investigate)    echo "0.20" ;;
    codex-fix)            echo "0.60" ;;
    claude-investigate)   echo "0.10" ;;
    claude-fix)           echo "0.50" ;;
    claude-tick-glue)     echo "0.05" ;;
    *)                     echo "0.25" ;;  # generic fallback
  esac
}

# ─── add ────────────────────────────────────────────────────────────────

cmd_add() {
  local agent="" spawn_type="" ref="" runtime="" model="" \
        itok="-1" otok="-1" duration_s="0" status="ok" notes="" cost_usd=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --agent)       agent=$2; shift 2 ;;
      --spawn-type)  spawn_type=$2; shift 2 ;;
      --ref)         ref=$2; shift 2 ;;
      --runtime)     runtime=$2; shift 2 ;;
      --model)       model=$2; shift 2 ;;
      --input-tok)   itok=$2; shift 2 ;;
      --output-tok)  otok=$2; shift 2 ;;
      --duration-s)  duration_s=$2; shift 2 ;;
      --status)      status=$2; shift 2 ;;
      --notes)       notes=$2; shift 2 ;;
      --cost-usd)    cost_usd=$2; shift 2 ;;
      *) echo "unknown arg: $1" >&2; return 2 ;;
    esac
  done

  if [ -z "$cost_usd" ]; then
    if [ "$itok" -ge 0 ] && [ "$otok" -ge 0 ] && [ -n "$model" ]; then
      cost_usd=$(cost_from_tokens "$model" "$itok" "$otok")
    else
      cost_usd=$(estimate_cost "$spawn_type" "$duration_s")
    fi
  fi

  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local entry
  entry=$(jq -nc \
    --arg ts "$ts" \
    --arg agent "$agent" \
    --arg spawn_type "$spawn_type" \
    --arg ref "$ref" \
    --arg runtime "$runtime" \
    --arg model "$model" \
    --argjson input_tokens "$itok" \
    --argjson output_tokens "$otok" \
    --argjson duration_s "$duration_s" \
    --argjson cost_usd "$cost_usd" \
    --arg status "$status" \
    --arg notes "$notes" \
    '{ts:$ts, agent:$agent, spawn_type:$spawn_type, ref:$ref,
      runtime:$runtime, model:$model,
      input_tokens:$input_tokens, output_tokens:$output_tokens,
      duration_s:$duration_s, cost_usd:$cost_usd,
      status:$status, notes:$notes}')

  echo "$entry" >> "$LEDGER"
  echo "logged: \$$cost_usd  $spawn_type  $ref  ($status)"

  # Check budget threshold
  check_budget_threshold
}

# ─── budget ─────────────────────────────────────────────────────────────

cmd_budget() {
  local sub=$1; shift
  case "$sub" in
    set)
      local amount=$1
      jq -nc --argjson cap_usd "$amount" --arg set_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{cap_usd:$cap_usd, set_at:$set_at, period:"month"}' > "$BUDGET_FILE"
      echo "budget set: \$$amount/month"
      ;;
    get)
      if [ ! -s "$BUDGET_FILE" ]; then
        echo "no budget set"
        return 0
      fi
      local cap spent
      cap=$(jq -r .cap_usd "$BUDGET_FILE")
      spent=$(period_spend month)
      local pct
      pct=$(awk -v s="$spent" -v c="$cap" 'BEGIN { if (c>0) printf "%.1f", s/c*100; else print "0.0" }')
      echo "budget: \$$cap/month  spent: \$$spent  utilization: $pct%"
      ;;
    *) echo "usage: budget set <usd> | budget get" >&2; return 2 ;;
  esac
}

period_spend() {
  local period=$1
  local cutoff
  case "$period" in
    today)  cutoff=$(date -u -d 'today 00:00:00' +%s) ;;
    week)   cutoff=$(date -u -d '7 days ago' +%s) ;;
    month)  cutoff=$(date -u -d '30 days ago' +%s) ;;
    all)    cutoff=0 ;;
    *)      cutoff=0 ;;
  esac
  jq -s --argjson cutoff "$cutoff" '
    [ .[] | select((.ts | fromdateiso8601) >= $cutoff) | .cost_usd ]
    | (add // 0)
    | (. * 100 | round) / 100
  ' "$LEDGER"
}

check_budget_threshold() {
  [ ! -s "$BUDGET_FILE" ] && return 0
  local cap spent pct
  cap=$(jq -r .cap_usd "$BUDGET_FILE")
  spent=$(period_spend month)
  pct=$(awk -v s="$spent" -v c="$cap" 'BEGIN { if (c>0) printf "%.0f", s/c*100; else print "0" }')
  if [ "$pct" -ge 100 ]; then
    echo "[BUDGET] HARD-STOP: spent \$$spent of \$$cap/mo cap (100%)" >&2
  elif [ "$pct" -ge 90 ]; then
    echo "[BUDGET] CRITICAL: spent \$$spent of \$$cap/mo cap ($pct%)" >&2
  elif [ "$pct" -ge 75 ]; then
    echo "[BUDGET] WARN: spent \$$spent of \$$cap/mo cap ($pct%)" >&2
  elif [ "$pct" -ge 50 ]; then
    echo "[BUDGET] info: spent \$$spent of \$$cap/mo cap ($pct%)"
  fi
}

# Caller-facing: ask whether a planned spawn should proceed under current budget.
# Returns exit 0 if OK, exit 1 if hard-stop, exit 2 if warn (caller decides).
cmd_check_spawn_budget() {
  local proposed=${1:-0}
  [ ! -s "$BUDGET_FILE" ] && return 0
  local cap spent projected pct
  cap=$(jq -r .cap_usd "$BUDGET_FILE")
  spent=$(period_spend month)
  projected=$(awk -v s="$spent" -v p="$proposed" 'BEGIN { printf "%.4f", s+p }')
  pct=$(awk -v s="$projected" -v c="$cap" 'BEGIN { if (c>0) printf "%.0f", s/c*100; else print "0" }')
  if [ "$pct" -ge 100 ]; then
    echo "HARD-STOP: projected \$$projected exceeds \$$cap/mo cap"
    return 1
  fi
  echo "OK: projected \$$projected of \$$cap/mo cap ($pct%)"
  return 0
}

# ─── report ─────────────────────────────────────────────────────────────

cmd_report() {
  local period=${1:-today}
  if [ ! -s "$LEDGER" ]; then
    echo "no entries yet"
    return 0
  fi

  local cutoff label
  case "$period" in
    today)  cutoff=$(date -u -d 'today 00:00:00' +%s); label="today (since 00:00 UTC)" ;;
    week)   cutoff=$(date -u -d '7 days ago' +%s); label="last 7 days" ;;
    month)  cutoff=$(date -u -d '30 days ago' +%s); label="last 30 days" ;;
    all)    cutoff=0; label="all time" ;;
    *)      cutoff=0; label="all time" ;;
  esac

  echo "=== cost report — $label ==="
  jq -s --argjson cutoff "$cutoff" '
    def round2: (. * 100 | round) / 100;
    def sumcost: ([.[].cost_usd] | (add // 0)) | round2;
    [ .[] | select((.ts | fromdateiso8601) >= $cutoff) ] as $rows
    | { count: ($rows | length),
        total_usd: ($rows | sumcost),
        by_runtime:    ($rows | group_by(.runtime)
                         | map({runtime: .[0].runtime, count: length, usd: sumcost})),
        by_spawn_type: ($rows | group_by(.spawn_type)
                         | map({spawn_type: .[0].spawn_type, count: length, usd: sumcost})),
        by_status:     ($rows | group_by(.status)
                         | map({status: .[0].status, count: length, usd: sumcost}))
      }
  ' "$LEDGER"

  echo
  cmd_budget get
}

cmd_estimate() {
  local model=$1 itok=$2 otok=$3
  local cost
  cost=$(cost_from_tokens "$model" "$itok" "$otok")
  echo "estimated cost: \$$cost  (model=$model, input=${itok}t, output=${otok}t)"
}

# ─── dispatch ───────────────────────────────────────────────────────────

case "${1:-}" in
  add)               shift; cmd_add "$@" ;;
  report)            shift; cmd_report "$@" ;;
  budget)            shift; cmd_budget "$@" ;;
  estimate)          shift; cmd_estimate "$@" ;;
  check-spawn)       shift; cmd_check_spawn_budget "$@" ;;
  -h|--help|help|"")
    grep -E "^#" "$0" | head -50
    exit 0 ;;
  *) echo "unknown subcommand: $1" >&2; exit 2 ;;
esac
