#!/bin/bash
# Round 3: 4 large tasks x 2 arms, strictly sequential, resumable (skips finished runs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for task in s1 s2 s3 s4; do
    for arm in control treatment; do
        id="r3-$task-$arm"
        [ -f "/tmp/explorer-ab/$id/result.json" ] && { echo "skip $id"; continue; }
        "$HERE/run3.sh" "$arm" "$task" "$id" > "/tmp/explorer-ab/$id.log" 2>&1
        echo "done $id $(date +%H:%M)"
    done
done
echo ROUND3-COMPLETE
