#!/usr/bin/env bash
# link + install_pi: every installer run (install-pi.sh and, via link,
# install-terminal.sh) points user config paths into the repo. Pins the parts
# that touch user data: a real file or dir in the way is moved to
# <dest>.pre-terminal-setup, never deleted; an existing link is re-pointed
# without a backup and never followed (ln -n — otherwise a re-run plants a link
# INSIDE the repo dir); skills are linked one-by-one so non-repo skills survive;
# settings.json is copied once and never overwritten. Uses a fixture repo, so a
# regression cannot write into this checkout.
set -euo pipefail

FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/install-common.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

repo="$FIXTURE/repo"
mkdir -p "$repo/pi/extensions" "$repo/pi/themes" "$repo/pi/skills/alpha" "$repo/pi/skills/beta"
printf '{"repo": true}\n' > "$repo/pi/settings.json"

run_install_pi() { # <home> → install_pi stdout
    HOME="$1" REPO="$repo" LIB="$LIB" bash -euo pipefail -c '
      . "$LIB"
      install_pi
    '
}

assert_link() { # <path> <expected target>
    [ -L "$1" ] || fail "$1 is not a symlink"
    [ "$(readlink "$1")" = "$2" ] || fail "$1 -> $(readlink "$1"), expected $2"
}

assert_repo_untouched() {
    local stray
    stray="$(find "$repo" -type l)"
    [ -z "$stray" ] || fail "link planted inside the repo: $stray"
}

# ── fresh home: dirs and each skill linked, settings.json copied (not linked) ──
home="$FIXTURE/fresh"
out="$(run_install_pi "$home")" || fail "fresh install aborted: $out"
agent="$home/.pi/agent"
assert_link "$agent/extensions" "$repo/pi/extensions"
assert_link "$agent/themes" "$repo/pi/themes"
assert_link "$agent/skills/alpha" "$repo/pi/skills/alpha"
assert_link "$agent/skills/beta" "$repo/pi/skills/beta"
[ ! -L "$agent/skills" ] || fail "skills dir itself linked; non-repo skills would vanish"
[ ! -L "$agent/settings.json" ] || fail "settings.json linked; pi writes it, edits would land in the repo"
[ -f "$agent/settings.json" ] || fail "settings.json not copied"
cmp -s "$agent/settings.json" "$repo/pi/settings.json" || fail "settings.json copy differs"
[[ "$out" == *"COPIED: pi settings.json (fresh)"* ]] || fail "missing COPIED line: $out"
[[ "$out" != *"BACKUP:"* ]] || fail "fresh install backed something up: $out"

# ── re-run: idempotent, edited settings.json kept, links not followed ──
printf '{"mine": true}\n' > "$agent/settings.json"
out="$(run_install_pi "$home")" || fail "re-run aborted: $out"
[ "$(cat "$agent/settings.json")" = '{"mine": true}' ] || fail "re-run overwrote user settings.json"
[[ "$out" == *"SKIPPED: ~/.pi/agent/settings.json exists"* ]] || fail "missing SKIPPED line: $out"
[[ "$out" != *"BACKUP:"* ]] || fail "re-run backed up its own links: $out"
assert_link "$agent/extensions" "$repo/pi/extensions"
assert_repo_untouched
[ -z "$(find "$home" -name '*.pre-terminal-setup')" ] || fail "re-run left a backup"

# ── real dir/file in the way: moved aside with content; non-repo skill kept ──
home="$FIXTURE/existing"
agent="$home/.pi/agent"
mkdir -p "$agent/extensions" "$agent/skills/alpha" "$agent/skills/own-skill"
printf 'user ext\n' > "$agent/extensions/mine.ts"
printf 'user alpha\n' > "$agent/skills/alpha/SKILL.md"
printf 'own\n' > "$agent/skills/own-skill/SKILL.md"
printf 'user theme\n' > "$agent/themes"
out="$(run_install_pi "$home")" || fail "install over existing config aborted: $out"
[ "$(cat "$agent/extensions.pre-terminal-setup/mine.ts")" = "user ext" ] || fail "extensions dir not backed up intact"
[ "$(cat "$agent/skills/alpha.pre-terminal-setup/SKILL.md")" = "user alpha" ] || fail "skill dir not backed up intact"
[ "$(cat "$agent/themes.pre-terminal-setup")" = "user theme" ] || fail "themes file not backed up intact"
[[ "$out" == *"BACKUP: $agent/extensions -> $agent/extensions.pre-terminal-setup"* ]] || fail "missing BACKUP line: $out"
assert_link "$agent/extensions" "$repo/pi/extensions"
assert_link "$agent/themes" "$repo/pi/themes"
assert_link "$agent/skills/alpha" "$repo/pi/skills/alpha"
[ "$(cat "$agent/skills/own-skill/SKILL.md")" = "own" ] || fail "non-repo skill touched"

# ── link from an old repo location: re-pointed, no backup ───────────
home="$FIXTURE/moved"
agent="$home/.pi/agent"
mkdir -p "$FIXTURE/old-repo/extensions" "$agent"
ln -s "$FIXTURE/old-repo/extensions" "$agent/extensions"
out="$(run_install_pi "$home")" || fail "install over old link aborted: $out"
assert_link "$agent/extensions" "$repo/pi/extensions"
[ ! -e "$agent/extensions.pre-terminal-setup" ] || fail "old link backed up instead of re-pointed"
[ -z "$(find "$FIXTURE/old-repo" -type l)" ] || fail "link planted inside the old repo dir"
assert_repo_untouched

printf 'PASS: link/install_pi back up real config, re-point links, never overwrite settings.json\n'
