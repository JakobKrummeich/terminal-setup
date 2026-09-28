#!/usr/bin/env bash
# rtk install: pinned version + per-asset SHA-256, verified before extraction.
# No network: curl and uname are stubbed, the release asset is a local fixture.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# ── pinned asset table + URL construction ──────────────────────────
[[ "$RTK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "RTK_VERSION is not a plain x.y.z: $RTK_VERSION"

assert_asset() {
    local os="$1" arch="$2" expected="$3" actual
    actual="$(rtk_asset_name "$os" "$arch")"
    [ "$actual" = "$expected" ] || fail "expected $expected for $os/$arch, got $actual"
    [[ "$(rtk_asset_sha256 "$actual")" =~ ^[0-9a-f]{64}$ ]] || fail "no SHA-256 pinned for $actual"
}
assert_asset Linux x86_64 rtk-x86_64-unknown-linux-musl.tar.gz
assert_asset Linux aarch64 rtk-aarch64-unknown-linux-gnu.tar.gz
assert_asset Darwin x86_64 rtk-x86_64-apple-darwin.tar.gz
assert_asset Darwin arm64 rtk-aarch64-apple-darwin.tar.gz
[ -z "$(rtk_asset_name Linux riscv64)" ] || fail "unsupported platform must map to no asset"
[ -z "$(rtk_asset_sha256 rtk-unknown.tar.gz)" ] || fail "unknown asset must have no hash"

[ "$(rtk_release_url rtk-x86_64-unknown-linux-musl.tar.gz)" = \
    "https://github.com/rtk-ai/rtk/releases/download/v$RTK_VERSION/rtk-x86_64-unknown-linux-musl.tar.gz" ] \
    || fail "release URL is not pinned to v$RTK_VERSION: $(rtk_release_url rtk-x86_64-unknown-linux-musl.tar.gz)"

# ── fixtures ───────────────────────────────────────────────────────
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
RTK_ASSET_URL="https://github.com/rtk-ai/rtk/releases/download/v$RTK_VERSION/rtk-x86_64-unknown-linux-musl.tar.gz"
RTK_ARCHIVE="$FIXTURE/rtk.tar.gz"
mkdir -p "$FIXTURE/archive"
printf '#!/usr/bin/env bash\necho rtk %s\n' "$RTK_VERSION" > "$FIXTURE/archive/rtk"
chmod +x "$FIXTURE/archive/rtk"
touch -d '2020-01-01 UTC' "$FIXTURE/archive/rtk"
tar -czf "$RTK_ARCHIVE" -C "$FIXTURE/archive" rtk
FIXTURE_SHA256="$(sha256sum "$RTK_ARCHIVE" | cut -d' ' -f1)"

CURL_LOG="$FIXTURE/curl.log"
curl() {
    echo "$*" >> "$CURL_LOG"
    if [ "${2-}" = "$RTK_ASSET_URL" ] && [ "${3-}" = "-o" ]; then
        cp "$RTK_ARCHIVE" "$4"
    else
        return 1
    fi
}
uname() {
    case "$1" in
        -s) printf 'Linux\n' ;;
        -m) printf 'x86_64\n' ;;
    esac
}
# The fixture archive stands in for the pinned musl asset.
rtk_asset_sha256() { echo "$FIXTURE_SHA256"; }

run_install() { # <home>
    (
        HOME="$1"
        PATH="/usr/local/bin:/usr/bin:/bin"
        install_rtk
    )
}

assert_not_installed() { # <home> <what>
    [ ! -e "$1/.local/bin/rtk" ] || fail "rtk binary placed after $2"
    [ ! -e "$1/.pi/agent/bin/rtk" ] || fail "rtk link created after $2"
}

