#!/bin/bash
# Main experiment: paired runs, one control + one treatment per task, strictly sequential.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for task in t1 t2 t3; do
    for arm in control treatment; do
        id="main-$task-$arm"
        [ -f "/tmp/explorer-ab/$id/result.json" ] && { echo "skip $id"; continue; }
        "$HERE/run.sh" "$arm" "$task" "$id" > "/tmp/explorer-ab/$id.log" 2>&1
        echo "done $id"
    done
done
echo ALL-RUNS-COMPLETE
