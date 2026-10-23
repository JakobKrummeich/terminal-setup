# Sourced by run.sh and check.sh (not executable on its own): builds the
# node_modules symlink farm into the pi found on PATH — a pi.dev managed install
# (~/.pi/agent/bin/pi launcher script) or a global npm install (pi symlink to
# the package's dist/bundle/cli.js, also how AGENTS.md's fake install works).
#
# Node's ESM resolver ignores NODE_PATH, so the bare imports used by the
# extensions ("@earendil-works/pi-coding-agent", "typebox") only resolve if a
# node_modules directory exists next to the tests. tsc and dependency-cruiser
# resolve through the same farm. Gitignored.
# shellcheck shell=bash

# Usage: pi_entry_point <pi-on-PATH> → the real pi JS entry point.
# A managed install's launcher is a shell script in <agent>/bin that execs
# <agent>/install/releases/<current-version>/node_modules/.bin/pi, so its own
# path leads to no package.json; follow it to the release the launcher runs.
pi_entry_point() {
	local pi_bin agent_dir version release_bin
	pi_bin="$(readlink -f "$1")"
	agent_dir="$(dirname "$(dirname "$pi_bin")")"
	if [[ -f "$agent_dir/install/managed-install.json" ]] \
		&& IFS= read -r version < "$agent_dir/install/current-version"; then
		release_bin="$agent_dir/install/releases/$version/node_modules/.bin/pi"
		if [[ ! -e "$release_bin" ]]; then
			echo "pi release $version not found: $release_bin" >&2
			return 1
		fi
		pi_bin="$(readlink -f "$release_bin")"
	fi
	echo "$pi_bin"
}

# Usage: pi_dependency <pi-root> <name> → path of a pi dependency, resolved the
# way Node does: nested in pi's own node_modules (npm -g), else hoisted into the
# node_modules that holds pi itself (managed install). Empty if neither exists.
pi_dependency() {
	local pi_root="$1" name="$2" hoisted
	hoisted="$(dirname "$(dirname "$pi_root")")"
	if [[ -e "$pi_root/node_modules/$name" ]]; then
		echo "$pi_root/node_modules/$name"
	elif [[ "$(basename "$hoisted")" == node_modules && -e "$hoisted/$name" ]]; then
		echo "$hoisted/$name"
	fi
}

# Usage: build_pi_farm   (cwd must be pi/extensions/test)
build_pi_farm() {
	local pi_command pi_bin search_dir package_json pi_root="" dependency
	local -A dep_path
	pi_command="$(command -v pi || true)"
	if [[ -z "$pi_command" ]]; then
		echo "pi executable not found on PATH" >&2
		return 1
	fi
	pi_bin="$(pi_entry_point "$pi_command")" || return 1
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
	for dependency in @earendil-works/pi-ai @earendil-works/pi-tui typebox @types; do
		dep_path[$dependency]="$(pi_dependency "$pi_root" "$dependency")"
		if [[ -z "${dep_path[$dependency]}" ]]; then
			echo "pi dependency $dependency not found for $pi_root" >&2
			return 1
		fi
	done

	mkdir -p node_modules/@earendil-works
	ln -sfn "$pi_root" node_modules/@earendil-works/pi-coding-agent
	for dependency in "${!dep_path[@]}"; do
		ln -sfn "${dep_path[$dependency]}" "node_modules/$dependency"
	done

	# Tests that ESM-import extension files directly (explore.test.ts) need the bare
	# imports to resolve from the extensions dir too; the resolver walks up from there.
	ln -sfn "$PWD/node_modules" ../node_modules
}
