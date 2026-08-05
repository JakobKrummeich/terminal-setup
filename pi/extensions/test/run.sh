#!/usr/bin/env bash
# Run the extension test suite against the installed pi package.
#
# Node's ESM resolver ignores NODE_PATH, so the bare imports used by the
# extensions ("@earendil-works/pi-coding-agent", "typebox") only resolve if a
# node_modules directory exists next to the tests. It is a symlink farm into the
# globally installed pi, created here and gitignored.
set -euo pipefail

cd "$(dirname "$0")"

PI_ROOT="$(dirname "$(readlink -f "$(command -v pi)")")/.."
PI_ROOT="$(readlink -f "$PI_ROOT")"
PI_DEPS="$PI_ROOT/node_modules"

if [[ ! -d "$PI_DEPS" ]]; then
	echo "pi dependencies not found at $PI_DEPS" >&2
	exit 1
fi

mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_DEPS/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$PI_DEPS/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$PI_DEPS/typebox" node_modules/typebox
ln -sfn "$PI_DEPS/@types" node_modules/@types

exec node --test --experimental-strip-types --no-warnings "$@" ./*.test.ts
