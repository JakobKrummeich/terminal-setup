-- WezTerm config: centered reading column for pi TUI sessions.
-- Goals: 75-col centered content, uniform Solarized-Dark background,
-- pixel-padding margins (invisible to mouse selection — no space cells).

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- ── Backend ────────────────────────────────────────────────────
-- Native Wayland: mutter's explicit-sync path fixes flicker seen via
-- XWayland (23.2.6 lacks explicit sync) on NVIDIA. Slight input lag
-- accepted as tradeoff. Set false to fall back to XWayland.
config.enable_wayland = true

-- ── Reading column(s) ──────────────────────────────────────────
-- Grid sized to N centered columns of MAX_COLS (+ N-1 tmux separators).
-- N arrives from tmux hooks via OSC 1337 SetUserVar (tmux/panecols.sh);
-- defaults to 1. Padding is pixels, not cells: selection never contains it.
-- Same-value guard prevents padding->SIGWINCH->hook feedback loops.
local MAX_COLS = 75

-- Count panes in the top row of the active tab (native wezterm splits).
-- Used so side-by-side splits each get ~MAX_COLS instead of sharing one
-- column. Falls back to 1 on any error.
local function top_row_pane_count(window)
  local ok, n = pcall(function()
    local count = 0
    for _, p in ipairs(window:active_tab():panes_with_info()) do
      -- Zoomed pane fills the tab alone: layout is 1 column regardless
      -- of how many panes the top row has when unzoomed.
      if p.is_zoomed then return 1 end
      if p.top == 0 then count = count + 1 end
    end
    return count
  end)
  if ok and type(n) == 'number' and n > 0 then return n end
  return 1
end

local function apply_padding_unguarded(window)
  local panecols = wezterm.GLOBAL.panecols or {}
  local tmux_n = tonumber(panecols[tostring(window:window_id())]) or 1
  -- Native splits win when present; otherwise honor the tmux hook value.
  local native_n = top_row_pane_count(window)
  local n = native_n > 1 and native_n or tmux_n
  local dims = window:get_dimensions()
  -- active_pane() is nil during window setup/teardown (update-status can
  -- fire before the first pane exists): bail instead of indexing nil.
  local pane = window:active_pane()
  if not pane then return end
  local pdims = pane:get_dimensions()
  if not pdims or pdims.cols == 0 then return end
  local cell_w = pdims.pixel_width / pdims.cols
  local target_cols = n * MAX_COLS + (n - 1)
  local content_px = target_cols * cell_w
  local margin = math.max(0, math.floor((dims.pixel_width - content_px) / 2))
  local overrides = window:get_config_overrides() or {}
  local cur = overrides.window_padding
  if not cur or cur.left ~= margin then
    overrides.window_padding = { left = margin, right = margin, top = 8, bottom = 8 }
    window:set_config_overrides(overrides)
  end
end

-- Guarded: panes can vanish mid-call ('pane id N not found in mux'). An
-- uncaught error in update-status also skips later update-status
-- handlers (the workspace strip), which once froze the right status.
local function apply_padding(window)
  local ok, err = pcall(apply_padding_unguarded, window)
  if not ok then
    wezterm.log_warn('apply_padding: ' .. tostring(err))
  end
end

wezterm.on('window-resized', function(window, pane)
  apply_padding(window)
end)

-- Splits/closes don't fire window-resized; re-check on the ~1s status
-- tick. Cheap: apply_padding's same-value guard skips no-op updates.
wezterm.on('update-status', function(window, pane)
  apply_padding(window)
end)

wezterm.on('user-var-changed', function(window, pane, name, value)
  if name == 'panecols' then
    local t = wezterm.GLOBAL.panecols or {}
    t[tostring(window:window_id())] = tonumber(value) or 1
    wezterm.GLOBAL.panecols = t
    apply_padding(window)
  end
end)

-- ── Font & leading (matches tuned GNOME Terminal profile) ──────
config.font = wezterm.font('Ubuntu Sans Mono', { weight = 'Regular' })
config.font_size = 16.0
config.line_height = 1.25
config.freetype_load_flags = 'NO_HINTING'

-- ── Solarized palettes ─────────────────────────────────────────
-- ANSI/accent table is canonical Solarized: identical in both modes.
local solarized_ansi = { '#073642', '#dc322f', '#859900', '#b58900',
                         '#268bd2', '#d33682', '#2aa198', '#eee8d5' }
local solarized_brights = { '#002b36', '#cb4b16', '#586e75', '#657b83',
                            '#839496', '#6c71c4', '#93a1a1', '#fdf6e3' }

