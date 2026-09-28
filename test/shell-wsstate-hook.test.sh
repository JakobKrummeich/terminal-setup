#!/usr/bin/env bash
# install_shell_wsstate: the only installer step that rewrites a user-owned file
# (~/.bashrc), run by both install-pi.sh and install-terminal.sh. Pins that the
# managed block is idempotent, re-pointed on repo moves, and that user lines,
# file mode and a symlinked .bashrc all survive the rewrite.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

BEGIN="# >>> terminal-setup wsstate >>>"
END="# <<< terminal-setup wsstate <<<"
HOOK="[ -f \"$REPO/shell/wsstate.sh\" ] && . \"$REPO/shell/wsstate.sh\""

fail() { echo "FAIL: $*" >&2; exit 1; }

run_install() { # <home> [repo] → install_shell_wsstate stdout
    HOME="$1" REPO="${2:-$REPO}" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      install_shell_wsstate
    '
}

expected_block() { printf '%s\n%s\n%s\n' "$BEGIN" "$HOOK" "$END"; }

assert_no_temp_files() { # <dir>
    local leftovers
    leftovers="$(find "$1" -maxdepth 1 -name '.bashrc.terminal-setup.*')"
    [ -z "$leftovers" ] || fail "temp file left behind: $leftovers"
}

# ── fresh home: .bashrc created with exactly the managed block ─────
home="$FIXTURE/fresh"
mkdir -p "$home"
out="$(run_install "$home")"
[[ "$out" == "UPDATED: $home/.bashrc wsstate hook -> $REPO/shell/wsstate.sh" ]] || fail "unexpected output: $out"
[ "$(cat "$home/.bashrc")" = "$(expected_block)" ] || fail "fresh .bashrc content: $(cat "$home/.bashrc")"
assert_no_temp_files "$home"

# ── user content kept; re-running is idempotent (one block, same bytes) ──
home="$FIXTURE/idempotent"
mkdir -p "$home"
printf 'export EDITOR=vim\nalias ll="ls -l"\n' > "$home/.bashrc"
run_install "$home" >/dev/null
first="$(cat "$home/.bashrc")"
run_install "$home" >/dev/null
[ "$(cat "$home/.bashrc")" = "$first" ] || fail "second run changed .bashrc: $(cat "$home/.bashrc")"
[ "$first" = "$(printf 'export EDITOR=vim\nalias ll="ls -l"\n'; expected_block)" ] \
    || fail "user lines not kept ahead of the block: $first"
[ "$(grep -cxF "$BEGIN" "$home/.bashrc")" = 1 ] || fail "managed block duplicated"

# ── stale block from an old repo path: replaced, lines after it kept ──
home="$FIXTURE/stale"
mkdir -p "$home"
printf 'before\n%s\n[ -f "/old/repo/shell/wsstate.sh" ] && . "/old/repo/shell/wsstate.sh"\n%s\nafter\n' \
    "$BEGIN" "$END" > "$home/.bashrc"
run_install "$home" >/dev/null
[ "$(cat "$home/.bashrc")" = "$(printf 'before\nafter\n'; expected_block)" ] \
    || fail "stale block not replaced cleanly: $(cat "$home/.bashrc")"
! grep -qF "/old/repo" "$home/.bashrc" || fail "old repo path survived"

# ── file mode survives the rewrite (mktemp alone would leave 0600) ─
home="$FIXTURE/mode"
mkdir -p "$home"
printf 'export A=1\n' > "$home/.bashrc"
chmod 640 "$home/.bashrc"
run_install "$home" >/dev/null
[ "$(stat -c %a "$home/.bashrc")" = 640 ] || fail "mode changed to $(stat -c %a "$home/.bashrc")"

# ── symlinked .bashrc (dotfiles repo): link kept, target updated ───
home="$FIXTURE/symlink"
mkdir -p "$home" "$FIXTURE/dotfiles"
printf 'from dotfiles\n' > "$FIXTURE/dotfiles/bashrc"
ln -s "$FIXTURE/dotfiles/bashrc" "$home/.bashrc"
run_install "$home" >/dev/null
[ -L "$home/.bashrc" ] || fail "symlinked .bashrc replaced by a regular file"
[ "$(readlink "$home/.bashrc")" = "$FIXTURE/dotfiles/bashrc" ] || fail "symlink re-pointed: $(readlink "$home/.bashrc")"
[ "$(cat "$FIXTURE/dotfiles/bashrc")" = "$(printf 'from dotfiles\n'; expected_block)" ] \
    || fail "symlink target not updated: $(cat "$FIXTURE/dotfiles/bashrc")"
assert_no_temp_files "$FIXTURE/dotfiles"
assert_no_temp_files "$home"

# ── hook script missing from the repo: warn, leave .bashrc untouched ──
home="$FIXTURE/missing-src"
fake_repo="$FIXTURE/fake-repo"
mkdir -p "$home" "$fake_repo/lib"
cp "$REPO/lib/install-common.sh" "$fake_repo/lib/"
printf 'untouched\n' > "$home/.bashrc"
out="$(run_install "$home" "$fake_repo")" || fail "missing hook script must not fail the installer"
[[ "$out" == "WARN: missing $fake_repo/shell/wsstate.sh; shell wsstate hook not installed" ]] || fail "expected missing-src warning, got: $out"
[ "$(cat "$home/.bashrc")" = untouched ] || fail ".bashrc modified without a hook script: $(cat "$home/.bashrc")"

# ── begin marker without end marker: refuse, leave .bashrc byte-identical ──
# The rewrite drops everything from begin to end; with no end marker that
# would silently delete every user line after the stray begin marker.
home="$FIXTURE/unterminated"
mkdir -p "$home"
printf 'before\n%s\nexport KEEP_ME=1\nalias gs="git status"\n' "$BEGIN" > "$home/.bashrc"
cp "$home/.bashrc" "$FIXTURE/unterminated.orig"
out="$(run_install "$home")" || fail "unterminated block must not fail the installer"
[[ "$out" == "WARN: $home/.bashrc has '$BEGIN' without '$END'; fix it by hand — wsstate hook not installed" ]] \
    || fail "expected unterminated-block warning, got: $out"
cmp -s "$home/.bashrc" "$FIXTURE/unterminated.orig" || fail ".bashrc rewritten despite unterminated block: $(cat "$home/.bashrc")"
assert_no_temp_files "$home"

printf 'PASS: shell wsstate hook is idempotent and preserves the user .bashrc\n'
