#!/usr/bin/env bash
# Proves every rule in tools/.dependency-cruiser.cjs actually fires. A rule that
# silently matches nothing (e.g. node_modules excluded instead of doNotFollow'ed
# drops the @earendil-works nodes and disables daemon-closure-no-pi) would keep
# the real cruise green forever. Builds a throwaway repo-shaped tree with one
# violation per rule, cruises it with the real config, and asserts each
# expected (rule, from) violation appears. Run by check.sh; needs the farm.
set -euo pipefail

cd "$(dirname "$0")"
TEST_DIR="$PWD"
TOOLS="$TEST_DIR/tools"
if [[ ! -e "$TEST_DIR/node_modules/@earendil-works/pi-coding-agent" ]]; then
	echo "node_modules farm missing: run ./check.sh (or ./run.sh) first" >&2
	exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/depcruise-selftest.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/pi/extensions/lib" "$tmp/pi/extensions/test"
ln -s "$TEST_DIR/node_modules" "$tmp/pi/extensions/node_modules"

# no-circular — one edge type-only, so this also proves tsPreCompilationDeps.
echo 'import type { B } from "./cycle-b.ts"; export type A = B;' >"$tmp/pi/extensions/lib/cycle-a.ts"
echo 'import "./cycle-a.ts"; export type B = string;' >"$tmp/pi/extensions/lib/cycle-b.ts"
# lib-not-to-toplevel-extension
echo 'export default function () {}' >"$tmp/pi/extensions/ext.ts"
echo 'import ext from "../ext.ts"; export const e = ext;' >"$tmp/pi/extensions/lib/uses-ext.ts"
# daemon-closure-no-pi — two hops away and type-only: proves `reachable`.
echo 'import "./extensions/lib/daemon-dep.ts";' >"$tmp/pi/dashboard-daemon.mjs"
echo 'import "./daemon-dep2.ts";' >"$tmp/pi/extensions/lib/daemon-dep.ts"
echo 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; export type X = ExtensionAPI;' \
	>"$tmp/pi/extensions/lib/daemon-dep2.ts"
# prod-not-to-test
echo 'export const h = 1;' >"$tmp/pi/extensions/test/helper.ts"
echo 'import { h } from "./test/helper.ts"; export const x = h;' >"$tmp/pi/extensions/uses-test.ts"
# not-to-unresolvable
echo 'import "./missing.ts";' >"$tmp/pi/extensions/broken.ts"

# json output exits 0 regardless of violations (only the err reporters set the
# exit code), so the verdict is the violation list parsed below.
(cd "$tmp" && "$TOOLS/node_modules/.bin/depcruise" --config "$TOOLS/.dependency-cruiser.cjs" \
	--output-type json pi/extensions pi/dashboard-daemon.mjs >result.json)

node - "$tmp/result.json" <<'EOF'
const fs = require("node:fs");
const { summary } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = [
	["no-circular", "pi/extensions/lib/cycle-a.ts"],
	["lib-not-to-toplevel-extension", "pi/extensions/lib/uses-ext.ts"],
	["daemon-closure-no-pi", "pi/dashboard-daemon.mjs"],
	["prod-not-to-test", "pi/extensions/uses-test.ts"],
	["not-to-unresolvable", "pi/extensions/broken.ts"],
];
const got = summary.violations.map((v) => `${v.rule.name} ${v.from}`);
const missing = expected.filter(([rule, from]) => !got.includes(`${rule} ${from}`));
for (const [rule, from] of missing) console.error(`rule did not fire: ${rule} (from ${from})`);
// Exactly one violation per fixture: an extra one means a rule matches too broadly.
if (missing.length || got.length !== expected.length) {
	console.error(`violations reported:\n  ${got.join("\n  ")}`);
	process.exit(1);
}
console.log(`all ${expected.length} dependency-cruiser rules fire`);
EOF
