# wsstate.sh — report shell busy/idle to wezterm via OSC 1337 SetUserVar.
#
# Source from .bashrc / .zshrc (host AND inside containers):
#   [ -f /path/to/wsstate.sh ] && . /path/to/wsstate.sh
#
# Emits SetUserVar wsstate=busy when a command starts, wsstate=idle when
# the prompt returns. Escape sequences pass through `podman exec` ptys
# untouched, so this works identically inside containers.
# Consumed by wezterm/workspace-status.lua.

__ws_emit() {
  # base64 payload per OSC 1337 SetUserVar spec; write to controlling tty.
  # Inside tmux the OSC must be wrapped in a DCS passthrough (ESC doubled),
  # or tmux swallows it before wezterm sees it (needs allow-passthrough on;
  # same pattern as tmux/panecols.sh).
  local b64
  b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
  if [ -n "${TMUX:-}" ]; then
    printf '\033Ptmux;\033\033]1337;SetUserVar=wsstate=%s\007\033\\' "$b64" > /dev/tty 2>/dev/null || true
  else
    printf '\033]1337;SetUserVar=wsstate=%s\007' "$b64" > /dev/tty 2>/dev/null || true
  fi
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null || return 0
  __ws_preexec() { __ws_emit busy; }
  __ws_precmd()  { __ws_emit idle; }
  add-zsh-hook preexec __ws_preexec
  add-zsh-hook precmd  __ws_precmd
elif [ -n "${BASH_VERSION:-}" ]; then
  if [ -n "${bash_preexec_imported:-}${__bp_imported:-}" ] \
      || declare -F __bp_precmd_invoke_cmd >/dev/null 2>&1; then
    # bash-preexec present (wezterm ships it via /etc/profile.d/wezterm.sh
    # for login shells). It owns the DEBUG trap and would overwrite ours at
    # first prompt — register with its hook arrays instead.
    __ws_precmd()  { __ws_emit idle; }
    __ws_preexec() { __ws_emit busy; }
    precmd_functions+=(__ws_precmd)
    preexec_functions+=(__ws_preexec)
  else
    # Plain bash: DEBUG trap fires before every command, including each
    # PROMPT_COMMAND entry. __ws_at_prompt flag ensures we only emit busy
    # for user-typed commands.
    __ws_prompt() { __ws_at_prompt=1; __ws_emit idle; }
    __ws_preexec() {
      [ -n "${__ws_at_prompt:-}" ] || return 0
      __ws_at_prompt=
      __ws_emit busy
    }
    __ws_install_prompt_hook() {
      # Ours must run LAST: if __ws_prompt ran first (setting the flag), later
      # PROMPT_COMMAND entries would emit a spurious 'busy' that sticks.
      # Bash can store PROMPT_COMMAND as either a string or an indexed array
      # (common on modern WSL/systemd shells); preserve whichever form exists.
      local decl cmd
      decl="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"
      if [[ "$decl" == declare\ -a* ]]; then
        local pc=()
        for cmd in "${PROMPT_COMMAND[@]}"; do
          [ "$cmd" = "__ws_prompt" ] && continue
          pc+=("$cmd")
        done
        pc+=(__ws_prompt)
        PROMPT_COMMAND=("${pc[@]}")
      else
        case ";${PROMPT_COMMAND:-};" in
          *";__ws_prompt;"*) ;;
          *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__ws_prompt" ;;
        esac
      fi
    }

    trap '__ws_preexec' DEBUG
    __ws_install_prompt_hook
  fi
fi
