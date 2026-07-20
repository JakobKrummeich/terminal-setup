#!/bin/bash
# Install terminal config: WezTerm, tmux, shell wsstate hook.
# Use on Linux/WSL hosts. Does not install/link pi config or rtk.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/install-common.sh
. "$REPO/lib/install-common.sh"

install_wezterm
install_tmux
install_shell_wsstate

echo "Done. Terminal config installed. Manual steps if flagged above: wezterm/tmux install; Windows stub stays manual (see README)."
