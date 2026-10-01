#!/bin/bash
# Install pi-side config: pi extensions/themes/skills/settings, rtk, shell wsstate hook.
# Use inside containers or anywhere pi runs. Does not install/link WezTerm or tmux.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

warn_if_run_with_sudo
warn_if_pi_too_old
install_pi
install_pi_dash_service
install_rtk
install_shell_wsstate

echo "Done. pi config installed. Restart pi to reload extensions; restart shell or source shell/wsstate.sh for current shell status."
