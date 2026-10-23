#!/usr/bin/env bash
# farm.sh builds the test node_modules farm from the pi on PATH. Two install
# layouts must both resolve, without network or a real pi:
#   managed (pi.dev installer): <agent>/bin/pi is a launcher SCRIPT; the package
#     lives in <agent>/install/releases/<current-version>/node_modules with its
#     deps hoisted beside it.
#   npm -g (and AGENTS.md's fake install): pi is a symlink to the package's
#     dist/bundle/cli.js; deps nested in the package's own node_modules.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=pi/extensions/test/farm.sh
source "$REPO/pi/extensions/test/farm.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DEPS=(@earendil-works/pi-ai @earendil-works/pi-tui typebox @types)

make_package() { # <dir>: a pi-coding-agent package with a cli.js entry point
	mkdir -p "$1/dist/bundle"
	echo '{"name":"@earendil-works/pi-coding-agent"}' > "$1/package.json"
	printf '#!/usr/bin/env node\n' > "$1/dist/bundle/cli.js"
	chmod +x "$1/dist/bundle/cli.js"
}

# Usage: farm_from <bin-dir> <expected-pi-root> <expected-deps-dir>
farm_from() {
	local work="$TMP/work-$RANDOM" dep
	mkdir -p "$work/test"
	(cd "$work/test" && PATH="$1:$PATH" build_pi_farm) || fail "build_pi_farm failed for $1"
	[ "$(readlink "$work/test/node_modules/@earendil-works/pi-coding-agent")" = "$2" ] \
		|| fail "pi-coding-agent not linked to $2"
	for dep in "${DEPS[@]}"; do
		[ "$(readlink "$work/test/node_modules/$dep")" = "$3/$dep" ] || fail "$dep not linked to $3/$dep"
	done
	[ "$(readlink "$work/node_modules")" = "$work/test/node_modules" ] || fail "../node_modules not linked"
}

# ── managed: launcher script, hoisted deps ─────────────────────────
AGENT="$TMP/managed/.pi/agent"
RELEASE="$AGENT/install/releases/1.4.0/node_modules"
make_package "$RELEASE/@earendil-works/pi-coding-agent"
for dep in "${DEPS[@]}"; do mkdir -p "$RELEASE/$dep"; done
mkdir -p "$RELEASE/.bin" "$AGENT/bin"
ln -s ../@earendil-works/pi-coding-agent/dist/bundle/cli.js "$RELEASE/.bin/pi"
echo '{"kind":"pi-managed-install"}' > "$AGENT/install/managed-install.json"
echo 1.4.0 > "$AGENT/install/current-version"
printf '#!/bin/sh\nexec "%s/.bin/pi" "$@"\n' "$RELEASE" > "$AGENT/bin/pi"
chmod +x "$AGENT/bin/pi"
farm_from "$AGENT/bin" "$RELEASE/@earendil-works/pi-coding-agent" "$RELEASE"

# A launcher reached through a symlink (installer's ~/.local/bin entrypoint).
mkdir -p "$TMP/managed/.local/bin"
ln -s "$AGENT/bin/pi" "$TMP/managed/.local/bin/pi"
farm_from "$TMP/managed/.local/bin" "$RELEASE/@earendil-works/pi-coding-agent" "$RELEASE"

# ── npm -g: symlink to cli.js, nested deps ─────────────────────────
GLOBAL="$TMP/global/node_modules/@earendil-works/pi-coding-agent"
make_package "$GLOBAL"
for dep in "${DEPS[@]}"; do mkdir -p "$GLOBAL/node_modules/$dep"; done
mkdir -p "$TMP/global/bin"
ln -s "$GLOBAL/dist/bundle/cli.js" "$TMP/global/bin/pi"
farm_from "$TMP/global/bin" "$GLOBAL" "$GLOBAL/node_modules"

# ── a missing dependency fails closed ──────────────────────────────
rm -rf "$RELEASE/typebox"
mkdir -p "$TMP/miss/test"
if (cd "$TMP/miss/test" && PATH="$AGENT/bin:$PATH" build_pi_farm 2>/dev/null); then
	fail "a missing typebox must fail the farm"
fi

echo "PASS: farm.sh resolves managed and npm -g pi layouts"
