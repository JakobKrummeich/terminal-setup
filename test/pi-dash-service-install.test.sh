#!/usr/bin/env bash
# install_pi_dash_service: renders pi/pi-dash.service into the systemd user unit
# and (re)starts it; degrades to a WARN (exit 0) without node or a user bus.
# The repo and node paths below carry a space, &, | and \ on purpose: the unit is
# rendered with quoted bash substitution, and an unquoted replacement (bash 5.2
# patsub_replacement turns & into the matched @REPO@) or a sed rewrite would
# silently write a broken ExecStart. No real systemctl is ever called.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

tricky_repo="$FIXTURE/repo dir & a|b\\c"
mkdir -p "$tricky_repo/pi"
cp "$REPO/pi/pi-dash.service" "$tricky_repo/pi/pi-dash.service"

# node on PATH is a symlink: the unit must name the resolved binary.
node_real="$FIXTURE/node store/node-real"
bin="$FIXTURE/bin"
mkdir -p "$(dirname "$node_real")" "$bin"
printf '#!/bin/sh\nexit 0\n' > "$node_real"
chmod +x "$node_real"
ln -s "$node_real" "$bin/node"

# systemctl stub: logs its args; exits 1 for the subcommand named in SYSTEMCTL_FAIL.
cat > "$bin/systemctl" <<'STUB'
#!/bin/sh
echo "$*" >> "$SYSTEMCTL_LOG"
[ "$2" != "${SYSTEMCTL_FAIL-}" ]
STUB
chmod +x "$bin/systemctl"

run_install() { # <case-name> <PATH> [systemctl subcommand to fail] → stdout; HOME per case
    HOME="$FIXTURE/home-$1" PATH="$2" SYSTEMCTL_LOG="$FIXTURE/systemctl-$1.log" \
        SYSTEMCTL_FAIL="${3-}" REPO="$REPO" TRICKY_REPO="$tricky_repo" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      REPO="$TRICKY_REPO"
      install_pi_dash_service
    '
}

unit_of() { printf '%s' "$FIXTURE/home-$1/.config/systemd/user/pi-dash.service"; }

# ── bus available: unit rendered, enabled and restarted ────────────
out="$(run_install ok "$bin:$PATH")" || fail "install aborted: $out"
unit="$(unit_of ok)"
[[ "$out" == *"COPIED: $unit (ExecStart: $node_real $tricky_repo/pi/dashboard-daemon.mjs)"* ]] || fail "missing COPIED line: $out"
[[ "$out" == *"ENABLED: pi-dash.service"* ]] || fail "missing ENABLED line: $out"
grep -qxF "ExecStart=\"$node_real\" \"$tricky_repo/pi/dashboard-daemon.mjs\"" "$unit" \
    || fail "ExecStart not rendered verbatim: $(grep ExecStart "$unit")"
! grep -qE '@(NODE|REPO)@' "$unit" || fail "placeholder left in unit"
grep -qxF "Restart=on-failure" "$unit" || fail "template body not copied"
[ "$(wc -l < "$unit")" = "$(wc -l < "$REPO/pi/pi-dash.service")" ] || fail "unit line count differs from template"
[ "$(cat "$FIXTURE/systemctl-ok.log")" = "--user daemon-reload
--user enable pi-dash.service
--user restart pi-dash.service" ] || fail "unexpected systemctl calls: $(cat "$FIXTURE/systemctl-ok.log")"

# ── no user bus: unit still copied, manual command printed, nothing enabled ──
out="$(run_install nobus "$bin:$PATH" daemon-reload)" || fail "no-bus install aborted: $out"
[[ "$out" == *"WARN: systemd user bus unavailable; run manually: $node_real $tricky_repo/pi/dashboard-daemon.mjs"* ]] \
    || fail "missing no-bus WARN: $out"
[ -f "$(unit_of nobus)" ] || fail "no-bus: unit not copied"
[ "$(cat "$FIXTURE/systemctl-nobus.log")" = "--user daemon-reload" ] || fail "no-bus: enable/restart must not run"

# ── restart fails: warning, installer continues ─────────────────────
out="$(run_install norestart "$bin:$PATH" restart)" || fail "failed-restart install aborted: $out"
[[ "$out" == *"WARN: could not enable/start pi-dash.service"* ]] || fail "missing restart WARN: $out"
[[ "$out" != *"ENABLED:"* ]] || fail "failed restart reported ENABLED: $out"

# ── no node: nothing written, installer continues ───────────────────
nonode_bin="$FIXTURE/bin-no-node"
mkdir -p "$nonode_bin"
ln -s "$BASH" "$nonode_bin/bash"
out="$(run_install nonode "$nonode_bin")" || fail "no-node install aborted: $out"
[ "$out" = "WARN: node not found; pi-dash dashboard daemon not installed" ] || fail "no-node output: $out"
[ ! -e "$(unit_of nonode)" ] || fail "no-node: unit written anyway"
[ ! -e "$FIXTURE/systemctl-nonode.log" ] || fail "no-node: systemctl called"

printf 'PASS: install_pi_dash_service renders the unit verbatim and degrades to warnings\n'
