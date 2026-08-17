#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

RTK_RELEASE_JSON='{
  "assets": [
    {"name":"rtk_0.45.0-1_amd64.deb","browser_download_url":"https://example.invalid/rtk.deb"},
    {"name":"rtk-x86_64-unknown-linux-gnu.tar.gz","browser_download_url":"https://example.invalid/rtk-x86_64-unknown-linux-gnu.tar.gz"},
    {"name":"rtk-aarch64-unknown-linux-gnu.tar.gz","browser_download_url":"https://example.invalid/rtk-aarch64-unknown-linux-gnu.tar.gz"},
    {"name":"rtk-x86_64-apple-darwin.tar.gz","browser_download_url":"https://example.invalid/rtk-x86_64-apple-darwin.tar.gz"},
    {"name":"rtk-aarch64-apple-darwin.tar.gz","browser_download_url":"https://example.invalid/rtk-aarch64-apple-darwin.tar.gz"},
    {"name":"rtk-x86_64-unknown-linux-musl.tar.gz","browser_download_url":"https://example.invalid/rtk-x86_64-unknown-linux-musl.tar.gz"}
  ]
}'

curl() {
    printf '%s' "$RTK_RELEASE_JSON"
}

assert_url() {
    local os="$1" arch="$2" expected="$3" actual
    actual="$(resolve_rtk_release_url "$os" "$arch")"
    [ "$actual" = "$expected" ] || {
        echo "expected $expected for $os/$arch, got $actual" >&2
        exit 1
    }
}

assert_url Linux x86_64 https://example.invalid/rtk-x86_64-unknown-linux-musl.tar.gz
assert_url Linux aarch64 https://example.invalid/rtk-aarch64-unknown-linux-gnu.tar.gz
assert_url Darwin x86_64 https://example.invalid/rtk-x86_64-apple-darwin.tar.gz
assert_url Darwin arm64 https://example.invalid/rtk-aarch64-apple-darwin.tar.gz
[ -z "$(resolve_rtk_release_url Linux riscv64)" ] || exit 1

curl() { return 22; }
if resolve_rtk_release_url Linux x86_64 >/dev/null; then
    echo "expected failed release request" >&2
    exit 1
fi

FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
output="$(
    HOME="$FIXTURE"
    PATH="/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
[[ "$output" == *"WARN: could not fetch or parse rtk release metadata"* ]] || {
    echo "expected metadata warning, got: $output" >&2
    exit 1
}
[ ! -e "$FIXTURE/.local/bin/rtk" ] || {
    echo "RTK was installed after metadata request failed" >&2
    exit 1
}

RTK_ASSET_URL="https://example.invalid/rtk-x86_64-unknown-linux-musl.tar.gz"
RTK_ARCHIVE="$FIXTURE/rtk.tar.gz"
mkdir -p "$FIXTURE/archive"
printf '#!/usr/bin/env bash\necho rtk 0.45.0\n' > "$FIXTURE/archive/rtk"
chmod +x "$FIXTURE/archive/rtk"
touch -d '2020-01-01 UTC' "$FIXTURE/archive/rtk"
tar -czf "$RTK_ARCHIVE" -C "$FIXTURE/archive" rtk
curl() {
    if [ "${2-}" = "https://api.github.com/repos/rtk-ai/rtk/releases/latest" ]; then
        printf '%s' "$RTK_RELEASE_JSON"
    elif [ "${2-}" = "$RTK_ASSET_URL" ] && [ "${3-}" = "-o" ]; then
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
output="$(
    HOME="$FIXTURE/home"
    PATH="/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
[[ "$output" == *"INSTALLED: rtk rtk 0.45.0"* ]] || {
    echo "expected RTK installation, got: $output" >&2
    exit 1
}
[ -x "$FIXTURE/home/.local/bin/rtk" ] || {
    echo "RTK tarball binary was not installed" >&2
    exit 1
}
[ "$(readlink "$FIXTURE/home/.pi/agent/bin/rtk")" = "$FIXTURE/home/.local/bin/rtk" ] || {
    echo "RTK link points to wrong target" >&2
    exit 1
}

mkdir -p "$FIXTURE/destination-collision/.local/bin/rtk"
output="$(
    HOME="$FIXTURE/destination-collision"
    PATH="/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
[[ "$output" == *"WARN: could not place rtk binary"* ]] || {
    echo "expected RTK destination warning, got: $output" >&2
    exit 1
}
[[ "$output" != *"INSTALLED:"* ]] || {
    echo "RTK reported an installation after destination failure" >&2
    exit 1
}
[ ! -e "$FIXTURE/destination-collision/.pi/agent/bin/rtk" ] || {
    echo "RTK link was created after destination failure" >&2
    exit 1
}

mv() { return 1; }
output="$(
    HOME="$FIXTURE/move-failure"
    PATH="/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
unset -f mv
[[ "$output" == *"WARN: could not place rtk binary"* ]] || {
    echo "expected RTK move warning, got: $output" >&2
    exit 1
}
[[ "$output" != *"INSTALLED:"* ]] || {
    echo "RTK reported an installation after move failure" >&2
    exit 1
}
[ ! -e "$FIXTURE/move-failure/.pi/agent/bin/rtk" ] || {
    echo "RTK link was created after move failure" >&2
    exit 1
}

chmod() { return 1; }
output="$(
    HOME="$FIXTURE/chmod-failure"
    PATH="/usr/local/bin:/usr/bin:/bin"
    install_rtk
)"
unset -f chmod
[[ "$output" == *"WARN: could not mark rtk binary executable"* ]] || {
    echo "expected RTK chmod warning, got: $output" >&2
    exit 1
}
[[ "$output" != *"INSTALLED:"* ]] || {
    echo "RTK reported an installation after chmod failure" >&2
    exit 1
}
[ ! -e "$FIXTURE/chmod-failure/.pi/agent/bin/rtk" ] || {
    echo "RTK link was created after chmod failure" >&2
    exit 1
}

echo "PASS: RTK release asset resolution and installation"
