# AGENTS.md

Read `README.md` first — layout, install, known issues live there. Don't duplicate it here.

## Non-obvious rules

- **Symlinks point INTO this repo.** Editing `~/.config/wezterm/wezterm.lua`,
  `~/.tmux.conf`, or `~/.pi/agent/extensions/*` edits repo files directly — and
  wezterm auto-reloads on save. A broken `wezterm.lua` breaks the user's live
  terminal immediately.
- `pi/settings.json` is a **reference copy** — live file `~/.pi/agent/settings.json`
  is copied once, then owned by pi (rewritten at runtime). Never assume they're in
  sync; never symlink it.
- `markdown-no-padding.ts` patches pi-tui internals — re-verify after `pi update`.
- `install-terminal.sh` and `install-pi.sh` are idempotent — safe to re-run as smoke tests.

## Verify changes

- tmux config parse: `tmux -f tmux/tmux.conf -L cfgtest new-session -d \; kill-server`
- wezterm config: save + watch the running terminal (auto-reload); syntax errors show
  as a wezterm error overlay.
- pi extensions: restart pi to reload.

## Boundaries

- ✅ **Always:** edit configs via repo paths (they ARE the live configs).
- ⚠️ **Ask first:** risky `wezterm.lua` edits (font/layout — see README known issues:
  glyph jitter, pane-sync timing); changing installer backup/link semantics.
- 🚫 **Never:** commit `~/.pi/agent/auth.json` or any API keys; symlink
  `settings.json`; edit the live `~/.pi/agent/settings.json` on pi's behalf.
