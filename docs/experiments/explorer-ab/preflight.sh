#!/bin/bash
# Preflight: treatment arm only, one run per task. Question 1 only: is Explorer used?
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ITER="${1:-1}"
for task in t1 t2 t3; do
    "$HERE/run.sh" treatment "$task" "preflight${ITER}-$task" > "/tmp/explorer-ab/preflight${ITER}-$task.log" 2>&1
    echo "done $task"
done
