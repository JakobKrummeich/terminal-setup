# terminal-setup

Complete terminal workstation config: **pi** (coding-agent TUI), **WezTerm**,
**tmux**, shell status hooks, plus the `rtk` token-filter binary. One clone +
one explicit installer for the target environment.

Design principle: **the terminal owns layout and orchestration; the TUI owns
content.** WezTerm owns centered reading columns, light/dark palette, workspaces,
and passive busy/idle overview. pi renders without injected whitespace cells
(`codeBlockIndent ""` + `markdown-no-padding` extension) so copied code is
byte-exact.

## Layout

```
pi/extensions/    pi TUI extensions (symlinked as ~/.pi/agent/extensions)
pi/skills/        agent skills (each dir symlinked into ~/.pi/agent/skills/;
                  per-skill links so non-repo skills can coexist there)
pi/settings.json  reference copy (copied on fresh install, never symlinked --
                  pi rewrites it at runtime)
pi/themes/        Solarized dark+light pi themes matching wezterm palette
                  (symlinked as ~/.pi/agent/themes; hot-reloaded on edit).
                  Switch via /settings -> Theme (auto-detect broken under
                  tmux -- see Known issues)
shell/wsstate.sh  shell prompt hooks: emit busy while a command runs, idle when
                  prompt returns (source from host/container shell rc files)
tmux/             tmux.conf + panecols.sh (symlinked); optional/legacy mux,
                  still syncs pane count to WezTerm centered columns
wezterm/          wezterm.lua + workspace-status.lua (symlinked on Linux;
                  Windows uses a stub that loads them from WSL). 75-col
                  centered column(s), Solarized Dark/Light, workspace overview.
install-terminal.sh  terminal installer: WezTerm, tmux, shell wsstate hook (no pi)
install-pi.sh     pi installer: pi config, rtk, shell wsstate hook (no WezTerm/tmux)
lib/              shared installer helpers
```

## Install terminal config (new Linux/WSL host)

```bash
git clone git@github.com:JakobKrummeich/terminal-setup.git ~/codingprojects/terminal-setup
~/codingprojects/terminal-setup/install-terminal.sh
```

This links WezTerm/tmux config and installs the shell `wsstate.sh` hook. It does
not install/link pi config or `rtk`.

## Install pi runtime (container or host)

Run where pi itself runs (commonly inside a container):

```bash
git clone git@github.com:JakobKrummeich/terminal-setup.git ~/codingprojects/terminal-setup
~/codingprojects/terminal-setup/install-pi.sh
```

This links pi extensions/themes/skills, copies pi settings if missing,
installs/links `rtk`, and installs the shell `wsstate.sh` hook. For pinned Pi
`0.83.0`, it also applies a version-and-hash-guarded Azure Responses hidden-error
retry workaround. Installer fails after a Pi upgrade until patch is reviewed or
removed. It does not install/link WezTerm or tmux.

Then install apps themselves if flagged:
- wezterm: https://wezterm.org/install/linux.html (apt repo)
- tmux: `sudo apt install tmux`
- pi: https://github.com/earendil-works/pi
- `~/.pi/agent/auth.json` (API keys) is per-machine and NEVER in this repo.

Shell busy/idle status is installed into `~/.bashrc` by both installers. For
the current shell, either restart it or source `shell/wsstate.sh` once.

## Install (Windows + WSL + Podman)

Target layout: **WezTerm renders on Windows and owns workspaces.** WSL runs the
shell and Podman. Containers run pi/codex. Prefer WezTerm workspaces/tabs/native
splits over an outer tmux session:

```
Windows WezTerm workspace -> WSL shell -> optional `podman exec -it <ctr> bash -l` -> pi/codex
```

Status/layout escape sequences pass through that chain to WezTerm. tmux remains
supported inside WSL when needed, but it is not the primary session/workspace
manager anymore.

1. **Windows: WezTerm** (skip if installed):
   ```powershell
   winget install wez.wezterm
   ```
2. **Windows: font** — install Ubuntu Sans Mono system-wide (wezterm uses
   Windows fonts): https://fonts.google.com/specimen/Ubuntu+Sans+Mono
   (download -> right-click `.ttf` -> Install for all users).
