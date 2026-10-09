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
                  (`./pi/extensions/test/run.sh`); quality gate
                  `./pi/extensions/test/check.sh` (pinned tools in test/tools/)
pi/skills/        agent skills (each dir symlinked into ~/.pi/agent/skills/;
                  per-skill links so non-repo skills can coexist there)
pi/settings.json  reference copy (copied on fresh install, never symlinked --
                  pi rewrites it at runtime). Pins `"tuiMode": "regular"`:
                  pi >= 1.0 defaults to fullscreen, which takes the transcript
                  out of wezterm/tmux scrollback and owns the mouse (existing
                  installs: add it to ~/.pi/agent/settings.json by hand)
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
install-pi.sh     pi installer: pi config, pi-dash daemon, rtk, shell wsstate
                  hook (no WezTerm/tmux)
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
installs + starts the `pi-dash` dashboard daemon as a systemd user unit
(skipped with a warning where systemd/user-bus is unavailable — see “Agent
dashboard” below), installs/links `rtk` (pinned release, SHA-256-verified — see
“Bumping rtk”), and installs the shell `wsstate.sh`
hook. It never modifies the Pi install itself. It does not install/link WezTerm or tmux.

Run `install-pi.sh` as your normal user, **never with `sudo`**: everything it installs is
per-user (`~/.pi`, `systemd --user`, `~/.bashrc`); under `sudo` it warns that those steps act as
root.

**Minimum supported pi: 1.0.1** (`PI_MIN_VERSION` in `lib/install-common.sh`). The
extensions draw their compact tool-call rows through `pi.registerToolRenderer()`
(new in 1.0.1 — on older pi, explore/subagent/timer/context-cap fail to load), on top
of earlier extension APIs (e.g. actionable `turn_end` boundary results, transcript
system messages), and carry no fallbacks for older pi; `install-pi.sh` prints a
warning — without blocking — when the installed pi is older.

Then install apps themselves if flagged:
- wezterm: https://wezterm.org/install/linux.html (apt repo)
- tmux: `sudo apt install tmux`
- pi: https://github.com/earendil-works/pi
- `~/.pi/agent/auth.json` (API keys) is per-machine and NEVER in this repo.

Shell busy/idle status is installed into `~/.bashrc` by both installers. For
the current shell, either restart it or source `shell/wsstate.sh` once. If
`~/.bashrc` has the `# >>> terminal-setup wsstate >>>` begin marker but no
`# <<< terminal-setup wsstate <<<` end marker, the installer leaves the file
untouched and prints a `WARN:` — fix the block by hand and rerun.

### Bumping rtk

`install_rtk` (`lib/install-common.sh`) downloads one pinned release —
`RTK_VERSION` — and checks the asset against the SHA-256 in `rtk_asset_sha256`
before extracting; a mismatch (or a missing hash) fails closed and installs
nothing. An `rtk` already on `PATH` is only linked, never replaced — also when
`PATH` finds it through the installer's own `~/.pi/agent/bin/rtk` link (the link
target counts; a dangling link is reinstalled). A version other than the pin is
reported as a `NOTE:`. To bump:

1. Set `RTK_VERSION` to the new release (without the `v`).
2. Take the four asset hashes from that release's `checksums.txt`
   (`https://github.com/rtk-ai/rtk/releases/download/v<version>/checksums.txt`) and
   replace every entry in `rtk_asset_sha256`. Check the asset names in
   `rtk_asset_name` still exist in the release.
3. Run `bash test/rtk-release-resolution.test.sh`; to install it here, remove the old
   `~/.local/bin/rtk` and re-run `install-pi.sh`.

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
| pane | shell/agent process; reports `wsstate` (shell `busy|idle`, pi also `blocked|waiting`) |

Icons: `●` = idle / needs you, `○` = busy / cooking. A pi pane counts as busy
while `busy` or `waiting` (parked on its own timer), as idle while `idle` or
`blocked` (a dialog waits for you). Unknown panes count as idle. Status is polled from WezTerm pane user vars every 500ms; background
workspaces stay accurate because status does not rely on focused-pane events.

