#!/usr/bin/env bash
# warn_if_pi_too_old: warns (never fails) when the installed pi is below PI_MIN_VERSION.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

run_with_pi_version() { # <version-output> → warn_if_pi_too_old stdout
    local bin="$FIXTURE/bin-$RANDOM"
    mkdir -p "$bin"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%s"\n' "$1" > "$bin/pi"
    chmod +x "$bin/pi"
    PATH="$bin:$PATH" REPO="$REPO" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      warn_if_pi_too_old
    '
}

fail() { echo "FAIL: $*" >&2; exit 1; }

for version in 0.99.1 1.0.0; do
    out="$(run_with_pi_version "$version")"
    [[ "$out" == *"WARNING: pi $version is older than the supported minimum"* ]] || fail "$version must warn, got: $out"
done

for version in 1.0.1 1.0.4 1.1.0 2.0.0; do
    out="$(run_with_pi_version "$version")"
    [ -z "$out" ] || fail "$version must not warn, got: $out"
done

out="$(run_with_pi_version "not a version")"
[[ "$out" == *"WARNING: could not read pi version"* ]] || fail "unparsable version must warn, got: $out"

# version_lt: pure-bash dotted compare (numeric per component, not lexical).
(
    . "$REPO/lib/install-common.sh"
    for pair in 0.86.1:0.87.0 0.87.0:0.87.1 0.9.9:0.10.0 1.2:1.2.1 0.87.09:0.87.10; do
        version_lt "${pair%%:*}" "${pair#*:}" || fail "$pair: expected ${pair%%:*} < ${pair#*:}"
    done
    for pair in 0.87.0:0.87.0 0.87.1:0.87.0 0.10.0:0.9.9 1.0.0:0.99.99 1.2.0:1.2 x.1:0.1; do
        ! version_lt "${pair%%:*}" "${pair#*:}" || fail "$pair: expected ${pair%%:*} >= ${pair#*:}"
    done
)

# The check must never abort the installer: a failing `sort` (e.g. no -V) is irrelevant.
sort_stub="$FIXTURE/no-sort-v"
mkdir -p "$sort_stub"
printf '#!/bin/sh\necho "sort: invalid option" >&2\nexit 2\n' > "$sort_stub/sort"
chmod +x "$sort_stub/sort"
out="$(PATH="$sort_stub:$PATH" run_with_pi_version 1.0.0)" || fail "warn_if_pi_too_old aborted with a broken sort"
[[ "$out" == *"WARNING: pi 1.0.0 is older than the supported minimum"* ]] || fail "broken sort must still warn, got: $out"

printf 'PASS: installer warns about pi older than the supported minimum\n'
