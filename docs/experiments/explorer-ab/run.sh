#!/bin/bash
# One experiment run: isolated clone + isolated session dir, timed, then measured.
# Usage: run.sh <arm: control|treatment> <task: t1|t2|t3> <run-id>
# The subject repo is NEVER modified: work happens in a throwaway clone.
set -euo pipefail

ARM="$1"
TASK="$2"
RUN_ID="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUBJECT=/home/dev/lightspeed
ROOT=/tmp/explorer-ab
RUN_DIR="$ROOT/$RUN_ID"

# Guard: subject repo must be untouched before we start.
if [ -n "$(git -C "$SUBJECT" status --short)" ]; then
    echo "ABORT: subject repo $SUBJECT is dirty:" >&2; git -C "$SUBJECT" status --short >&2
    exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/sessions"
git clone -q "$SUBJECT" "$RUN_DIR/repo"
ln -s "$SUBJECT/node_modules" "$RUN_DIR/repo/node_modules"
echo "node_modules" >> "$RUN_DIR/repo/.git/info/exclude"

PROMPT="$(cat "$HERE/tasks/$TASK.md")"
FLAGS=(--model anthropic/claude-opus-5 -p)
[ "$ARM" = "control" ] && FLAGS+=(--exclude-tools Explorer)

export PI_CODING_AGENT_SESSION_DIR="$RUN_DIR/sessions"

START=$(date +%s.%N)
set +e
(cd "$RUN_DIR/repo" && timeout 3600 pi "${FLAGS[@]}" "$PROMPT") > "$RUN_DIR/stdout.txt" 2>&1
PI_EXIT=$?
set -e
END=$(date +%s.%N)

# Post-run measurements.
git -C "$RUN_DIR/repo" add -A
git -C "$RUN_DIR/repo" diff --cached > "$RUN_DIR/solution.diff"
git -C "$RUN_DIR/repo" diff --cached --stat > "$RUN_DIR/solution.stat"

set +e
(cd "$RUN_DIR/repo" && timeout 900 npm test) > "$RUN_DIR/test.txt" 2>&1
TEST_EXIT=$?
set -e

# Guard: subject repo must still be untouched.
if [ -n "$(git -C "$SUBJECT" status --short)" ]; then
    echo "WARNING: subject repo $SUBJECT became dirty during run $RUN_ID" >&2
fi

python3 "$HERE/measure.py" \
    --run-dir "$RUN_DIR" --arm "$ARM" --task "$TASK" --run-id "$RUN_ID" \
    --wall "$(echo "$END - $START" | bc)" --pi-exit "$PI_EXIT" --test-exit "$TEST_EXIT" \
    > "$RUN_DIR/result.json"

cat "$RUN_DIR/result.json"
