#!/bin/bash
# Post-hoc, applied uniformly to every round-2 run.
# run2.sh captured `git diff --cached`, which is empty when the agent committed its work.
# Recompute each solution diff against the frozen base commit so committed and uncommitted
# work are both captured, then refresh files_changed / diff_lines in result.json.
set -uo pipefail
BASE=$(git -C /home/dev/.cache/vw-frozen rev-parse HEAD)
for d in /tmp/explorer-ab/r2-*/; do
    [ -d "$d/repo" ] || continue
    git -C "$d/repo" add -A >/dev/null 2>&1
    git -C "$d/repo" diff "$BASE" > "$d/solution.diff"
    git -C "$d/repo" diff "$BASE" --stat > "$d/solution.stat"
    python3 - "$d" <<'PY'
import json, sys, subprocess, os
d = sys.argv[1]
rj = os.path.join(d, "result.json")
if not os.path.exists(rj):
    sys.exit(0)
diff = open(os.path.join(d, "solution.diff")).read().splitlines()
files = sum(1 for l in diff if l.startswith("+++ ") and not l.startswith("+++ /dev/null"))
lines = sum(1 for l in diff if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---")))
r = json.load(open(rj))
r["files_changed"], r["diff_lines"] = files, lines
json.dump(r, open(rj, "w"), indent=2)
print(os.path.basename(d.rstrip("/")), files, lines)
PY
done
