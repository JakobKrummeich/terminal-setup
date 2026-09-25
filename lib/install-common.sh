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

install_pi_dash_service() {
    # ── pi-dash: machine-global dashboard daemon (systemd user unit) ─
    # Template-copied (not symlinked — `systemctl enable` on symlinked units is
    # flaky) with absolute node/repo paths baked in. Idempotent: re-runs
    # re-copy the unit and restart the daemon so code updates take effect.
    # Degrades to a warning wherever node or the systemd user bus is missing
    # (containers): pi then notifies "daemon not running" and everything else
    # still works.
    local unit_dest="$HOME/.config/systemd/user/pi-dash.service"
    local node_bin
    if ! node_bin="$(command -v node)"; then
        echo "WARN: node not found; pi-dash dashboard daemon not installed"
        return 0
    fi
    node_bin="$(readlink -f "$node_bin")"
    mkdir -p "$(dirname "$unit_dest")"
    # Bash substitution, not sed: the paths may contain sed metacharacters
    # (|, &, \). The quoted replacement keeps bash 5.2's patsub `&` literal.
    # The template quotes the ExecStart args, so spaces in paths survive
    # systemd's word splitting too.
    local unit_content
    unit_content="$(<"$REPO/pi/pi-dash.service")"
    unit_content="${unit_content//@NODE@/"$node_bin"}"
    unit_content="${unit_content//@REPO@/"$REPO"}"
    printf '%s\n' "$unit_content" > "$unit_dest"
    echo "COPIED: $unit_dest (ExecStart: $node_bin $REPO/pi/dashboard-daemon.mjs)"
    if ! command -v systemctl >/dev/null || ! systemctl --user daemon-reload 2>/dev/null; then
        echo "WARN: systemd user bus unavailable; run manually: $node_bin $REPO/pi/dashboard-daemon.mjs"
        return 0
    fi
    # enable (no --now) + restart: restart also starts a stopped unit, and —
    # unlike `enable --now` — picks up new code when the daemon already runs.
    # Port squatters are the unit's problem: Restart=on-failure/RestartSec=30.
    if systemctl --user enable pi-dash.service >/dev/null 2>&1 && systemctl --user restart pi-dash.service 2>/dev/null; then
        echo "ENABLED: pi-dash.service (dashboard on port 7357; PI_AGENT_DASH_PORT overrides)"
    else
        echo "WARN: could not enable/start pi-dash.service; check: systemctl --user status pi-dash"
    fi
}

