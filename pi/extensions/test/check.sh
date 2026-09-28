#!/usr/bin/env bash
# Deterministic local quality gate (manual / agents; no CI, no git hook).
# Complements ./run.sh (tests); run both. Steps, first failure stops the gate:
#   typecheck → eslint → dependency-cruiser (+ rule self-test) → jscpd → shellcheck
#   → lua syntax
# Tools are pinned in tools/package.json + package-lock.json and installed into
# the gitignored tools/node_modules on first run or when the lockfile changes
# (the only step needing network). Everything is invoked by explicit path —
# a stub `tsc` on PATH shadows the real compiler (AGENTS.md).
set -euo pipefail

cd "$(dirname "$0")"
TEST_DIR="$PWD"
TOOLS="$TEST_DIR/tools"
BIN="$TOOLS/node_modules/.bin"
REPO="$(cd ../../.. && pwd)"
# WHY pinned here: the shellcheck npm wrapper downloads "latest" unless told otherwise.
SHELLCHECK_RELEASE="v0.11.0"
SHELLCHECK="$TOOLS/node_modules/shellcheck/bin/shellcheck"

ensure_tools() {
	local stamp="$TOOLS/node_modules/.check-stamp" want
	want="$(sha256sum "$TOOLS/package-lock.json" | cut -d' ' -f1) shellcheck=$SHELLCHECK_RELEASE"
	if [[ -f "$stamp" && "$(<"$stamp")" == "$want" ]]; then return 0; fi
	echo "== installing pinned tools into $TOOLS/node_modules (npm ci)"
	(cd "$TOOLS" && npm ci --no-audit --no-fund --loglevel=error) ||
		{ echo "tool install failed — first run needs network (registry.npmjs.org)" >&2; return 1; }
	# The wrapper fetches the binary from GitHub releases on first call.
	SHELLCHECKJS_RELEASE="$SHELLCHECK_RELEASE" "$BIN/shellcheck" --version >/dev/null ||
		{ echo "shellcheck download failed — first run needs network (github.com releases)" >&2; return 1; }
	if ! "$SHELLCHECK" --version | grep -qx "version: ${SHELLCHECK_RELEASE#v}"; then
		echo "shellcheck binary is not $SHELLCHECK_RELEASE" >&2
		return 1
	fi
	printf '%s' "$want" >"$stamp"
}

step_count=0
run_step() {
	local name="$1"
	shift
	step_count=$((step_count + 1))
	echo "== [$step_count] $name"
	if ! "$@"; then
		echo "FAIL: $name" >&2
		exit 1
	fi
}

typecheck() { "$BIN/tsc" -p "$TEST_DIR"; }

eslint_gate() {
	(cd "$REPO" && "$BIN/eslint" -c "$TOOLS/eslint.config.mjs" \
		--suppressions-location "$TOOLS/eslint-suppressions.json" --max-warnings 0 \
		'pi/extensions/**/*.ts' 'pi/extensions/lib/dashboard-ui/*.js' pi/dashboard-daemon.mjs)
}

depcruise_gate() {
	(cd "$REPO" && "$BIN/depcruise" --config "$TOOLS/.dependency-cruiser.cjs" \
		pi/extensions pi/dashboard-daemon.mjs)
}

depcruise_selftest() { "$TEST_DIR/depcruise-selftest.sh"; }

jscpd_gate() {
	(cd "$REPO" && "$BIN/jscpd" --config "$TOOLS/.jscpd.json" --silent \
		pi/extensions pi/dashboard-daemon.mjs install-pi.sh install-terminal.sh lib shell tmux)
}

shellcheck_gate() {
	# -x + repo-root cwd: `# shellcheck source=<repo-relative path>` directives resolve.
	(cd "$REPO" && "$SHELLCHECK" -x install-*.sh lib/install-common.sh shell/*.sh tmux/*.sh \
		test/*.test.sh pi/extensions/test/*.sh)
}

# WHY: wezterm/*.lua are live (symlinked, auto-reloaded) — a syntax error breaks the terminal at once.
lua_syntax_gate() { (cd "$REPO" && node "$TOOLS/lua-syntax.mjs" wezterm/*.lua); }

ensure_tools
# shellcheck source=pi/extensions/test/farm.sh
source ./farm.sh
build_pi_farm

run_step "typecheck (tsc $("$BIN/tsc" --version | cut -d' ' -f2))" typecheck
run_step "eslint" eslint_gate
run_step "dependency-cruiser" depcruise_gate
run_step "dependency-cruiser rule self-test" depcruise_selftest
run_step "jscpd" jscpd_gate
run_step "shellcheck" shellcheck_gate
run_step "lua syntax (luaparse)" lua_syntax_gate
echo "== check.sh: all $step_count steps passed"
