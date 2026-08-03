#!/bin/bash
# Build per-arm pi config dirs for round 3. The control dir is the live config minus explorer.ts;
# the treatment dir is the live config. Needed because subagents re-discover extensions from the
# config dir and therefore ignore the parent's --exclude-tools / -e flags.
set -euo pipefail
for arm in control treatment; do
    D=/tmp/explorer-ab/agentdir-$arm
    rm -rf "$D"; mkdir -p "$D/extensions"
    for f in "$HOME"/.pi/agent/*; do
        b=$(basename "$f"); [ "$b" = extensions ] && continue
        cp -a "$f" "$D/$b"
    done
    for ext in "$HOME"/.pi/agent/extensions/*.ts; do
        b=$(basename "$ext")
        [ "$arm" = control ] && [ "$b" = explorer.ts ] && continue
        ln -s "$(readlink -f "$ext")" "$D/extensions/$b"
    done
    cp -a "$HOME"/.pi/agent/extensions/lib "$D/extensions/" 2>/dev/null || true
done