# ── checksum match → installed + linked ────────────────────────────
output="$(run_install "$FIXTURE/home")"
[[ "$output" == *"Installing rtk $RTK_VERSION"* ]] || fail "expected pinned-version banner, got: $output"
[[ "$output" == *"INSTALLED: rtk rtk $RTK_VERSION"* ]] || fail "expected RTK installation, got: $output"
[ -x "$FIXTURE/home/.local/bin/rtk" ] || fail "RTK tarball binary was not installed"
[ "$(readlink "$FIXTURE/home/.pi/agent/bin/rtk")" = "$FIXTURE/home/.local/bin/rtk" ] || fail "RTK link points to wrong target"
grep -qF "$RTK_ASSET_URL" "$CURL_LOG" || fail "download did not use the pinned URL: $(cat "$CURL_LOG")"

# ── checksum mismatch → fail closed, nothing extracted or linked ───
rtk_asset_sha256() { printf '0%.0s' {1..64}; echo; }
output="$(run_install "$FIXTURE/mismatch")"
[[ "$output" == *"ERROR: rtk download failed SHA-256 verification"* ]] || fail "expected checksum error, got: $output"
[[ "$output" != *"INSTALLED:"* ]] || fail "RTK reported an installation after checksum mismatch"
assert_not_installed "$FIXTURE/mismatch" "checksum mismatch"

# ── no pinned hash for the asset → fail closed too ─────────────────
rtk_asset_sha256() { :; }
output="$(run_install "$FIXTURE/no-hash")"
[[ "$output" == *"ERROR: rtk download failed SHA-256 verification (expected <none>"* ]] || fail "expected missing-hash error, got: $output"
assert_not_installed "$FIXTURE/no-hash" "missing hash"
rtk_asset_sha256() { echo "$FIXTURE_SHA256"; }

# ── download failure ───────────────────────────────────────────────
real_asset_url="$RTK_ASSET_URL"
RTK_ASSET_URL="https://example.invalid/never-served"
output="$(run_install "$FIXTURE/download-failure")"
RTK_ASSET_URL="$real_asset_url"
[[ "$output" == *"WARN: could not download rtk release asset"* ]] || fail "expected download warning, got: $output"
assert_not_installed "$FIXTURE/download-failure" "download failure"

# ── unsupported platform ───────────────────────────────────────────
uname() {
    case "$1" in
        -s) printf 'Linux\n' ;;
        -m) printf 'riscv64\n' ;;
    esac
}
output="$(run_install "$FIXTURE/unsupported")"
[[ "$output" == *"WARN: no rtk release asset for Linux/riscv64"* ]] || fail "expected unsupported-platform warning, got: $output"
assert_not_installed "$FIXTURE/unsupported" "unsupported platform"
uname() {
    case "$1" in
        -s) printf 'Linux\n' ;;
        -m) printf 'x86_64\n' ;;
    esac
}

# ── idempotent: an rtk already on PATH is linked, never re-downloaded ──
mkdir -p "$FIXTURE/existing/bin"
printf '#!/usr/bin/env bash\necho rtk %s\n' "$RTK_VERSION" > "$FIXTURE/existing/bin/rtk"
chmod +x "$FIXTURE/existing/bin/rtk"
: > "$CURL_LOG"
output="$(
    HOME="$FIXTURE/existing"
    PATH="$FIXTURE/existing/bin:/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
[ ! -s "$CURL_LOG" ] || fail "existing rtk must not trigger a download: $(cat "$CURL_LOG")"
[[ "$output" != *"NOTE:"* ]] || fail "pinned version on PATH must not be reported as drift: $output"
[ "$(readlink "$FIXTURE/existing/.pi/agent/bin/rtk")" = "$FIXTURE/existing/bin/rtk" ] || fail "existing rtk not linked"
printf '#!/usr/bin/env bash\necho rtk 0.0.1\n' > "$FIXTURE/existing/bin/rtk"
output="$(
    HOME="$FIXTURE/existing"
    PATH="$FIXTURE/existing/bin:/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
[[ "$output" == *"NOTE: using existing $FIXTURE/existing/bin/rtk (rtk 0.0.1); pinned is rtk $RTK_VERSION"* ]] \
    || fail "expected version-drift note, got: $output"
