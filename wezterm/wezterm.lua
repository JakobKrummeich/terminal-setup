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

local function apply_padding(window)
  local panecols = wezterm.GLOBAL.panecols or {}
  local tmux_n = tonumber(panecols[tostring(window:window_id())]) or 1
  -- Native splits win when present; otherwise honor the tmux hook value.
  local native_n = top_row_pane_count(window)
  local n = native_n > 1 and native_n or tmux_n
  local dims = window:get_dimensions()
  local pdims = window:active_pane():get_dimensions()
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
}

config.colors = dark_colors
config.bold_brightens_ansi_colors = true

-- ── Light-mode toggle: Alt+Shift+L (per window) ────────────────
-- New windows start dark; toggle when ambient light demands it.
config.keys = {
  {
    key = 'L',
    mods = 'ALT',
    action = wezterm.action_callback(function(window, pane)
      local light = not (wezterm.GLOBAL.light_mode or false)
      wezterm.GLOBAL.light_mode = light
      local overrides = window:get_config_overrides() or {}
      overrides.colors = light and light_colors or dark_colors
      -- Brights are mostly lighter than base colors: on a light bg,
      -- bold-brightening lowers contrast instead of raising it.
      overrides.bold_brightens_ansi_colors = not light
      window:set_config_overrides(overrides)
    end),
  },
}

-- ── Workspace status prototype (tabs = workspaces) ────────────
-- Alt+W switcher, Alt+N new workspace, Alt+R relabel intent.
-- Guarded: a broken module must never take down the live terminal.
-- Overrides enable_tab_bar below (bar = window list + workspace overview).
local ws_ok, ws = pcall(require, 'workspace-status')

-- ── Chrome off: uniform field, minimal stimulus ────────────────
config.enable_tab_bar = false
config.window_decorations = 'TITLE | RESIZE'
config.audible_bell = 'Disabled'

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
