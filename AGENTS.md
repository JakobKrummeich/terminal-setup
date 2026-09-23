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
- **pi loads each extension file with its own jiti instance (`moduleCache: false`).**
  Files under `pi/extensions/lib/` imported by two extensions exist as two module
  copies; module-level state silently splits. Only relative imports split — bare
  package imports (pi-tui etc.) are aliased to pi's own module instances and stay shared. Shared state must live on `globalThis`
  under a versioned `Symbol.for` key — see `lib/pending-work.ts` and
  `lib/child-session.ts`. Bump the key when the state shape changes.
- **A stub `tsc` shadows the real compiler** and a shell wrapper prints fake
  "TypeScript: No errors found". Typecheck ONLY via
  `cd pi/extensions/test && command npx -y -p typescript tsc -p .` and trust only
  exit code 0 + empty output. Same rule for tests: check exit codes, never trust
  output piped through anything.

## Verify changes

- tmux config parse: `tmux -f tmux/tmux.conf -L cfgtest new-session -d \; kill-server`
- wezterm config: save + watch the running terminal (auto-reload); syntax errors show
  as a wezterm error overlay.
- pi extensions: restart pi to reload.
- against a pi version that is NOT installed (e.g. before upgrading): `npm pack` the
  target `@earendil-works/pi-coding-agent` + `pi-ai` + `pi-tui` + `pi-agent-core`
  into a `/tmp` farm, point a scratch tsconfig's `paths` at it with absolute repo
  `include`s, and run the same `command npx -y -p typescript tsc`. Never install the
  new version to test it. Extension-visible shapes that moved in >=0.86: the system
  prompt is ordered XML sections (`<tools>`/`<rules>`/`<docs>`/`<cwd>`), and the
  prompt + tool declarations ride as `system` messages inside the provider
  `context.messages` (0.87 filters them out of extension `context` events).
  To also RUN repo code against the uninstalled version, add third-party deps from
  the installed pi into the farm and use
  `node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main`
  from a /tmp dir whose `node_modules` points at the farm — `--preserve-symlinks`
  is what makes the repo's bare imports resolve to the NEW libs instead of the
  installed ones.
- extension tests: `cd pi/extensions/test && timeout 150 ./run.sh` (builds a
  node_modules symlink farm; run it before typecheck; exports `PI_OFFLINE=1` —
  without it pi's model-catalog refresh holds keep-alive sockets and hangs the
  suite). Don't pipe to `tail` — masks the exit code.

## Boundaries

- ✅ **Always:** edit configs via repo paths (they ARE the live configs).
- ⚠️ **Ask first:** risky `wezterm.lua` edits (font/layout — see README known issues:
  glyph jitter, pane-sync timing); changing installer backup/link semantics.
- 🚫 **Never:** commit `~/.pi/agent/auth.json` or any API keys; symlink
  `settings.json`; edit the live `~/.pi/agent/settings.json` on pi's behalf.
