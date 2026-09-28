#!/usr/bin/env bash
# Run the extension test suite against the installed pi package (the
# node_modules symlink farm into it is built by farm.sh).
set -euo pipefail

cd "$(dirname "$0")"

# shellcheck source=pi/extensions/test/farm.sh
source ./farm.sh
build_pi_farm

# No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests and
# hang the test processes. The suite is offline by design (scripted LLM, no API key).
export PI_OFFLINE=1

# Hermetic agent dir: nothing under test may read the user's live ~/.pi/agent
# (settings.json feeds context-cap's reserve) or write into it (context-cap
# handoff files, agent-runs log). Test files that need their own dir still set
# PI_CODING_AGENT_DIR themselves; this is the default for the rest. No `exec`
# below, so the EXIT trap can remove the dir. node runs in the background +
# `wait` so a signal sent to bash alone (not the process group) is forwarded to
# node at once instead of waiting for the whole suite to finish.
PI_CODING_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-ext-test-agentdir.XXXXXX")"
export PI_CODING_AGENT_DIR
trap 'rm -rf "$PI_CODING_AGENT_DIR"' EXIT

# Plain type stripping (flag is a no-op default on node >= 22.18, needed on 22.6-22.17);
# tsconfig's erasableSyntaxOnly keeps the sources strippable.
node --test --experimental-strip-types --no-warnings "$@" ./*.test.ts &
node_pid=$!
trap 'kill -INT "$node_pid" 2>/dev/null; wait "$node_pid" || true; exit 130' INT
trap 'kill -TERM "$node_pid" 2>/dev/null; wait "$node_pid" || true; exit 143' TERM
wait "$node_pid"
