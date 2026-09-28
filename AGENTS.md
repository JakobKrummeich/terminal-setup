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
  under a versioned `Symbol.for` key via `sharedState()` (`lib/shared-state.ts`).
  Bump the key when the state shape changes. `test/lib-module-state.test.ts`
  fails on top-level mutable state in `lib/*.ts`.
- **A stub `tsc` shadows the real compiler** on PATH and a shell wrapper prints fake
  "TypeScript: No errors found". Typecheck ONLY via `pi/extensions/test/check.sh`
  (or its pinned binary by explicit path,
  `pi/extensions/test/tools/node_modules/.bin/tsc -p pi/extensions/test`) and trust
  only the exit code. Never `npx typescript` unpinned: it resolves to TS 7, which
  typescript-eslint 8 (<6.1) and dependency-cruiser 18 (<7) don't support. Same
  rule for tests: check exit codes, never trust output piped through anything.

## Verify changes

- tmux config parse: `tmux -f tmux/tmux.conf -L cfgtest new-session -d \; kill-server`
- wezterm config: save + watch the running terminal (auto-reload); syntax errors show
  as a wezterm error overlay.
- pi extensions: restart pi to reload.
- against a pi version that is NOT installed (e.g. before upgrading): `npm pack` the
  target `@earendil-works/pi-coding-agent` + `pi-ai` + `pi-tui` + `pi-agent-core`
  into a `/tmp` farm, point a scratch tsconfig's `paths` at it with absolute repo
  `include`s, and run the pinned `pi/extensions/test/tools/node_modules/.bin/tsc -p`
  on it. Never install the new version to test it. Extension-visible shapes a new version may move (as of
  0.87, the supported minimum — README): the system prompt is ordered XML sections
  (`<tools>`/`<rules>`/`<docs>`/`<cwd>`); the prompt + tool declarations ride as
  `system` messages inside the provider `context.messages` (filtered out of
  extension `context` events); `turn_end` handlers get boundary events and may
  return entries/continue.
  To also RUN repo code against the uninstalled version, add third-party deps from
  the installed pi into the farm and use
  `node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main`
  from a /tmp dir whose `node_modules` points at the farm — `--preserve-symlinks`
  is what makes the repo's bare imports resolve to the NEW libs instead of the
  installed ones.
- pi extension code: from `pi/extensions/test`, run `timeout 200 ./run.sh` (tests)
  THEN `./check.sh` (quality gate). Both need exit 0; both build the node_modules
  symlink farm (`farm.sh`). Details of each below.
- extension tests: `cd pi/extensions/test && timeout 200 ./run.sh` (builds a
  node_modules symlink farm; exports `PI_OFFLINE=1` —
  without it pi's model-catalog refresh holds keep-alive sockets and hangs the
  suite; also points `PI_CODING_AGENT_DIR` at a temp dir so tests never read or
  write the live `~/.pi/agent` — invoking `node --test` directly bypasses that).
  Don't pipe to `tail` — masks the exit code.
- quality gate: `cd pi/extensions/test && ./check.sh` (~11 s warm; stops at the
  first failing step; never runs the tests). Tools are exact-pinned in
  `tools/package.json` + `tools/package-lock.json`, `npm ci`'d into gitignored
  `tools/node_modules` when the lockfile hash changes (only step needing network);
  configs sit next to them in `tools/`. Steps:
  - typecheck — pinned tsc 5.9 on `tsconfig.json` (strict, `erasableSyntaxOnly`
    so run.sh's plain type stripping can run everything).
  - eslint — recommended + typescript-eslint recommended, `consistent-type-imports`,
    no unused vars (`_` prefix exempt), comment-less empty blocks; production code
    also `complexity` ≤ 7, functions ≤ 60 lines, files ≤ 300 lines.
  - dependency-cruiser — no cycles, `lib/` never imports a top-level extension,
    nothing reachable from `pi/dashboard-daemon.mjs` touches `@earendil-works/*`,
    production never imports `test/`, no unresolvable imports; then
    `depcruise-selftest.sh` proves every rule still fires.
  - jscpd — ≤ 1% copy-paste (≥ 50 tokens) in production TS/JS + bash.
  - shellcheck — installers, `lib/`, `shell/`, `tmux/`, shell tests, test scripts.
    Silence a finding only per line: `# shellcheck disable=SCxxxx # reason`.
- **ESLint ratchet:** `tools/eslint-suppressions.json` froze the pre-gate
  `complexity`/`max-lines`/`max-lines-per-function` offenders; all are split now
  and the file is empty (`{}`) — keep it that way. NEVER add to it (no
  `--suppress-*` runs) — split the function instead. check.sh still passes it to
  eslint, so a stray entry shows up as a diff of that tracked file; should one
  ever be removed again, check.sh fails on the now-unused suppression; prune it
  from the repo root:
  `pi/extensions/test/tools/node_modules/.bin/eslint -c pi/extensions/test/tools/eslint.config.mjs --suppressions-location pi/extensions/test/tools/eslint-suppressions.json --prune-suppressions 'pi/extensions/**/*.ts' 'pi/extensions/lib/dashboard-ui/*.js' pi/dashboard-daemon.mjs`
- bump a gate tool: `cd pi/extensions/test/tools && npm install --prefix . --save-exact <pkg>@<version>`,
  commit `package.json` + `package-lock.json`, re-run `./check.sh`. Keep
  typescript < 6.1 (typescript-eslint 8 peer range). The shellcheck binary version
  is `SHELLCHECK_RELEASE` in check.sh (the npm wrapper would fetch "latest").
  Never add a package.json to the repo root or `pi/extensions/` itself (pi's loader).

## Shipping

- **No GitHub Actions** (private repo): no-mistakes is the CI. `.no-mistakes.yaml`
  runs the tests (`run.sh`, `test/*.test.sh`, tmux parse) and `check.sh`, and
  declares `no_ci: true`. Changes under `pi/` and all agent-authored work go
  through it: feature branch → `/no-mistakes` → PR → human merge. Small config
  tweaks (wezterm/tmux/shell) may still push straight to `main`.
- `.no-mistakes.yaml` and `.maintenance-agent.yaml` are trusted only from `main`:
  an edit to either takes effect once merged. maintenance-agent runs nightly
  (host registration `~/.maintenance-agent/repos.d/terminal-setup.yaml`,
  `auto_merge: false`); its `maintenance/*` PRs wait for a human, and two
  unmerged ones pause the nightly runs (branch cap).

## Boundaries

- ✅ **Always:** edit configs via repo paths (they ARE the live configs).
- ⚠️ **Ask first:** risky `wezterm.lua` edits (font/layout — see README known issues:
  glyph jitter, pane-sync timing); changing installer backup/link semantics.
- 🚫 **Never:** commit `~/.pi/agent/auth.json` or any API keys; symlink
  `settings.json`; edit the live `~/.pi/agent/settings.json` on pi's behalf.
