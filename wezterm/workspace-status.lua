-- Workspace status prototype (v2): wezterm workspaces = tmux sessions.
--
-- Hierarchy (mirrors old tmux setup):
--   workspace (task unit, name = intent)            <- tmux session
--     window/tab                                    <- tmux window
--       pane                                        <- tmux pane
--
-- Status model:
--   * Every pane reports 'wsstate' = busy|idle via OSC 1337 SetUserVar:
--       - shells: shell/wsstate.sh (prompt hooks)
--       - pi agents: pi/extensions/wsstate.ts (agent_start/agent_end)
--     Unknown panes count as idle.
--   * Second axis 'wswait' = waiting|free (pi/extensions/agent-busy-tracker.ts):
--     agent is between turns but parked on a timer it set itself, so it will
--     wake without you. Idle-but-waiting must NOT read as "needs you".
--     Unknown/unset counts as free.
--   * State is POLLED from pane:get_user_vars() on the ~1s status tick.
--     Do NOT use the user-var-changed event: it only fires for panes
--     whose GUI window is focused — background workspaces never deliver
--     it, leaving stale state. The terminal layer stores the var for
--     every pane regardless, so polling is always correct.
--   * Aggregation is bottom-up: pane -> tab -> workspace.
--     Any idle pane anywhere in the workspace -> workspace idle.
--   * Tab-bar left: tabs of CURRENT workspace, each with own icon
--     (marks which window is idle). Tab-bar right: strip of ALL
--     workspaces with aggregate icon — the always-visible overview.
--
-- Keys:
--   Alt+W  workspace switcher (idle first, fuzzy)
--   Alt+N  new workspace (name = intent)
--   Alt+R  rename current workspace's intent
--   Alt+,  rename current window/tab (tmux muscle memory)
--
-- Deliberately no toasts/popups: status is passive, visible when you
-- choose to look, never interrupting current focus.

local wezterm = require 'wezterm'
local act = wezterm.action
local mux = wezterm.mux

-- Watch this module for changes: wezterm only auto-reloads on files in
-- the watch list, and require'd modules are not added automatically.
wezterm.add_to_config_reload_watch_list(wezterm.config_dir .. '/workspace-status.lua')

local M = {}

local ICON_IDLE, ICON_BUSY = '●', '○'

-- ── Per-pane state: poll the terminal layer ────────────────────
-- "idle" here means needs-you: not streaming AND not self-waking.
local function pane_is_idle(p)
  local ok, vars = pcall(function() return p:get_user_vars() end)
  if not (ok and vars) then return true end -- unknown pane counts as idle
  if vars.wsstate == 'busy' then return false end
  return vars.wswait ~= 'waiting'
end

-- ── Aggregation: pane -> tab -> workspace ──────────────────────
-- Idle if any pane is not busy (unknown = idle).
local function tab_is_idle(mux_tab)
  local panes = mux_tab:panes()
  if #panes == 0 then return true end
  for _, p in ipairs(panes) do
    if pane_is_idle(p) then return true end
  end
  return false
end

-- All mux windows belonging to a workspace; a workspace is idle if any
-- tab in any of its windows is idle.
local function workspace_is_idle(name)
  local found = false
  for _, win in ipairs(mux.all_windows()) do
    if win:get_workspace() == name then
      found = true
      for _, tab in ipairs(win:tabs()) do
        if tab_is_idle(tab) then return true end
      end
    end
  end
  -- Unknown/empty workspace: treat as idle (nothing running).
  return not found or false
end

local function tab_label(mux_tab)
  local title = mux_tab:get_title()
  if title == nil or title == '' then
    local p = mux_tab:panes()[1]
    title = p and p:get_title() or 'window'
  end
  return title
end

-- ── Workspace switcher: idle first ─────────────────────────────
local function switcher(window, pane)
  local idle_choices, busy_choices = {}, {}
  for _, name in ipairs(mux.get_workspace_names()) do
    local idle = workspace_is_idle(name)
    local entry = {
      id = name,
      label = string.format('%s  %s', idle and ICON_IDLE or ICON_BUSY, name),
    }
    if idle then table.insert(idle_choices, entry)
    else table.insert(busy_choices, entry) end
  end
  local choices = {}
  for _, c in ipairs(idle_choices) do table.insert(choices, c) end
  for _, c in ipairs(busy_choices) do table.insert(choices, c) end

  window:perform_action(
    act.InputSelector {
      title = 'workspaces  (● idle — needs you   ○ busy — cooking)',
      choices = choices,
      fuzzy = true,
      action = wezterm.action_callback(function(win, p, id)
        -- Selecting the current workspace must be a no-op: SwitchToWorkspace
        -- to the already-active workspace spawns a spurious new window.
        if id and id ~= win:active_workspace() then
          -- Defer: switching directly from the InputSelector callback races
          -- with the overlay closing and intermittently no-ops.
          wezterm.time.call_after(0.05, function()
            -- p is the (now closed) InputSelector overlay pane: using it
            -- raises 'pane id N is not valid'. Use the window's live pane.
            win:perform_action(act.SwitchToWorkspace { name = id }, win:active_pane())
          end)
        end
      end),
    },
    pane
  )
