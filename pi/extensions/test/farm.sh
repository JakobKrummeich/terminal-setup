# Sourced by run.sh and check.sh (not executable on its own): builds the
# node_modules symlink farm into the globally installed pi.
#
# Node's ESM resolver ignores NODE_PATH, so the bare imports used by the
# extensions ("@earendil-works/pi-coding-agent", "typebox") only resolve if a
# node_modules directory exists next to the tests. tsc and dependency-cruiser
# resolve through the same farm. Gitignored.
# shellcheck shell=bash

# Usage: build_pi_farm   (cwd must be pi/extensions/test)
build_pi_farm() {
	local pi_command pi_bin search_dir package_json pi_root="" pi_deps dependency
	pi_command="$(command -v pi || true)"
	if [[ -z "$pi_command" ]]; then
		echo "pi executable not found on PATH" >&2
		return 1
	fi
	pi_bin="$(readlink -f "$pi_command")"
	search_dir="$(dirname "$pi_bin")"
	while true; do
		package_json="$search_dir/package.json"
		if [[ -f "$package_json" ]] && node -e '
			const fs = require("node:fs");
			const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			process.exit(pkg.name === "@earendil-works/pi-coding-agent" ? 0 : 1);
		' "$package_json" 2>/dev/null; then
			pi_root="$search_dir"
			break
		fi
		[[ "$search_dir" == / ]] && break
		search_dir="$(dirname "$search_dir")"
	done

	if [[ -z "$pi_root" ]]; then
		echo "pi package root not found above executable $pi_bin" >&2
		return 1
	fi
	pi_deps="$pi_root/node_modules"
	for dependency in @earendil-works/pi-ai @earendil-works/pi-tui typebox @types; do
		if [[ ! -e "$pi_deps/$dependency" ]]; then
			echo "pi dependency not found at $pi_deps/$dependency" >&2
			return 1
		fi
	done

	mkdir -p node_modules/@earendil-works
	ln -sfn "$pi_root" node_modules/@earendil-works/pi-coding-agent
	ln -sfn "$pi_deps/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
	ln -sfn "$pi_deps/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
	ln -sfn "$pi_deps/typebox" node_modules/typebox
	ln -sfn "$pi_deps/@types" node_modules/@types

	# Tests that ESM-import extension files directly (explore.test.ts) need the bare
	# imports to resolve from the extensions dir too; the resolver walks up from there.
	ln -sfn "$PWD/node_modules" ../node_modules
}
