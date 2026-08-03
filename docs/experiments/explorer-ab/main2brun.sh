#!/bin/bash
# Round 2b: does the repeated-use description help on the SMALL round-2 tasks too, or was the
# round-3 gain just the bigger tasks? Treatment arm only — round-2 controls are reusable
# (they never had Explorer, and spawned no subagents, so the description cannot affect them).
# Waits for round 3 to finish first, so wall-clock stays comparable (never two runs at once).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
while [ ! -f /tmp/explorer-ab/r3-s4-treatment/result.json ]; do sleep 60; done
sleep 30
for task in r1 r2 r3 r4 r5 r6; do
    id="r2b-$task-treatment"
    [ -f "/tmp/explorer-ab/$id/result.json" ] && { echo "skip $id"; continue; }
    "$HERE/run2b.sh" treatment "$task" "$id" > "/tmp/explorer-ab/$id.log" 2>&1
    echo "done $id $(date +%H:%M)"
done
echo ROUND2B-COMPLETE
