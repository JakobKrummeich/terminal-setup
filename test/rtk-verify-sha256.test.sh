#!/usr/bin/env bash
# verify_sha256: the integrity gate in front of every rtk extraction. Pins the
# tool fallback the Linux suite never reaches otherwise — shasum (macOS ships no
# sha256sum) and "neither tool" — as fail-closed, with the temp check file removed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
FILE="$FIXTURE/asset.tar.gz"
printf 'pinned rtk asset bytes\n' > "$FILE"
GOOD="$(sha256sum "$FILE" | cut -d' ' -f1)"
BAD="$(printf '0%.0s' {1..64})"

# A PATH holding only the named tools (plus what verify_sha256 itself needs), so
# `command -v` sees exactly the platform being simulated.
tool_path() { # <dir> <tool>... → prints dir
    local dir="$FIXTURE/$1" tool
    shift
    mkdir -p "$dir"
    for tool in mktemp rm "$@"; do
        ln -sf "$(command -v "$tool")" "$dir/$tool"
    done
    printf '%s' "$dir"
}

# Runs verify_sha256 under <path> with a private TMPDIR; prints "<status>|<output>".
# Fails the test if the check file was left behind in TMPDIR.
verify_under() { # <path> <expected-sha256>
    local tmp status=0 output
    tmp="$(mktemp -d "$FIXTURE/tmp.XXXXXX")"
    output="$(PATH="$1" TMPDIR="$tmp" verify_sha256 "$FILE" "$2" 2>&1)" || status=$?
    [ -z "$(ls -A "$tmp")" ] || fail "check file left behind under PATH=$1: $(ls -A "$tmp")"
    printf '%s|%s' "$status" "$output"
}

expect_pass() { # <label> <path> <sha>
    local result
    result="$(verify_under "$2" "$3")"
    [ "${result%%|*}" = 0 ] || fail "$1: expected a match, got status/output: $result"
}

expect_reject() { # <label> <path> <sha>
    local result
    result="$(verify_under "$2" "$3")"
    [ "${result%%|*}" != 0 ] || fail "$1: expected rejection, got status/output: $result"
}

# ── sha256sum (Linux) ──────────────────────────────────────────────
linux="$(tool_path linux sha256sum)"
expect_pass "sha256sum match" "$linux" "$GOOD"
expect_reject "sha256sum mismatch" "$linux" "$BAD"
expect_reject "empty expected hash" "$linux" ""

# ── shasum only (macOS) ────────────────────────────────────────────
if command -v shasum >/dev/null; then
    macos="$(tool_path macos shasum)"
    expect_pass "shasum match" "$macos" "$GOOD"
    expect_reject "shasum mismatch" "$macos" "$BAD"
else
    echo "SKIP: shasum not installed; macOS fallback branch not exercised"
fi

# ── neither tool → fail closed, never "verified" ───────────────────
none="$(tool_path none)"
result="$(verify_under "$none" "$GOOD")"
[ "${result%%|*}" != 0 ] || fail "no hash tool must reject even a correct hash, got: $result"
[[ "$result" == *"WARN: neither sha256sum nor shasum found; cannot verify rtk download"* ]] \
    || fail "no hash tool must say why, got: $result"

printf 'PASS: verify_sha256 matches/rejects via sha256sum and shasum, fails closed without either\n'