end

-- ── New workspace: intent is the workspace name ────────────────
local function new_workspace(window, pane)
  window:perform_action(
    act.PromptInputLine {
      description = 'intent (becomes workspace name)',
      action = wezterm.action_callback(function(win, p, intent)
        if not intent or intent == '' then return end
        win:perform_action(act.SwitchToWorkspace { name = intent }, p)
      end),
    },
    pane
  )
end

-- ── Rename current window/tab ───────────────────────────────
local function rename_window(window, pane)
  window:perform_action(
    act.PromptInputLine {
      description = 'new name for this window',
      action = wezterm.action_callback(function(win, _, line)
        if line and line ~= '' then
          win:active_tab():set_title(line)
        end
      end),
    },
    pane
  )
end

-- ── Rename current workspace (intent is mutable) ───────────────
local function relabel(window, pane)
  window:perform_action(
    act.PromptInputLine {
      description = 'new intent for this workspace',
      action = wezterm.action_callback(function(win, _, line)
        if not line or line == '' then return end
        if mux.rename_workspace then
          mux.rename_workspace(mux.get_active_workspace(), line)
        else
          wezterm.log_error('wsstate: mux.rename_workspace not available in this wezterm version')
        end
      end),
    },
    pane
  )
end

-- ── Wiring ─────────────────────────────────────────────────────
function M.apply(config)
  -- Tab bar doubles as status bar: left = windows of current workspace,
  -- right = all-workspace overview strip. Always on (the overview is the
  -- point); stays minimal/retro style.
  config.enable_tab_bar = true
  config.hide_tab_bar_if_only_one_tab = false
  config.use_fancy_tab_bar = false
  config.tab_max_width = 40
  -- Status/poll tick: 500ms for snappier icon flips (default 1s).
  -- Also drives apply_padding re-checks in wezterm.lua (no-op guarded).
  config.status_update_interval = 500

  config.keys = config.keys or {}
  table.insert(config.keys, { key = 'w', mods = 'ALT',
    action = wezterm.action_callback(switcher) })
  table.insert(config.keys, { key = 'n', mods = 'ALT',
    action = wezterm.action_callback(new_workspace) })
  table.insert(config.keys, { key = 'r', mods = 'ALT',
    action = wezterm.action_callback(relabel) })
  table.insert(config.keys, { key = ',', mods = 'ALT',
    action = wezterm.action_callback(rename_window) })

  -- Left: per-tab icon marks which window inside the workspace is idle.
  wezterm.on('format-tab-title', function(tab, tabs, panes, cfg, hover, max_width)
    local ok, result = pcall(function()
      local mux_win = mux.get_window(tab.window_id)
      for _, mt in ipairs(mux_win:tabs()) do
        if mt:tab_id() == tab.tab_id then
          local icon = tab_is_idle(mt) and ICON_IDLE or ICON_BUSY
          return string.format(' %s %s ', icon, tab_label(mt))
        end
      end
    end)
    if ok and result then return result end
    -- fall through to default title on any error
  end)

  -- Right: overview strip of ALL workspaces (current one bold + accent).
  wezterm.on('update-status', function(window, pane)
    local ok, err = pcall(function()
      local current = window:active_workspace()
      local fmt = {}
      for _, name in ipairs(mux.get_workspace_names()) do
        local icon = workspace_is_idle(name) and ICON_IDLE or ICON_BUSY
        if name == current then
          -- Active workspace: bold + accent color.
          table.insert(fmt, { Attribute = { Intensity = 'Bold' } })
          table.insert(fmt, { Foreground = { Color = '#b58900' } })
          table.insert(fmt, { Text = string.format(' %s %s ', icon, name) })
          table.insert(fmt, 'ResetAttributes')
        else
          table.insert(fmt, { Foreground = { Color = '#586e75' } })
          table.insert(fmt, { Text = string.format(' %s %s ', icon, name) })
        end
        table.insert(fmt, { Text = ' ' })
      end
      window:set_right_status(wezterm.format(fmt))
    end)
    if not ok then
      wezterm.log_error('wsstate status: ' .. tostring(err))
    end
  end)
end

return M