-- Tab bar flush with the terminal background: no band, the bar reads as
-- part of the field. Active = bold emphasis color; inactive = base00
-- (legible on both base03 and base3, unlike base01/base1); hover = the
-- selection-shade band. workspace-status.lua reuses the active/inactive
-- fg colors for its right-hand workspace strip.
local function tab_bar(bg, hover_bg, active_fg)
  local inactive_fg = '#657b83'
  return {
    background = bg,
    active_tab = { bg_color = bg, fg_color = active_fg, intensity = 'Bold' },
    inactive_tab = { bg_color = bg, fg_color = inactive_fg },
    inactive_tab_hover = { bg_color = hover_bg, fg_color = active_fg },
    new_tab = { bg_color = bg, fg_color = inactive_fg },
    new_tab_hover = { bg_color = hover_bg, fg_color = active_fg },
  }
end

-- Dark: contrast-bumped (fg base1, bold base2).
local dark_colors = {
  background = '#002b36',
  foreground = '#93a1a1',
  cursor_bg = '#93a1a1',
  cursor_fg = '#002b36',
  selection_bg = '#073642',
  selection_fg = '#93a1a1',
  ansi = solarized_ansi,
  brights = solarized_brights,
  tab_bar = tab_bar('#002b36', '#073642', '#eee8d5'),
}

-- Light: for bright ambient light. Positive polarity (dark-on-light)
-- reads sharper under high ambient light — constricted pupil, better
-- retinal focus (Buchner & Baumgartner 2007; Piepenbrock et al. 2013).
-- Warm off-white base3 avoids pure-white glare; fg bumped to base02
-- (~12:1) because ambient reflections wash out on-screen contrast.
-- Bright white remapped base3->base00: apps printing bright white
-- would be invisible on the base3 background (breaks canonical
-- Solarized for solarized-aware apps; legibility wins).
local solarized_brights_light = { '#002b36', '#cb4b16', '#586e75', '#657b83',
                                  '#839496', '#6c71c4', '#93a1a1', '#657b83' }
local light_colors = {
  background = '#fdf6e3',
  foreground = '#073642',
  cursor_bg = '#073642',
  cursor_fg = '#fdf6e3',
  selection_bg = '#eee8d5',
  selection_fg = '#073642',
  ansi = { '#fdf6e3', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#073642' },
  brights = solarized_brights_light,
  tab_bar = tab_bar('#fdf6e3', '#eee8d5', '#073642'),
}

config.colors = dark_colors
config.bold_brightens_ansi_colors = true

-- ── Light-mode toggle: Alt+Shift+L (per window) ────────────────
-- New windows start dark; toggle when ambient light demands it.
-- Mode is read from THIS window's overrides, not a global flag: a global
-- went stale across windows and made the next toggle elsewhere a no-op.
config.keys = {
  {
    key = 'L',
    mods = 'ALT',
    action = wezterm.action_callback(function(window, pane)
      local overrides = window:get_config_overrides() or {}
      local cur = overrides.colors
      local light = not (cur and cur.background == light_colors.background)
      overrides.colors = light and light_colors or dark_colors
      -- Brights are mostly lighter than base colors: on a light bg,
      -- bold-brightening lowers contrast instead of raising it.
      overrides.bold_brightens_ansi_colors = not light
      window:set_config_overrides(overrides)
    end),
  },
  -- ── Alt+Enter → pi follow-up queueing ────────────────────────
  -- WezTerm binds Alt/Option+Enter to ToggleFullScreen by default, which
  -- swallows the key before the TUI sees it. Send the CSI-u encoding
  -- (Kitty keyboard protocol) pi listens for instead.
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}

-- ── Workspace status prototype (tabs = workspaces) ────────────
-- Alt+W switcher, Alt+N new workspace, Alt+R relabel intent.
-- Guarded: a broken module must never take down the live terminal.
-- Overrides enable_tab_bar below (bar = window list + workspace overview).
local ws_ok, ws = pcall(require, 'workspace-status')

-- ── Chrome off: uniform field, minimal stimulus ────────────────
config.enable_tab_bar = false
-- Nightly + GNOME Wayland: no SSD; TITLE|RESIZE renders nothing there.
-- INTEGRATED_BUTTONS puts close/max/min into the tab bar instead.
config.window_decorations = 'INTEGRATED_BUTTONS|RESIZE'
config.audible_bell = 'Disabled'

-- ── Scrollback ─────────────────────────────────────────────────
-- Default is 3500. TUIs that repaint in place (pi) burn history fast, and a
-- full repaint emits ESC[3J, which erases saved lines outright.
config.scrollback_lines = 50000

-- ── Selection/clipboard ────────────────────────────────────────
-- Word selection boundaries; wrapped lines rejoin automatically on copy.
config.selection_word_boundary = ' \t\n{}[]()"\'`,;:'

if ws_ok then
  local apply_ok, err = pcall(ws.apply, config)
  if not apply_ok then wezterm.log_error('workspace-status: ' .. tostring(err)) end
else
  wezterm.log_error('workspace-status not loaded: ' .. tostring(ws))
end

return config
