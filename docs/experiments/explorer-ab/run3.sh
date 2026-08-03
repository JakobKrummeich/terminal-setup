#!/bin/bash
# Round 3 run: repeated-use Explorer description, large vertical-slice tasks.
# Usage: run3.sh <arm: control|treatment> <task: s1..s4> <run-id>
# Subject is a FROZEN clone (the live repo is edited by another agent and must never be touched).
set -euo pipefail

ARM="$1"
TASK="$2"
RUN_ID="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUBJECT=/home/dev/.cache/vw-frozen
LIVE=/home/dev/ValuesWorkshop
ROOT=/tmp/explorer-ab
RUN_DIR="$ROOT/$RUN_ID"

if [ -n "$(git -C "$SUBJECT" status --short)" ]; then
    echo "ABORT: frozen subject $SUBJECT is dirty:" >&2
    git -C "$SUBJECT" status --short >&2
    exit 1
fi
LIVE_HEAD_BEFORE="$(git -C "$LIVE" rev-parse HEAD)"

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/sessions"
git clone -q "$SUBJECT" "$RUN_DIR/repo"
ln -s "$LIVE/frontend/node_modules" "$RUN_DIR/repo/frontend/node_modules"
ln -s "$LIVE/node_modules" "$RUN_DIR/repo/node_modules"
printf 'node_modules\nfrontend/node_modules\n' >> "$RUN_DIR/repo/.git/info/exclude"

PROMPT="$(cat "$HERE/tasks3/$TASK.md")"
FLAGS=(--model anthropic/claude-opus-5 -p)
[ "$ARM" = "control" ] && FLAGS+=(--exclude-tools Explorer)

export PI_CODING_AGENT_SESSION_DIR="$RUN_DIR/sessions"

START=$(date +%s.%N)
set +e
(cd "$RUN_DIR/repo" && timeout 9000 pi "${FLAGS[@]}" "$PROMPT") > "$RUN_DIR/stdout.txt" 2>&1
PI_EXIT=$?
set -e
END=$(date +%s.%N)

BASE="$(git -C "$SUBJECT" rev-parse HEAD)"
git -C "$RUN_DIR/repo" add -A
git -C "$RUN_DIR/repo" diff "$BASE" > "$RUN_DIR/solution.diff"
git -C "$RUN_DIR/repo" diff "$BASE" --stat > "$RUN_DIR/solution.stat"

set +e
(cd "$RUN_DIR/repo/backend" && timeout 1800 dotnet test ValuesWorkshop.All.sln --nologo) > "$RUN_DIR/test-backend.txt" 2>&1
BACKEND_EXIT=$?
(cd "$RUN_DIR/repo/frontend" && timeout 1200 pnpm --config.verify-deps-before-run=false test) > "$RUN_DIR/test-frontend.txt" 2>&1
FRONTEND_EXIT=$?
(cd "$RUN_DIR/repo/frontend" && timeout 900 pnpm --config.verify-deps-before-run=false typecheck) > "$RUN_DIR/typecheck.txt" 2>&1
TYPECHECK_EXIT=$?
set -e

if [ "$(git -C "$LIVE" rev-parse HEAD)" != "$LIVE_HEAD_BEFORE" ]; then
    echo "NOTE: live repo HEAD moved during run (expected, it is not the subject)" >&2
fi

python3 "$HERE/measure2.py" \
    --run-dir "$RUN_DIR" --arm "$ARM" --task "$TASK" --run-id "$RUN_ID" \
    --wall "$(echo "$END - $START" | bc)" --pi-exit "$PI_EXIT" \
    --backend-exit "$BACKEND_EXIT" --frontend-exit "$FRONTEND_EXIT" --typecheck-exit "$TYPECHECK_EXIT" \
    > "$RUN_DIR/result.json"

python3 -c "import json;d=json.load(open('$RUN_DIR/result.json'));print({k:d[k] for k in ('run_id','arm','cost_usd','wall_s','parent_peak_context','explorer_calls_parent','explorer_calls_subagent','subagents','backend_pass','frontend_pass')})"
