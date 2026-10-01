#!/usr/bin/env bash
# sudo ./install-pi.sh warns (per-user steps would act as root); plain root does not.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

printf '#!/bin/sh\necho 0\n' > "$FIXTURE/id"
chmod +x "$FIXTURE/id"
sudo_warning() { # <SUDO_USER value or empty>
    SUDO_USER="$1" PATH="$FIXTURE:$PATH" REPO="$REPO" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      warn_if_run_with_sudo
    ' 2>&1
}
out="$(sudo_warning alice)"
[[ "$out" == *"WARNING: install-pi.sh is running as root via sudo (SUDO_USER=alice)"*"Run it without sudo"* ]] \
    || { echo "sudo warning missing: $out" >&2; exit 1; }
out="$(sudo_warning "")"
[ -z "$out" ] || { echo "plain root must not warn: $out" >&2; exit 1; }

printf 'PASS: install-pi.sh warns when run via sudo\n'