### How colors and status flow

Programs emit ANSI/OSC escape codes; WezTerm interprets them at the end of the
chain. Standard ANSI colors map to the Solarized palette, so anything inside
WSL/container using standard colors is Solarized, and `Alt+Shift+L` remaps live.

Busy/idle status uses OSC 1337 `SetUserVar=wsstate`:
- `pi/extensions/wsstate.ts`: `agent_start` -> busy, `agent_settled` -> idle,
  or waiting while parked on an armed timer until its wake run; an open dialog -> blocked.
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
| `agent-dash.ts` | agent dashboard (`docs/agent-dashboard-spec.md`, “Agent dashboard” below): writes the main session's `session-start` rows into the per-project `agent-runs.jsonl` index (spawn/progress/finish rows come from `lib/child-runs.ts`, reset from `context-cap.ts`) and probes the machine-global dashboard daemon (`GET /api/meta`, ~1s, once per process): daemon up → notifies its URL + hostname, down → “re-run install-pi.sh”; a daemon running stale code of this checkout (its `/api/meta` `codeHash` ≠ the checkout on disk, e.g. after `git pull`) is restarted via `systemctl --user try-restart pi-dash.service`. pi itself never serves the dashboard. Opt out with `PI_AGENT_DASH_DISABLE`; never probes under `PI_OFFLINE` (test suite) |
| `builtin-tools.ts` | register pi's builtin `grep`/`find`/`ls` tools (rg/fd-backed, output-capped) — pi's default toolset is read/bash/edit/write only, and the pi-native `defaultTools` setting lives in the pi-owned `settings.json` the repo can't manage. Loaded by children too; re-registering a builtin is a same-behavior override, so no child guard |
| `caveman-prompt.ts` | terse response style system prompt |
| `context-cap.ts` | auto token-cap handoff: at the soft cap the agent writes a handoff file (`~/.pi/agent/context-cap/<sessionId>-<seq>.md`; `$PI_CODING_AGENT_DIR/context-cap/` when set), then a persistent swap-marker entry is appended and a `context` handler slices the LLM context at it — the next LLM call sees only the handoff (session ≠ context: full history + forensic swap metadata stay in the session file). The same handler makes stale cap warnings structurally invisible instead of asking the model to self-judge: `[context-cap]` user messages behind the latest marker (swapped-away cycle, reachable only via the tail lever) or present while no cycle is armed (stranded late delivery — pi's queues can deliver a steer after an errored run, into a fresh window) are scrubbed from the LLM view, so no warning carries an "ignore me if stale" clause; at the hard cap a backstop fires: if the agent never wrote one, the extension spends one standalone LLM call writing the handoff itself (author recorded in the frontmatter), falling back to the stale file, then to a no-context note. Both caps are **model-aware and re-resolved on every check** (no model-switch event exists, and the model can change mid-session): they must fire before pi's own compaction at `contextWindow - 16384`, so `hard = min(325k, 0.90 × (contextWindow - reserve))`, where `reserve` is pi's own `compaction.reserveTokens` read from its live settings (default 16384, override `CONTEXT_CAP_RESERVE`) and `soft = min(260k, 0.80 × hard)` — 260k/325k are ceilings, reached only from ~400k of window up; a 200k-window model gets 132k/165k. `CONTEXT_CAP_SOFT` / `CONTEXT_CAP_HARD` override a value outright (the other stays dynamic); unknown window falls back to the last one seen, then to the static 260k/325k; a window too small to hold a cap below pi's reserve disables the extension instead of swapping at a nonsense threshold. The same writer answers pi's own compaction (`session_before_compact`) with a handoff-shaped summary — disable with `CONTEXT_CAP_COMPACT_HANDOFF=0`. Two A/B levers: `CONTEXT_CAP_SCHEMA=v1\|v2` (default `v2`, the path-heavy schema whose `## Files` section names every path that still matters) and `CONTEXT_CAP_TAIL_TOKENS=N` (default 0; keeps ~N tokens of raw transcript, cut only at complete turns, in front of the handoff). Levers and caps alike are recorded in the marker details and the file frontmatter (`schema`, `tailTokens`, `tailKeptTokens`, `contextWindow`, `softCap`, `hardCap`, `capSource`) |
| `custom-footer.ts` | cumulative token/cost footer (layout in `lib/footer.ts`, shared with the F2 child view) |
| `dump-system-prompt.ts` | debug: dump active system prompt |
| `explore.ts` | `Explore` tool: delegate readonly exploration ("where is X", "how does Y work") to a cheap child agent that only gets `read`/`grep`/`find`/`ls` (plus `context_handoff`) — no bash, edit or write, structurally. Available to the main agent *and* to subagents; explorers have their own busy group, so a subagent can explore while its `Agent` call runs. Up to `PI_EXPLORER_PARALLEL` explorers (default 3) run concurrently — several `Explore` calls in one assistant message fan out in parallel. Model via `PI_EXPLORER_MODEL` (`provider/modelId`), else first matching candidate from local `explorer-models.json`, else the parent's model; thinking via `PI_EXPLORER_THINKING` (default `low`); missing model config shows a TUI warning. Configure per environment; see `docs/explorer-setup.md` |
| `lib/child-session.ts` | shared child-session plumbing for `subagent.ts` and `explore.ts`: `runChildTool` (spawn or resume a child, run one prompt, report back), the shared state (`liveChildren` registry, eviction tombstones, busy groups) (not an extension: pi's loader only scans top-level `*.ts`) |
| `lib/child-types.ts` | type-only: `ChildRecord`, `ChildSource`, `ChildRegistry`, `RunChildOptions`, … — shared by the child-session modules without import cycles |
| `lib/child-create.ts` | `createChildSession`: a child's `AgentSession`, fresh or reopened from its file — parent's model runtime, `PI_CHILD_EXTENSIONS` loader, child-context scope |
| `lib/child-reopen.ts` | eviction of finished children beyond the cap and reopening an evicted / pre-restart child from its session file (`resume_id`) |
| `lib/child-runs.ts` | a child run's `agent-runs.jsonl` spawn/progress/finish rows and its meta/status text (`collectMeta`, `metaLine`, `statusLine`) |
| `lib/child-busy.ts` | the busy-group semaphore (one Agent at a time, N explorers), incl. the wind-down of a still-settling child |
| `lib/child-context.ts` | `inChildSession()` / `childSessionInfo()`: the AsyncLocalStorage scope a child's extensions load and bind in — split out so child-guarded extensions (`wsstate.ts`, `timer.ts`, …) don't import all of `lib/child-session.ts` |
| `lib/child-watch.ts` | the F2 watch overlay: child picker, per-child view with its own footer, watch cursor (`watchTarget`/`nextChild`/`prevChild`) |
| `lib/git-branch.ts` | `gitBranch`: the F2 child footer's branch, found like pi's own footer (nearest `.git` at or above cwd; relative `gitdir:` pointers resolved against the `.git` file's dir) |
| `lib/watch-viewport.ts` | the F2 view's pure chrome: `WatchViewport` scroll state, header/hint/position text, handoff-jump math, SGR wheel decoding, `WATCH_KEY`/`EXPAND_KEY` |
| `lib/alt-screen.ts` | F2 watch terminal modes, both main-screen (`tuiMode: "regular"`) only: `enterAltScreenWatch` moves the overlay onto the terminal's alternate screen via pi-tui's internal render-state API (re-verify after `pi update`); `enterWatchMouse` turns on SGR wheel reporting — never under fullscreen pi, whose own mouse tracking the reset would wipe |
| `lib/child-view.ts` | `ChildView`: one child's transcript as the F2 watch view renders it (live events and replay of a reopened child), with a `⇄ handoff i/N` divider before each context-cap swap marker |
| `lib/context-cap-decide.ts` | `context-cap.ts`'s state machine, pure half: the per-cycle `CycleState` (lifecycle documented on the type) and the `decideMessageEnd` / `decideTurnGate` / `decideTurnEnd` functions the handlers call before running the chosen action's side effects; each branch is one row in `test/context-cap-decisions.test.ts`, the effect order is pinned by `test/context-cap-effects.test.ts` |
| `lib/context-cap-session.ts` | `CapSession`: one `context-cap.ts` instance's state (cycle, cap resolver, last LLM-visible context) plus the helpers every effect path shares (status footer, cycle arming, cap stamping, handoff file write); passed explicitly to the `context-cap-*` modules below — no module state |
| `lib/context-cap-view.ts` | the `context` handler's pure half: the `[context-cap]` scrub key (`isCapWarning`), the token estimate, the pairing-safe recency-tail cut (`selectContextTail`) and `llmView` |
| `lib/context-cap-messages.ts` | the agent-facing cap warnings: soft steer, silent-stop prompt, one-jump emergency steer, reminder |
| `lib/context-cap-tool.ts` | the `context_handoff` tool: writes the agent's handoff host-side |
| `lib/context-cap-swap.ts` | `stageSwap` (build the swap marker) and `commitStagedSwap` (append it at the turn_end boundary, report the reset) |
| `lib/context-cap-hard.ts` | the hard-cap backstop `hardCap`: fresh agent handoff → machine-drafted one → stale file → no summary |
| `lib/context-cap-compact.ts` | the `session_before_compact` hook: pi's own compaction summarized as a handoff |
| `lib/context-cap-files.ts` | handoff files `<sessionId>-<seq>.md`: seq/paths, frontmatter write and strip |
| `lib/context-cap-resolver.ts` | `createCapResolver`: per-session cap resolution (last known window, warn-once) |
| `lib/format.ts` | `formatTokenCount()` (`950`, `162k`, `1.0M`; a disabled cap shows `off`) and `formatCapStatus()` (`<tokens>/<soft cap>`): the one token format for the main footer (`context-cap.ts`) and the F2 watch |
| `lib/tool-call-render.ts` | compact call rows (bold title + one short muted summary: description label, timer action, handoff line count) for `Explore`, `Agent`, `timer` and `context_handoff` — without one, pi prints every argument as `key=value`, i.e. the whole prompt / handoff. Registered via `pi.registerToolRenderer()` (`registerCompactCallRenderer`), not as the tools' `renderCall`, so calls to an unregistered tool keep the row too (resumed session, `PI_EXPLORE_DISABLE`/`PI_SUBAGENT_DISABLE` — the one registration that precedes those kill switches); only fills in a `renderCall` nothing else provides. The F2 view (`lib/child-view.ts`) resolves through the child session's resolvers the same way |
| `lib/session-quiet.ts` | `waitForSessionQuiet()`: the definition of "child is done" — agent idle *and* no queued steer/follow-up messages (bounded ~2s grace for a queued run about to start) |
| `handoff.ts` | `/handoff` command: the agent writes a handoff document as a normal reply (same schema + line budget as context-cap — both quote `lib/handoff-writer.ts`, so the `CONTEXT_CAP_SCHEMA` lever governs both), then a fresh session is seeded with it under the same preamble as a cap swap — but with `triggerTurn: false`: the successor waits for the user instead of continuing on its own |
| `markdown-no-padding.ts` | strip paddingX=1 from rendered markdown (copy-safety); patches pi-tui internals — re-verify after `pi update` |
| `rtk.ts` | rewrite bash commands through rtk token filter (grep/find/ls tool overrides were dropped — pi builtins already cap output; see git history of `rtk-tools.ts`) |
| `subagent.ts` | `Agent` tool: delegate a task to a child agent session, capped at one layer deep. Press **F2** to watch the running child live in the normal TUI style, `Esc` to step back out (override the key with `PI_SUBAGENT_WATCH_KEY`) |
| `timer.ts` | wait tool for long background tasks — main session only: child sessions are always headless (`bindExtensions({})` → mode `print`), where a timer could only block inside the tool call, which buys nothing over `bash sleep N` — so the extension registers nothing in children (bind-time `inChildSession()` guard) and a child's prompt never offers the tool. In the main session, two strategies picked from `ctx.mode` (the per-call result text says which one ran — the registered description can't, it is written before any mode is known). **Interactive (`tui`)**: one-shot wakeup timer — the agent ends its turn and the expiry is injected with `deliverAs: "steer"` so it lands at the next turn boundary; `"followUp"` only lands when the whole run ends, which stacked stale wake-ups during long runs (regression-tested). A wake-up stranded by the settle race (expiry fired after the run's final queue drain) is detected by watching for its delivery and re-sent (up to 3×) instead of lost. **Headless (`print`/`json`/`rpc`, and any unknown mode — fail-safe)**: the tool call itself blocks for the wait and returns "continue your task", never "end your turn". `pi -p` awaits a single `session.prompt()` and disposes the runtime right after, so a timer armed for after the turn wakes nothing and the run exits 0 mid-task; blocking keeps the run — and the process — alive. The requested duration is honoured in full — an hour is one call, one result: chopping it into re-callable chunks would bill a whole LLM round-trip at full context per chunk, and nothing in pi times a tool call out (`pi-agent-core` `dist/agent-loop.js:453` awaits `tool.execute()` bare). Instead the call reports progress on the `onUpdate` channel ("Ns elapsed, Ms remaining", ~20 ticks spread over the wait, floor 30s / ceiling 5min) so it never looks frozen, and aborting the tool call ends the wait at once. `PI_TIMER_MAX_WAIT_S` opts into a cap (unset/0 = none): a longer request then returns after the cap with how much time is left and asks to be called again |
| `wsstate.ts` | report pi agent state to WezTerm workspace status via OSC 1337 `SetUserVar=wsstate` (same var as `shell/wsstate.sh`): `busy` from `agent_start` until `agent_settled` (not `agent_end`: retries, compaction and queued continuations run after it); `blocked` while a select/confirm/input/editor dialog is open (`ui_prompt_start`/`ui_prompt_end`; `custom` overlays such as the F2 watch don't count); `waiting` when settled with an armed timer — the agent wakes by itself, so the workspace must not show "needs you"; else `idle`. Timers are detected via the timer tool's public contract — args harvested at `tool_execution_start`, verdict at `tool_execution_end`, joined by `toolCallId` (pi's end event carries no args) — and only under `ctx.mode === "tui"` (elsewhere timer blocks inside the call). The park is a deadline from the `set` call's `seconds` arg (numeric strings coerced, as timer.ts receives them): `cancel` ends it, a later `set` replaces it, runs before the deadline don't (retries re-emit `agent_start`, timer.ts keeps its timer across human runs); past the deadline the next run start (the wake run) or settle (wake steered in-run) consumes it, and an unref'd fallback timeout flips a lost wake to `idle` after a 30 s grace. The state is written on every relevant event, changed or not. pi ≥ 1.1.0's own OSC 7501 program status is no substitute: tmux drops it, wezterm's Lua can't read it, and it has no timer-park state. Main session only: child sessions (Agent/Explore) load this file too but share the parent's stdout, so children register nothing (`inChildSession()` guard at bind time) |

### Agent dashboard (`pi-dash` daemon)

One standalone daemon per machine serves the browser dashboard for ALL projects
(every session dir under `~/.pi/agent/sessions/`): `pi/dashboard-daemon.mjs`,
run under plain node as the systemd user unit `pi-dash.service`, installed and
kept current by `install-pi.sh` (re-run after pulling code changes — it
restarts the daemon; the next pi session start also restarts a daemon running
stale code of the same checkout). Port `7357` (`PI_AGENT_DASH_PORT`), binds `0.0.0.0`.
pi sessions only write index rows and print the URL; they never serve
(spec decisions 5–7). If the port is squatted (say, by a stray ssh tunnel),
the daemon exits and systemd retries every 30s until the port frees up.

**Watching remote machines — two-tab ssh convention.** Each machine's daemon
binds 7357 locally. To watch a remote machine alongside the local one, forward
it to a DIFFERENT local port — never onto your own dashboard port:

```bash
ssh -L 7358:localhost:7357 remote
```

Tab 1 `http://localhost:7357/` = this machine, tab 2 `http://localhost:7358/` =
remote; the header's host badge (`hostname · sessionsRoot`, from `/api/meta`)
and the tab title identify each. Forwarding onto 7357 while your own daemon
holds it just fails; binding it while the daemon is down makes the daemon
fail+retry until the tunnel closes.

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
  look exactly like they do in the main session. It scrolls with the mouse wheel, `↑`/`↓`, `PgUp`/`PgDn`,
  `Home`/`End`, follows the tail until you scroll away, and `Ctrl+O` expands tool output. The view renders on the terminal's
  **alternate screen** (vim/less style): the main screen and its scrollback are untouchable
  while it is up, and `Esc` restores the exact pre-F2 screen — no watch-view rows can end up
  mingled into the parent transcript's history. (Coupled to pi-tui's internal
  capture/restoreRenderState API; if a pi update removes it, F2 degrades to the old
  main-screen overlay.) Under `tuiMode: "fullscreen"` pi is already on the alternate
  screen and owns mouse tracking, so the watch switches neither — the overlay renders in
  place and pi forwards wheel reports to it.
- Child sessions are persisted (named `agent#<id>`), so a finished run can be reopened from
  the session picker and audited.
- A child that needs a decision just asks; the main agent answers by calling `Agent` again
  with `resume_id`, continuing the same session. It stands in for the human.
  Only the 8 most recent finished children stay in memory; an older one (or any child of
  the same main session after `pi -c`, found via `agent-runs.jsonl`) is reopened from its
  session file on resume, and F2 replays its saved history. Only a missing session file
  (child aborted before pi first wrote it), a session file that no longer holds that
  child's session (overwritten by another session, or not a pi session at all), a child of
  another main session, or an id of the other kind (`Explore` resuming an `Agent` child or
  vice versa, live or reopened) fails.
- One child at a time: a second `Agent` call while one runs is rejected with an error result
  (`childBusy`, set synchronously before the first `await`, so two calls in one assistant
  message can't both pass). The latch is released only once the child is actually quiet
  again — after an abort the child may still be draining, so release happens in the
  background, not in the tool's `finally`. Parallel children shared one worktree and one
  watch slot, and nothing here was verified under concurrency.
- Done ≠ "the run ended". The `Agent` tool returns only when the child is quiet
  (`lib/session-quiet.ts`): idle and an empty message queue (a queued steer/follow-up gets a
  bounded grace to start its run). Nothing restarts a child from the outside:
  `context_handoff`'s whole restart cycle runs inside the child's `prompt()` call
  (regression-tested), and children have no `timer` tool at all (`timer.ts` registers
  nothing there — see the extensions table); a child that must wait uses `bash sleep`,
  which blocks its run the same way a blocking timer would have.
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
./pi/extensions/test/check.sh        # quality gate: typecheck, eslint, dependency-cruiser, jscpd, shellcheck, lua syntax
for t in test/*.test.sh; do bash "$t" || echo "FAIL: $t"; done   # installer shell tests (repo root; sandboxed in mktemp dirs)
```

`check.sh` is a local gate (no CI, no git hook) with exact-pinned tools in
`pi/extensions/test/tools/` (`package.json` + `package-lock.json`); it
`npm ci`s them into the gitignored `tools/node_modules` on first run or when the
lockfile changes — the only step that needs network. The complexity/size
ratchet `tools/eslint-suppressions.json` is empty — every pre-gate offender has
been split — and must stay empty. Rules and bump procedure: AGENTS.md "Verify changes".

`node --test` with Node's type stripping (node >= 22.6), no build step. Tests drive a real
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
