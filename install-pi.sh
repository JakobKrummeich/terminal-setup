#!/bin/bash
# Install pi-side config: pi extensions/themes/skills/settings, rtk, shell wsstate hook.
# Use inside containers or anywhere pi runs. Does not install/link WezTerm or tmux.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

install_pi
install_pi_azure_response_retry_patch
install_rtk
install_shell_wsstate

echo "Done. pi config installed. Restart pi to reload extensions; restart shell or source shell/wsstate.sh for current shell status."