find_pi_ai_root_from() { # <pi-executable-or-cli-path> [package-tree-root]
    # Follow the executable into its package tree, then mirror Node's ancestor lookup.
    local resolved_path search_root="${2-}" pi_search_dir pi_ai_root
    resolved_path="$(readlink -f "$1")" || return 1
    if [ -n "$search_root" ]; then
        search_root="$(readlink -f "$search_root")" || return 1
        case "$resolved_path" in
            "$search_root"/*) ;;
            *) return 1 ;;
        esac
    fi
    pi_search_dir="$(dirname "$resolved_path")"
    while [ "$pi_search_dir" != / ]; do
        pi_ai_root="$pi_search_dir/node_modules/@earendil-works/pi-ai"
        if [ -f "$pi_ai_root/package.json" ]; then
            printf '%s\n' "$pi_ai_root"
            return 0
        fi
        [ -n "$search_root" ] && [ "$pi_search_dir" = "$search_root" ] && break
        pi_search_dir="$(dirname "$pi_search_dir")"
    done
    return 1
}

install_pi_azure_response_retry_patch() {
    # Temporary fail-closed workaround for Pi 0.83.0/0.84.1–0.84.4/0.85.1/0.86.1/0.87.1 Azure Responses failed SSE events.
    if ! command -v pi >/dev/null; then
        echo "SKIPPED: Pi Azure retry patch (pi is not installed)"
        return 0
    fi
    local pi_bin pi_ai_root managed_root managed_marker current_file current_version managed_pi_bin
    pi_bin="$(readlink -f "$(command -v pi)")"
    managed_root="$(dirname "$(dirname "$pi_bin")")/install"
    managed_marker="$managed_root/managed-install.json"

    # Managed Pi uses a regular launcher at <agent>/bin/pi, not a symlink to
    # the active release. Its marker must win over any unrelated ancestor package.
    if [ -f "$managed_marker" ]; then
        if ! node -e '
const fs = require("node:fs");
const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") process.exit(1);
' "$managed_marker" 2>/dev/null; then
            echo "ERROR: Managed Pi marker is invalid: $managed_marker; patch not applied." >&2
            return 1
        fi
        current_file="$managed_root/current-version"
        if ! IFS= read -r current_version < "$current_file" 2>/dev/null \
            || [[ ! "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
            echo "ERROR: Managed Pi current version is missing or invalid: $current_file; patch not applied." >&2
            return 1
        fi
        managed_pi_bin="$managed_root/releases/$current_version/node_modules/.bin/pi"
        if [ ! -x "$managed_pi_bin" ]; then
            echo "ERROR: Managed Pi executable is missing: $managed_pi_bin; patch not applied." >&2
            return 1
        fi
        if pi_ai_root="$(find_pi_ai_root_from "$managed_pi_bin" "$managed_root/releases/$current_version")"; then
            PI_AI_ROOT="$pi_ai_root" node "$REPO/pi/patches/pi-azure-response-failed-retry.cjs"
            return
        fi
        echo "ERROR: Pi AI package not found from managed Pi executable $managed_pi_bin; patch not applied." >&2
        return 1
    fi

    # Legacy/npm installs resolve directly into the active package tree.
    if pi_ai_root="$(find_pi_ai_root_from "$pi_bin")"; then
        PI_AI_ROOT="$pi_ai_root" node "$REPO/pi/patches/pi-azure-response-failed-retry.cjs"
        return
    fi
    echo "ERROR: Pi AI package not found from Pi executable $pi_bin; patch not applied." >&2
    return 1
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

resolve_rtk_release_url() { # <os> <arch>
    local os="$1" arch="$2"
    curl -fsSL https://api.github.com/repos/rtk-ai/rtk/releases/latest \
        | node -e '
const assetNames = {
  "Linux/x86_64": ["rtk-x86_64-unknown-linux-musl.tar.gz", "rtk-x86_64-unknown-linux-gnu.tar.gz"],
  "Linux/aarch64": ["rtk-aarch64-unknown-linux-musl.tar.gz", "rtk-aarch64-unknown-linux-gnu.tar.gz"],
  "Darwin/x86_64": ["rtk-x86_64-apple-darwin.tar.gz"],
  "Darwin/arm64": ["rtk-aarch64-apple-darwin.tar.gz"],
};
try {
  const [os, arch] = process.argv.slice(1);
  const { assets } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const asset = assetNames[`${os}/${arch}`]?.map((name) => assets.find((candidate) => candidate.name === name)).find(Boolean);
  if (asset?.browser_download_url) process.stdout.write(asset.browser_download_url);
} catch {
  process.exit(1);
}
' "$os" "$arch"
}

install_rtk_from_url() { # <download-url>
    local url="$1" download extract_dir extracted_rtk
    mkdir -p "$HOME/.local/bin"
    download="$(mktemp)"
    if ! curl -fsSL "$url" -o "$download"; then
        echo "WARN: could not download rtk release asset; install manually: https://github.com/rtk-ai/rtk"
        rm -f "$download"
        return 1
    fi
    case "$url" in
        *.tar.gz)
            extract_dir="$(mktemp -d)"
            if ! tar -xzf "$download" -C "$extract_dir"; then
                echo "WARN: could not extract rtk release asset; install manually: https://github.com/rtk-ai/rtk"
                rm -rf "$extract_dir"
                rm -f "$download"
                return 1
            fi
            extracted_rtk="$(find "$extract_dir" -type f -name rtk -print -quit)"
            if [ -z "$extracted_rtk" ]; then
                echo "WARN: rtk release asset contains no rtk binary; install manually: https://github.com/rtk-ai/rtk"
                rm -rf "$extract_dir"
                rm -f "$download"
                return 1
            fi
            if [ -d "$HOME/.local/bin/rtk" ] || ! mv "$extracted_rtk" "$HOME/.local/bin/rtk"; then
                echo "WARN: could not place rtk binary; install manually: https://github.com/rtk-ai/rtk"
                rm -rf "$extract_dir"
                rm -f "$download"
                return 1
            fi
            rm -rf "$extract_dir"
            rm -f "$download"
            ;;
        *)
            if [ -d "$HOME/.local/bin/rtk" ] || ! mv "$download" "$HOME/.local/bin/rtk"; then
                echo "WARN: could not place rtk binary; install manually: https://github.com/rtk-ai/rtk"
                rm -f "$download"
                return 1
            fi
            ;;
    esac
    if ! chmod +x "$HOME/.local/bin/rtk"; then
        echo "WARN: could not mark rtk binary executable; install manually: https://github.com/rtk-ai/rtk"
        return 1
    fi
}

install_rtk() {
    # ── rtk (latest release binary; used by pi extensions) ──────────
    local rtk_bin="" URL="" os arch
    # Resolve rtk, but never to our own dest symlink (self-link = ELOOP).
    if command -v rtk >/dev/null && [ "$(command -v rtk)" != "$HOME/.pi/agent/bin/rtk" ]; then
        rtk_bin="$(command -v rtk)"
    else
        echo "Installing rtk (latest) ..."
        os="$(uname -s)"
        arch="$(uname -m)"
        if ! URL="$(resolve_rtk_release_url "$os" "$arch")"; then
            echo "WARN: could not fetch or parse rtk release metadata; install manually: https://github.com/rtk-ai/rtk"
        elif [ -n "$URL" ]; then
            if install_rtk_from_url "$URL"; then
                rtk_bin="$HOME/.local/bin/rtk"
                echo "INSTALLED: rtk $("$rtk_bin" --version 2>/dev/null || echo '?')"
            fi
        else
            echo "WARN: no rtk release asset for $os/$arch; install manually: https://github.com/rtk-ai/rtk"
        fi
    fi
    if [ -n "$rtk_bin" ]; then
        mkdir -p ~/.pi/agent/bin && ln -sfn "$rtk_bin" ~/.pi/agent/bin/rtk
        echo "LINKED: $HOME/.pi/agent/bin/rtk -> $rtk_bin"
    fi
}
