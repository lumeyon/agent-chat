#!/bin/bash
# scripts/board/spawn-record.sh — write a permanent CONVO.md-shape record
# of an ephemeral spawn's conversation (orion → codex/claude → response).
#
# The agent-chat topology rules (record-turn requires the speaker to be a
# user from agents.users.yaml) don't fit ephemeral AI-to-AI dispatches:
# orion is the initiator, codex/claude is the agent, and neither is a
# human user. So we sidestep the protocol's user-validator and write the
# record directly under <conv>/spawns/<slug>-<ts>/CONVO.md.
#
# The format matches a normal CONVO.md so:
#   - The archive layer can seal these the same way as topology edges
#   - Lessons can be crystallized from spawn outputs
#   - FTS / grep find them naturally
#   - Future work can integrate <conv>/spawns/ into a topology if desired
#
# Usage:
#   spawn-record.sh \
#     --slug <kebab-id> \
#     --runtime <codex|claude> \
#     --prompt-file <path> \
#     --response-log <path> \
#     --ref <ref> \
#     --status <ok|fail|verify-fail|incomplete> \
#     [--ts <yyyymmddTHHMMSSZ>]
#
# Idempotent: writes to a deterministic path keyed by slug+ts. Re-running
# overwrites safely (the spawn already happened; the record is a snapshot).

set +e

CONV_DIR=${AGENT_CHAT_CONVERSATIONS_DIR:-/data/lumeyon/agent-chat/conversations}
SLUG=""
RUNTIME=""
PROMPT_FILE=""
RESPONSE_LOG=""
REF=""
STATUS="ok"
TS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)          SLUG=$2; shift 2 ;;
    --runtime)       RUNTIME=$2; shift 2 ;;
    --prompt-file)   PROMPT_FILE=$2; shift 2 ;;
    --response-log)  RESPONSE_LOG=$2; shift 2 ;;
    --ref)           REF=$2; shift 2 ;;
    --status)        STATUS=$2; shift 2 ;;
    --ts)            TS=$2; shift 2 ;;
    -h|--help)
      grep -E "^#" "$0" | head -30
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -z "$SLUG" ]         && { echo "missing --slug" >&2; exit 2; }
[ -z "$RUNTIME" ]      && { echo "missing --runtime" >&2; exit 2; }
[ -z "$PROMPT_FILE" ]  && { echo "missing --prompt-file" >&2; exit 2; }
[ -z "$RESPONSE_LOG" ] && { echo "missing --response-log" >&2; exit 2; }
[ ! -f "$PROMPT_FILE" ]  && { echo "prompt file not found: $PROMPT_FILE" >&2; exit 2; }

# Generate timestamp if not provided. Prefer extracting from the response
# log filename (matches the dispatch-codex.sh pattern: <slug>-<ts>.log).
if [ -z "$TS" ]; then
  base=$(basename "$RESPONSE_LOG" .log)
  TS=$(echo "$base" | grep -oE '[0-9]{8}T[0-9]{6}Z' | head -1)
fi
[ -z "$TS" ] && TS=$(date -u +%Y%m%dT%H%M%SZ)

# ISO-format the timestamp for section headers
ISO_TS=$(date -u -d "$(echo "$TS" | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3T\4:\5:\6Z/')" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
[ -z "$ISO_TS" ] && ISO_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

EDGE_DIR="$CONV_DIR/spawns/${SLUG}-${TS}"
CONVO="$EDGE_DIR/CONVO.md"
mkdir -p "$EDGE_DIR"

# Read prompt + response (size-cap response since codex sessions can be MB)
PROMPT_CONTENT=$(cat "$PROMPT_FILE" 2>/dev/null)
if [ -f "$RESPONSE_LOG" ]; then
  RESPONSE_BYTES=$(wc -c < "$RESPONSE_LOG")
  if [ "$RESPONSE_BYTES" -gt 1048576 ]; then  # 1MB cap
    RESPONSE_CONTENT="$(head -c 524288 "$RESPONSE_LOG")
...
[truncated — full log at $RESPONSE_LOG ($RESPONSE_BYTES bytes)]
...
$(tail -c 524288 "$RESPONSE_LOG")"
  else
    RESPONSE_CONTENT=$(cat "$RESPONSE_LOG")
  fi
else
  RESPONSE_CONTENT="(no response log at $RESPONSE_LOG)"
fi

# Write the CONVO.md
cat > "$CONVO" <<EOF
# CONVO — ephemeral spawn (orion ↔ ${RUNTIME})

Slug: ${SLUG}
Timestamp: ${ISO_TS}
Runtime: ${RUNTIME}
Ref: ${REF}
Status: ${STATUS}
Source-of-record: dispatch-codex.sh / dispatch-claude.sh

Format follows agent-chat CONVO.md so the archive layer + lessons + FTS
all work over these spawn records the same way they do over topology edges.

---

## orion — dispatch (UTC ${ISO_TS})

${PROMPT_CONTENT}

→ ${RUNTIME}

---

## ${RUNTIME} — response (UTC ${ISO_TS})

${RESPONSE_CONTENT}

→ parked
EOF

# Set the .turn sentinel to "parked" since this is a one-shot exchange
echo "parked" > "$EDGE_DIR/CONVO.md.turn"

# Print the resulting path so callers (dispatch-*.sh) can log it
echo "$CONVO"
