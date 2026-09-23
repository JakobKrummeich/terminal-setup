#!/usr/bin/env bash
# Run the extension test suite against the installed pi package.
#
# Node's ESM resolver ignores NODE_PATH, so the bare imports used by the
# extensions ("@earendil-works/pi-coding-agent", "typebox") only resolve if a
# node_modules directory exists next to the tests. It is a symlink farm into the
# globally installed pi, created here and gitignored.
set -euo pipefail

cd "$(dirname "$0")"

PI_COMMAND="$(command -v pi || true)"
if [[ -z "$PI_COMMAND" ]]; then
	echo "pi executable not found on PATH" >&2
	exit 1
fi
PI_BIN="$(readlink -f "$PI_COMMAND")"
search_dir="$(dirname "$PI_BIN")"
PI_ROOT=""
while true; do
	package_json="$search_dir/package.json"
	if [[ -f "$package_json" ]] && node -e '
		const fs = require("node:fs");
		const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		process.exit(pkg.name === "@earendil-works/pi-coding-agent" ? 0 : 1);
	' "$package_json" 2>/dev/null; then
		PI_ROOT="$search_dir"
		break
	fi
	[[ "$search_dir" == / ]] && break
	search_dir="$(dirname "$search_dir")"
done

if [[ -z "$PI_ROOT" ]]; then
	echo "pi package root not found above executable $PI_BIN" >&2
	exit 1
fi
PI_DEPS="$PI_ROOT/node_modules"
for dependency in @earendil-works/pi-ai @earendil-works/pi-tui typebox @types; do
	if [[ ! -e "$PI_DEPS/$dependency" ]]; then
		echo "pi dependency not found at $PI_DEPS/$dependency" >&2
		exit 1
	fi
done

mkdir -p node_modules/@earendil-works
ln -sfn "$PI_ROOT" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_DEPS/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$PI_DEPS/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$PI_DEPS/typebox" node_modules/typebox
ln -sfn "$PI_DEPS/@types" node_modules/@types

# custom-footer.ts still imports the old @mariozechner/* names; pi's jiti loader
# remaps them at runtime, so mirror that remap here (as tsconfig.json does for tsc).
mkdir -p node_modules/@mariozechner
ln -sfn "$PI_ROOT" node_modules/@mariozechner/pi-coding-agent
ln -sfn "$PI_DEPS/@earendil-works/pi-ai" node_modules/@mariozechner/pi-ai
ln -sfn "$PI_DEPS/@earendil-works/pi-tui" node_modules/@mariozechner/pi-tui

# Tests that ESM-import extension files directly (explore.test.ts) need the bare
# imports to resolve from the extensions dir too; the resolver walks up from there.
ln -sfn "$PWD/node_modules" ../node_modules

# No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests and
# hang the test processes. The suite is offline by design (scripted LLM, no API key).
export PI_OFFLINE=1

# transform (not strip): lib/child-session.ts uses TS parameter properties.
exec node --test --experimental-transform-types --no-warnings "$@" ./*.test.ts
