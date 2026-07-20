#!/bin/bash
# Report side-by-side pane count of the active tmux window to WezTerm.
# Emits OSC 1337 SetUserVar=panecols=<base64 N>, wrapped in tmux passthrough
# (requires `allow-passthrough on`). WezTerm's user-var-changed listener
# resizes window padding so the grid fits N reading columns of 75.
# Zoomed pane => N=1 (focus reading mode).
set -u

TTY=$(tmux display-message -p '#{client_tty}' 2>/dev/null) || exit 0
[ -w "$TTY" ] || exit 0

if [ "$(tmux display-message -p '#{window_zoomed_flag}')" = "1" ]; then
    N=1
else
    # Panes whose top edge is row 0 = horizontally adjacent columns
    N=$(tmux list-panes -F '#{pane_top}' | grep -c '^0$')
fi
[ "$N" -ge 1 ] 2>/dev/null || N=1

B64=$(printf %s "$N" | base64)
printf '\033Ptmux;\033\033]1337;SetUserVar=panecols=%s\007\033\\' "$B64" > "$TTY"