3. **WSL: clone + install**
   ```bash
   git clone git@github.com:JakobKrummeich/terminal-setup.git ~/codingprojects/terminal-setup
   ~/codingprojects/terminal-setup/install-terminal.sh   # wezterm/tmux links + shell wsstate hook
   sudo apt install tmux                         # optional, for legacy tmux panes
   ```
4. **Windows: stub config** `%USERPROFILE%\.wezterm.lua` — loads repo config
   out of WSL and boots straight into WSL. Adjust `Ubuntu` and `<user>`
   (`wsl -l`, `whoami` inside WSL):
   ```lua
   local wezterm = require 'wezterm'
   local repo = '//wsl$/Ubuntu/home/<user>/codingprojects/terminal-setup'
   package.path = repo .. '/wezterm/?.lua;' .. package.path
   wezterm.add_to_config_reload_watch_list(repo .. '/wezterm/wezterm.lua')
   wezterm.add_to_config_reload_watch_list(repo .. '/wezterm/workspace-status.lua')

   local config = dofile(repo .. '/wezterm/wezterm.lua')
   config.default_domain = 'WSL:Ubuntu'
   return config
   ```
5. **Inside containers running pi:** clone/mount this repo and run
   `install-pi.sh` so pi extensions and shell busy/idle status are installed:
   ```bash
   ~/codingprojects/terminal-setup/install-pi.sh
   ```
6. **Verify:** open WezTerm -> lands in WSL, Solarized Dark, centered 75-col
   column, tab bar visible. `Alt+N` -> enter workspace intent -> optional
   container name. `Alt+W` -> workspace switcher. `Alt+R` -> rename workspace.
   `Alt+,` -> rename current tab/window. `Alt+Shift+L` -> light mode.

### WezTerm workspace model

| level | meaning |
|---|---|
| WezTerm workspace | task/container/intent; shown in right status overview |
| WezTerm tab | window inside current workspace; shown on left tab bar |
| pane | shell/agent process; reports `wsstate=busy|idle` |

Icons: `●` = idle / needs you, `○` = busy / cooking. Unknown panes count as
idle. Status is polled from WezTerm pane user vars every 500ms; background
workspaces stay accurate because status does not rely on focused-pane events.

### How colors and status flow

Programs emit ANSI/OSC escape codes; WezTerm interprets them at the end of the
chain. Standard ANSI colors map to the Solarized palette, so anything inside
WSL/container using standard colors is Solarized, and `Alt+Shift+L` remaps live.

Busy/idle status uses OSC 1337 `SetUserVar=wsstate`:
- `pi/extensions/wsstate.ts`: `agent_start` -> busy, `agent_end` -> idle.
- `shell/wsstate.sh`: command preexec -> busy, prompt precmd -> idle.
- `wezterm/workspace-status.lua`: polls panes and aggregates pane -> tab -> workspace.

Caveats:
- Truecolor apps emit fixed RGB values that bypass the palette; accents may not
  adapt to light mode. Accepted.
- The stub's `dofile`/`require` over `\\wsl$` may not auto-reload reliably.
  Open a new WezTerm window after editing repo config if reload does not fire.
- If pi runs in a container inside tmux, `TMUX` is often not inherited by
  `podman exec`; raw OSC may be swallowed by tmux. Prefer direct WezTerm
  workspace -> WSL -> container launch. If keeping tmux in front, ensure tmux
  has `allow-passthrough on` and that the process emitting `wsstate` knows it is
  behind tmux (current scripts wrap only when `TMUX` is set).

If colors look degraded (8-color, wrong bg) inside a container:

1. `echo $TERM` inside the container — `podman exec` often sets bare `xterm`.
   Fix: `podman exec -it -e TERM=$TERM <ctr> bash -l`.
2. `infocmp tmux-256color` inside the container — if missing, install terminfo
   (`ncurses-term` on debian/ubuntu images) or use `-e TERM=xterm-256color` as
   fallback.
3. Truecolor check: `printf '\033[38;2;255;0;0mTRUECOLOR\033[0m\n'` — should
   render red, not approximated. tmux.conf sets the `Tc` override; pass
   `COLORTERM=truecolor` if an app checks it.

## Extensions

