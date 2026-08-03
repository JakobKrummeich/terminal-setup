#!/bin/bash
# Shared installer helpers. Scripts set REPO before sourcing this file.
# Symlinks point INTO this repo. settings.json is copied, never symlinked.

link() { # link <repo-relative-src> <dest>
    local src="$REPO/$1" dest="$2"
    mkdir -p "$(dirname "$dest")"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "BACKUP: $dest -> $dest.pre-terminal-setup"
        mv "$dest" "$dest.pre-terminal-setup"
    fi
    ln -sfn "$src" "$dest"
    echo "LINKED: $dest -> $src"
}

install_shell_wsstate() {
    # Add a managed bash hook so shell panes report busy/idle to WezTerm.
    # Idempotent and repo-path-specific; re-running updates the sourced path.
    local rc="$HOME/.bashrc"
    local src="$REPO/shell/wsstate.sh"
    local begin="# >>> terminal-setup wsstate >>>"
    local end="# <<< terminal-setup wsstate <<<"
    local tmp rc_target rc_dir

    if [ ! -f "$src" ]; then
        echo "WARN: missing $src; shell wsstate hook not installed"
        return 0
    fi

    mkdir -p "$(dirname "$rc")"
    if [ -L "$rc" ]; then
        rc_target="$(readlink -f "$rc")"
    else
        rc_target="$rc"
    fi
    touch "$rc_target"

    rc_dir="$(dirname "$rc_target")"
    tmp="$(mktemp "$rc_dir/.bashrc.terminal-setup.XXXXXX")"
    chmod --reference="$rc_target" "$tmp"
    awk -v begin="$begin" -v end="$end" '
        $0 == begin { skip = 1; next }
        $0 == end { skip = 0; next }
        !skip { print }
    ' "$rc_target" > "$tmp"
    cat >> "$tmp" <<EOF
$begin
[ -f "$src" ] && . "$src"
$end
EOF
    mv "$tmp" "$rc_target"
    echo "UPDATED: $rc wsstate hook -> $src"
}

install_pi() {
    # ── pi ──────────────────────────────────────────────────────────
    link pi/extensions ~/.pi/agent/extensions
    link pi/themes ~/.pi/agent/themes

    # Skills linked one-by-one: ~/.pi/agent/skills also holds non-repo skills.
    if [ -d "$REPO/pi/skills" ]; then
        local skill
        for skill in "$REPO"/pi/skills/*/; do
            [ -d "$skill" ] || continue
            link "pi/skills/$(basename "$skill")" ~/.pi/agent/skills/"$(basename "$skill")"
        done
    fi

    if [ ! -f ~/.pi/agent/settings.json ]; then
        mkdir -p ~/.pi/agent
        cp "$REPO/pi/settings.json" ~/.pi/agent/settings.json
        echo "COPIED: pi settings.json (fresh)"
    else
        echo "SKIPPED: ~/.pi/agent/settings.json exists (merge manually if needed; repo copy is reference)"
    fi
}

install_pi_azure_response_retry_patch() {
    # Temporary fail-closed workaround for Pi 0.83.0 Azure Responses failed SSE events.
    if ! command -v pi >/dev/null; then
        echo "SKIPPED: Pi Azure retry patch (pi is not installed)"
        return 0
    fi
    node "$REPO/pi/patches/pi-0.83.0-azure-response-failed-retry.cjs"
}

install_wezterm() {
    # ── wezterm ─────────────────────────────────────────────────────
    link wezterm/wezterm.lua ~/.config/wezterm/wezterm.lua
    link wezterm/workspace-status.lua ~/.config/wezterm/workspace-status.lua
    command -v wezterm >/dev/null || echo "TODO: install wezterm (see README)"
}

install_tmux() {
    # ── tmux ────────────────────────────────────────────────────────
    link tmux/tmux.conf ~/.tmux.conf
    link tmux/panecols.sh ~/.local/bin/tmux-panecols
    command -v tmux >/dev/null || echo "TODO: sudo apt install tmux"
}

install_rtk() {
    # ── rtk (latest release binary; used by pi extensions) ──────────
    local rtk_bin="" URL=""
    # Resolve rtk, but never to our own dest symlink (self-link = ELOOP).
    if command -v rtk >/dev/null && [ "$(command -v rtk)" != "$HOME/.pi/agent/bin/rtk" ]; then
        rtk_bin="$(command -v rtk)"
    else
        echo "Installing rtk (latest) ..."
        mkdir -p ~/.local/bin
        URL=$(curl -s https://api.github.com/repos/rtk-ai/rtk/releases/latest \
            | grep -o '"browser_download_url": *"[^"]*linux[^"]*x86_64[^"]*"' \
            | head -1 | cut -d'"' -f4)
        if [ -n "$URL" ]; then
            curl -fsSL "$URL" -o /tmp/rtk-download
            case "$URL" in
                *.tar.gz) tar -xzf /tmp/rtk-download -C /tmp && mv "$(find /tmp -maxdepth 2 -name rtk -type f -newer /tmp/rtk-download | head -1)" ~/.local/bin/rtk ;;
                *) mv /tmp/rtk-download ~/.local/bin/rtk ;;
            esac
            chmod +x ~/.local/bin/rtk
            rtk_bin="$HOME/.local/bin/rtk"
            echo "INSTALLED: rtk $("$rtk_bin" --version 2>/dev/null || echo '?')"
        else
            echo "WARN: could not resolve rtk release asset; install manually: https://github.com/rtk-ai/rtk"
        fi
    fi
    if [ -n "$rtk_bin" ]; then
        mkdir -p ~/.pi/agent/bin && ln -sfn "$rtk_bin" ~/.pi/agent/bin/rtk
        echo "LINKED: $HOME/.pi/agent/bin/rtk -> $rtk_bin"
    fi
}
