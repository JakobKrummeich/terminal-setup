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

out="$(run_with_pi_version 0.86.1)"
[[ "$out" == *"WARNING: pi 0.86.1 is older than the supported minimum"* ]] || fail "0.86.1 must warn, got: $out"

for version in 0.87.0 0.87.1 0.88.0 1.0.0; do
    out="$(run_with_pi_version "$version")"
    [ -z "$out" ] || fail "$version must not warn, got: $out"
done

out="$(run_with_pi_version "not a version")"
[[ "$out" == *"WARNING: could not read pi version"* ]] || fail "unparsable version must warn, got: $out"

printf 'PASS: installer warns about pi older than the supported minimum\n'