| file | purpose |
|---|---|
| `caveman-prompt.ts` | terse response style system prompt |
| `context-cap.ts` | auto token-cap handoff: at 160k the agent writes a handoff file (`~/.pi/agent/context-cap/<sessionId>-<seq>.md`), then a persistent swap-marker entry is appended and a `context` handler slices the LLM context at it — the next LLM call sees only the handoff (session ≠ context: full history + forensic swap metadata stay in the session file); 200k hard backstop with stale-file fallback |
| `custom-footer.ts` | cumulative token/cost footer |
| `dump-system-prompt.ts` | debug: dump active system prompt |
| `handoff.ts` | session handoff summaries |
| `markdown-no-padding.ts` | strip paddingX=1 from rendered markdown (copy-safety); patches pi-tui internals — re-verify after `pi update` |
| `rtk.ts` / `rtk-tools.ts` | route tool calls through rtk token filter |
| `subagent.ts` | `Agent` tool: delegate a task to a child agent session, capped at one layer deep. Press **F2** to watch the running child live in the normal TUI style, `Esc` to step back out (override the key with `PI_SUBAGENT_WATCH_KEY`) |
| `timer.ts` | one-shot wakeup timer tool for long background tasks |
| `wsstate.ts` | report pi agent busy/idle to WezTerm workspace status via OSC 1337 |

### Subagents (`subagent.ts`)

The main agent delegates via the `Agent` tool and keeps the overview; the child is an
ordinary pi session in the same cwd with the same system prompt, AGENTS.md, extensions
and skills — it is not told it is a subagent. The one difference is that it has no `Agent`
tool itself: every child is built with `excludeTools: ["Agent"]`, which is what caps
nesting at one layer (structural, not a counter — nothing to configure).

- Runs in the foreground: the main agent waits, and the tool row shows live child status
  (`agent#<id> · <description> · turn N · running grep`).
- **F2** opens the child's live conversation, `Esc` returns. The child keeps running either
  way. The key is one constant in the file plus the `PI_SUBAGENT_WATCH_KEY` env override.
- Child sessions are persisted (named `agent#<id>`), so a finished run can be reopened from
  the session picker and audited.
- A child that needs a decision just asks; the main agent answers by calling `Agent` again
  with `resume_id`, continuing the same session. It stands in for the human.
- No background runs, no parallelism, no agent types, no turn limits — deliberately.

## Known issues

- wezterm#6785: non-integer `line_height` x certain `font_size` combos cause
  vertical glyph jitter (stable AND nightly). At 16pt use `line_height 1.25`
  (integer cell height). Re-test when changing font size.
- Long lines in pi are hard-wrapped at render width; screen-copy injects
  newlines. Use pi's built-in `/copy` (raw session text) for exact bytes.
- pi auto light/dark theme detection (`"solarized-light/solarized-dark"`) does
  NOT work under tmux: pi's OSC 11 bg query is answered by tmux, which never
  learns wezterm's bg (`client_bg` empty; cached at attach anyway, so
  `Alt+Shift+L` mid-session would be stale regardless). pi falls back to the
  dark half = fine default. Switch pi manually: `/settings` -> Theme.
  Decoupled on purpose; rejected auto-sync (theme-file swap + watcher
  hot-reload) as overkill for rare toggling.
- Mixed monitor refresh rates (e.g. 144Hz + 60Hz) on GNOME Wayland + NVIDIA
  proprietary cause frame-pacing glitches in all apps: flickering/delayed
  keystrokes, cursor stutter (worse under tmux — more redraws). Fix: match
  refresh rates in Settings -> Displays (both 60Hz here). Related: Ubuntu
  24.04's Xwayland 23.2.6 lacks explicit sync (needs 24.1+) — caused
  flicker on NVIDIA even with matched rates. Fixed by running wezterm
  native Wayland (`enable_wayland = true`, mutter's explicit-sync path);
  costs slight input lag vs XWayland — accepted. If lag worsens on
  wezterm/driver upgrades, retest `enable_wayland = false`.
- Pane sync (implemented): tmux hooks -> panecols.sh -> OSC 1337 SetUserVar
  -> wezterm user-var-changed -> padding fits N centered 75-col columns
  (zoom = 1 column). Known transient: brief jumbled frame on split/zoom --
  tmux re-lays before wezterm widens; inherent to dual layout engines. Accepted.
- WezTerm workspace status through tmux requires OSC passthrough. Direct
  WezTerm->WSL/container chains are simplest; nested `podman exec` behind tmux
  needs the emitting process to know tmux is in front (`TMUX` set) so it wraps
  OSC in tmux DCS passthrough.