[ ! -s "$CURL_LOG" ] || fail "version drift must not trigger a download: $(cat "$CURL_LOG")"

# ── our own ~/.pi/agent/bin/rtk first on PATH: follow the link, don't re-download ──
self="$FIXTURE/self-link"
mkdir -p "$self/.local/bin" "$self/.pi/agent/bin"
printf '#!/usr/bin/env bash\necho rtk 0.0.1\n' > "$self/.local/bin/rtk"
chmod +x "$self/.local/bin/rtk"
ln -s "$self/.local/bin/rtk" "$self/.pi/agent/bin/rtk"
self_target="$(readlink -f "$self/.local/bin/rtk")"
run_self_link() {
    (
        HOME="$self"
        PATH="$self/.pi/agent/bin:/usr/local/bin:/usr/bin:/bin"
        install_rtk
    )
}
: > "$CURL_LOG"
output="$(run_self_link)"
[ ! -s "$CURL_LOG" ] || fail "rtk behind our own link must not trigger a download: $(cat "$CURL_LOG")"
[[ "$output" == *"NOTE: using existing $self_target (rtk 0.0.1); pinned is rtk $RTK_VERSION"* ]] \
    || fail "expected version-drift note via own link, got: $output"
[ "$(cat "$self/.local/bin/rtk")" = "$(printf '#!/usr/bin/env bash\necho rtk 0.0.1')" ] || fail "existing rtk behind own link was replaced"
[ "$(readlink "$self/.pi/agent/bin/rtk")" = "$self_target" ] || fail "own link not pointing at the existing rtk"
output="$(run_self_link)"
[ ! -s "$CURL_LOG" ] || fail "re-run via own link must not download: $(cat "$CURL_LOG")"
[ "$(readlink "$self/.pi/agent/bin/rtk")" = "$self_target" ] || fail "re-run via own link is not idempotent"

# Dangling own link → treated as not installed: pinned release downloaded.
rm "$self/.local/bin/rtk"
output="$(run_self_link)"
[[ "$output" == *"Installing rtk $RTK_VERSION"* ]] || fail "dangling own link must install, got: $output"
[ -x "$self/.local/bin/rtk" ] || fail "dangling own link: rtk not installed"
[ "$(readlink "$self/.pi/agent/bin/rtk")" = "$self/.local/bin/rtk" ] || fail "dangling own link not re-pointed"

# ── placement failures ─────────────────────────────────────────────
mkdir -p "$FIXTURE/destination-collision/.local/bin/rtk"
output="$(run_install "$FIXTURE/destination-collision")"
[[ "$output" == *"WARN: could not place rtk binary"* ]] || fail "expected RTK destination warning, got: $output"
[[ "$output" != *"INSTALLED:"* ]] || fail "RTK reported an installation after destination failure"
[ ! -e "$FIXTURE/destination-collision/.pi/agent/bin/rtk" ] || fail "RTK link was created after destination failure"

mv() { return 1; }
output="$(run_install "$FIXTURE/move-failure")"
unset -f mv
[[ "$output" == *"WARN: could not place rtk binary"* ]] || fail "expected RTK move warning, got: $output"
[[ "$output" != *"INSTALLED:"* ]] || fail "RTK reported an installation after move failure"
assert_not_installed "$FIXTURE/move-failure" "move failure"

chmod() { return 1; }
output="$(run_install "$FIXTURE/chmod-failure")"
unset -f chmod
[[ "$output" == *"WARN: could not mark rtk binary executable"* ]] || fail "expected RTK chmod warning, got: $output"
[[ "$output" != *"INSTALLED:"* ]] || fail "RTK reported an installation after chmod failure"
[ ! -e "$FIXTURE/chmod-failure/.pi/agent/bin/rtk" ] || fail "RTK link was created after chmod failure"

echo "PASS: pinned RTK download, SHA-256 verification and installation"
