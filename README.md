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
pi/extensions/test/  extension tests: real AgentSession + scripted fake LLM
                  (`./pi/extensions/test/run.sh`)
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
docs/             specs + setup notes (agent-dashboard-spec.md, explorer-setup.md)
docs/decisions/   why things are the way they are, incl. what was removed again
```

Tooling experiments (A/B runs measuring whether a tool earns its keep) live in a separate
repository, `~/agent-experiments` — they are not configuration and cost money to run. The
`Explorer` extension was removed after one such experiment: `docs/decisions/explorer-removed.md`.

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
installs/links `rtk`, and installs the shell `wsstate.sh` hook. For Pi
`0.83.0`, `0.84.1`, and `0.84.2`, it also applies a version-and-hash-guarded
Azure Responses hidden-error retry workaround. Installer fails after a Pi upgrade until patch is
reviewed or removed. It does not install/link WezTerm or tmux.

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
| `agent-busy-tracker.ts` | second status axis on top of wsstate, reported via OSC 1337 SetUserVar: `wswait=waiting\|free` — is the agent parked between turns but able to wake itself (armed timer)? wsstate correctly says idle then, but the workspace must not show "needs you". Deliberately standalone: detects timers via the timer tool's public contract — args harvested at `tool_execution_start`, verdict at `tool_execution_end`, joined by `toolCallId` (pi's end event carries no args) — knows nothing of `timer.ts`/`wsstate.ts` internals; aggregation lives in `wezterm/workspace-status.lua`. Arms only under `ctx.mode === "tui"` (elsewhere timer blocks inside the call, so nothing stays armed) and, like wsstate, registers nothing in child sessions |
| `agent-dash.ts` | agent dashboard (`docs/agent-dashboard-spec.md`): writes the main session's `session-start` rows into the per-project `agent-runs.jsonl` index (spawn/progress/finish rows come from `lib/child-session.ts`, reset from `context-cap.ts`) and auto-starts the dashboard HTTP server (`lib/dashboard-server.ts`) on `0.0.0.0`, port `PI_AGENT_DASH_PORT` or 7357. One server per port per machine — when another pi instance already bound it, this one only prints the URL. Opt out with `PI_AGENT_DASH_DISABLE`; never starts under `PI_OFFLINE` (test suite) |
| `caveman-prompt.ts` | terse response style system prompt |
| `context-cap.ts` | auto token-cap handoff: at the soft cap the agent writes a handoff file (`~/.pi/agent/context-cap/<sessionId>-<seq>.md`), then a persistent swap-marker entry is appended and a `context` handler slices the LLM context at it — the next LLM call sees only the handoff (session ≠ context: full history + forensic swap metadata stay in the session file). The same handler makes stale cap warnings structurally invisible instead of asking the model to self-judge: `[context-cap]` user messages behind the latest marker (swapped-away cycle, reachable only via the tail lever) or present while no cycle is armed (stranded late delivery — pi's queues can deliver a steer after an errored run, into a fresh window) are scrubbed from the LLM view, so no warning carries an "ignore me if stale" clause; at the hard cap a backstop fires: if the agent never wrote one, the extension spends one standalone LLM call writing the handoff itself (author recorded in the frontmatter), falling back to the stale file, then to a no-context note. Both caps are **model-aware and re-resolved on every check** (no model-switch event exists, and the model can change mid-session): they must fire before pi's own compaction at `contextWindow - 16384`, so `hard = min(325k, 0.90 × (contextWindow - reserve))`, where `reserve` is pi's own `compaction.reserveTokens` read from its live settings (default 16384, override `CONTEXT_CAP_RESERVE`) and `soft = min(260k, 0.80 × hard)` — 260k/325k are ceilings, reached only from ~400k of window up; a 200k-window model gets 132k/165k. `CONTEXT_CAP_SOFT` / `CONTEXT_CAP_HARD` override a value outright (the other stays dynamic); unknown window falls back to the last one seen, then to the static 260k/325k; a window too small to hold a cap below pi's reserve disables the extension instead of swapping at a nonsense threshold. The same writer answers pi's own compaction (`session_before_compact`) with a handoff-shaped summary — disable with `CONTEXT_CAP_COMPACT_HANDOFF=0`. Two A/B levers: `CONTEXT_CAP_SCHEMA=v1\|v2` (default `v2`, the path-heavy schema whose `## Files` section names every path that still matters) and `CONTEXT_CAP_TAIL_TOKENS=N` (default 0; keeps ~N tokens of raw transcript, cut only at complete turns, in front of the handoff). Levers and caps alike are recorded in the marker details and the file frontmatter (`schema`, `tailTokens`, `tailKeptTokens`, `contextWindow`, `softCap`, `hardCap`, `capSource`) |
| `custom-footer.ts` | cumulative token/cost footer |
| `dump-system-prompt.ts` | debug: dump active system prompt |
| `explore.ts` | `Explore` tool: delegate readonly exploration ("where is X", "how does Y work") to a cheap child agent that only gets `read`/`grep`/`find`/`ls` (plus `context_handoff`) — no bash, edit or write, structurally. Available to the main agent *and* to subagents; explorers have their own busy group, so a subagent can explore while its `Agent` call runs. Up to `PI_EXPLORER_PARALLEL` explorers (default 3) run concurrently — several `Explore` calls in one assistant message fan out in parallel. Model via `PI_EXPLORER_MODEL` (`provider/modelId`), else first matching candidate from local `explorer-models.json`, else the parent's model; thinking via `PI_EXPLORER_THINKING` (default `low`); missing model config shows a TUI warning. Configure per environment; see `docs/explorer-setup.md` |
| `lib/child-session.ts` | shared child-session plumbing for `subagent.ts` and `explore.ts` (not an extension: pi's loader only scans top-level `*.ts`) |
| `lib/pending-work.ts` | cross-extension "this session is not finished yet" claims (globalThis-backed, because pi loads every extension file with its own jiti instance and `moduleCache: false`). Claims can carry a `cancel` callback; `cancelPendingWork()` disarms and clears everything for a session. `timer.ts` is currently the only producer — and only in interactive mode, where it arms a wake-up that outlives the run |
| `lib/session-quiet.ts` | `waitForSessionQuiet()`: the definition of "child is done" — agent idle *and* no queued steer/follow-up messages (bounded grace) *and* no pending-work claims |
| `handoff.ts` | `/handoff` command: the agent writes a handoff document as a normal reply (same schema + line budget as context-cap — both quote `lib/handoff-writer.ts`, so the `CONTEXT_CAP_SCHEMA` lever governs both), then a fresh session is seeded with it under the same preamble as a cap swap — but with `triggerTurn: false`: the successor waits for the user instead of continuing on its own |
| `markdown-no-padding.ts` | strip paddingX=1 from rendered markdown (copy-safety); patches pi-tui internals — re-verify after `pi update` |
| `rtk.ts` / `rtk-tools.ts` | route tool calls through rtk token filter |
| `subagent.ts` | `Agent` tool: delegate a task to a child agent session, capped at one layer deep. Press **F2** to watch the running child live in the normal TUI style, `Esc` to step back out (override the key with `PI_SUBAGENT_WATCH_KEY`) |
| `timer.ts` | wait tool for long background tasks — main session only: child sessions are always headless (`bindExtensions({})` → mode `print`), where a timer could only block inside the tool call, which buys nothing over `bash sleep N` — so the extension registers nothing in children (bind-time `inChildSession()` guard) and a child's prompt never offers the tool. In the main session, two strategies picked from `ctx.mode` (the per-call result text says which one ran — the registered description can't, it is written before any mode is known). **Interactive (`tui`)**: one-shot wakeup timer — the agent ends its turn and the expiry is injected with `deliverAs: "steer"` so it lands at the next turn boundary; `"followUp"` only lands when the whole run ends, which stacked stale wake-ups during long runs (regression-tested). An armed timer claims pending work so a child session isn't reported as finished while it waits; the claim is released on evidence the wake-up run started (not on a guess), and a wake-up stranded by the settle race is re-sent (up to 3×) instead of lost. **Headless (`print`/`json`/`rpc`, and any unknown mode — fail-safe)**: the tool call itself blocks for the wait and returns "continue your task", never "end your turn". `pi -p` awaits a single `session.prompt()` and disposes the runtime right after, so a timer armed for after the turn wakes nothing and the run exits 0 mid-task; blocking keeps the run — and the process — alive. The requested duration is honoured in full — an hour is one call, one result: chopping it into re-callable chunks would bill a whole LLM round-trip at full context per chunk, and nothing in pi times a tool call out (`pi-agent-core` `dist/agent-loop.js:453` awaits `tool.execute()` bare). Instead the call reports progress on the `onUpdate` channel ("Ns elapsed, Ms remaining", ~20 ticks spread over the wait, floor 30s / ceiling 5min) so it never looks frozen, and aborting the tool call ends the wait at once. `PI_TIMER_MAX_WAIT_S` opts into a cap (unset/0 = none): a longer request then returns after the cap with how much time is left and asks to be called again |
| `wsstate.ts` | report pi agent busy/idle to WezTerm workspace status via OSC 1337. Main session only: child sessions (Agent/Explore) load this file too but share the parent's stdout — a child's `agent_end` would flip the terminal to "idle" mid-parent-run, so children register nothing (`inChildSession()` guard at bind time) |

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
- The watch view uses pi's own message and tool components, so a child's `bash`, `edit` etc.
  look exactly like they do in the main session. It scrolls with `↑`/`↓`, `PgUp`/`PgDn`,
  `Home`/`End` (keyboard only — pi never enables mouse tracking), follows the tail until you
  scroll away, and `Ctrl+O` expands tool output. Being an overlay, it leaves no residue in
  the main transcript on `Esc`.
