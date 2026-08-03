#!/bin/bash
# Round 2: 6 tasks x 2 arms, strictly sequential, resumable (skips finished runs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for task in r1 r2 r3 r4 r5 r6; do
    for arm in control treatment; do
        id="r2-$task-$arm"
        [ -f "/tmp/explorer-ab/$id/result.json" ] && { echo "skip $id"; continue; }
        "$HERE/run2.sh" "$arm" "$task" "$id" > "/tmp/explorer-ab/$id.log" 2>&1
        echo "done $id $(date +%H:%M)"
    done
done
echo ROUND2-COMPLETE