- Child sessions are persisted (named `agent#<id>`), so a finished run can be reopened from
  the session picker and audited.
- A child that needs a decision just asks; the main agent answers by calling `Agent` again
  with `resume_id`, continuing the same session. It stands in for the human.
- One child at a time: a second `Agent` call while one runs is rejected with an error result
  (`childBusy`, set synchronously before the first `await`, so two calls in one assistant
  message can't both pass). The latch is released only once the child is actually quiet
  again — after an abort the child may still be draining, so release happens in the
  background, not in the tool's `finally`. Parallel children shared one worktree and one
  watch slot, and nothing here was verified under concurrency.
- Done ≠ "the run ended". Anything that restarts a session from the outside (the classic
  case: a `timer` wake-up) used to end the parent's tool call while the child was still
  waiting. The `Agent` tool returns only when the child is quiet (`lib/session-quiet.ts`):
  idle, empty message queue, and no pending-work claims. Claims self-expire, so a lost
  wake-up delays the result instead of hanging it. `context_handoff` needs no claim — its
  whole restart cycle runs inside the child's `prompt()` call (regression-tested). Children
  have no `timer` tool at all (`timer.ts` registers nothing there — see the extensions
  table); a child that must wait uses `bash sleep`, which blocks its run the same way a
  blocking timer would have.
- No background runs, no parallelism, no agent types, no turn limits — deliberately.
- Explorers (`explore.ts`) are the readonly counterpart: same plumbing, same watch view,
  but a readonly tool allowlist and a separate busy group. Unlike agents they run in
  parallel — explorers are readonly, so the shared-worktree rationale does not apply. Up
  to `PI_EXPLORER_PARALLEL` (default 3; integer ≥ 1, invalid values fall back to 3) run
  concurrently; calls beyond the limit are rejected like a busy agent. With several
  children running, repeated **F2** presses cycle through them. Configure the model with
  `PI_EXPLORER_MODEL=provider/modelId` (split on the first slash — model ids may contain
  slashes) and `PI_EXPLORER_THINKING=off|minimal|low|medium|high|xhigh|max` (default `low`).
  For per-machine setup, create `~/.pi/agent/extensions/explorer-models.json`
  (`{ "candidates": ["provider/modelId", ...] }`) or set `PI_EXPLORER_MODEL`.
  Do not commit this file: providers and credentials differ by environment. The first
  candidate present in local model registry wins; this is selection, not request-failure
  failover. Precedence: env var → local candidates → parent model. Missing or broken
  config warns in both TUI and tool result. See `docs/explorer-setup.md`.

## Tests

```bash
./pi/extensions/test/run.sh          # all extension tests
./pi/extensions/test/run.sh --test-name-pattern=timer
cd pi/extensions/test && npx -y -p typescript tsc -p .   # typecheck (run run.sh once first: it builds the node_modules symlink farm)
```

`node --test` with on-the-fly type transform (node >= 22), no build step. Tests drive a real
pi `AgentSession` with `session.agent.streamFunction` replaced by a scripted fake
LLM (`test/harness.ts`) — no network, no API key, real agent loop and real
steering/follow-up queues. The runner creates a gitignored `test/node_modules`
symlink farm into the installed pi, because Node's ESM resolver ignores
`NODE_PATH`.

`test/` is NOT loaded as an extension: pi discovers `extensions/*.ts` plus
subdirs that have `index.ts`/`index.js` or a `package.json` with a `pi` field
(one level, no recursion) — same reason `lib/` is inert. Never add any of those
three files to `test/` or `lib/`.

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
- WezTerm workspace status through tmux requires OSC passthrough, and tmux
  drops it silently in three cases — each leaves the marker latched on the last
  value that got out (usually `busy`, emitted by the shell preexec of `ssh` /
  `tmux attach` / `pi`, since nothing ever re-syncs):
  1. `allow-passthrough` unset — **tmux's default is `off`** (3.3+). A host that
     only ran `install-pi.sh` has no `tmux/tmux.conf` link, so every wrapped
     `wsstate` from inside tmux is eaten and the workspace shows busy forever.
     `tmux show -g allow-passthrough` to check; `tmux set -g allow-passthrough
     all` applies live, no server restart.
  2. Pane not visible — with `on`, tmux passes through only for the current
     window of an attached session, so an agent cooking in a background tmux
     window never reports. Use `all` (repo tmux.conf still ships the safer `on`;
     `all` widens the escape-injection surface to invisible panes, worth it on
     a machine whose output you trust).
  3. Client detached — nothing is buffered or replayed. On reattach the WezTerm
     pane is new and has no user var, so the workspace reads *idle* even if the
     agent is mid-turn, until pi's next state change. No re-emit hook exists
     (tmux's `client-attached` only drives panecols).
  Independently: nested `podman exec` behind tmux needs the emitting process to
  know tmux is in front (`TMUX` set) so it wraps OSC in tmux DCS passthrough;
  `podman exec` does not inherit `TMUX`, so the raw OSC gets swallowed. Direct
  WezTerm->WSL/container chains avoid all of this.
