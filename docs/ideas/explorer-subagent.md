# Explorer Subagent

## Problem Statement

How might we let any agent — including subagents — buy cheap "where to look" answers, so the
calling agent spends its context only on files that matter and its expensive tokens only on thinking?

## Recommended Direction

A separate `Explorer` tool, sibling to the existing `Agent` tool in `pi/extensions/subagent.ts`.
It spawns a child session on a **cheap model** (haiku-class) with a **read-only tool set**, and its
job is not to answer the question but to return *pointers*: the exact places the calling agent needs
to read, so the caller can enrich its own context in a targeted way instead of exploring itself.

Why a separate tool rather than a mode of `Agent`: child sessions are created with
`excludeTools: [TOOL_NAME]` (`subagent.ts`, `createChildSession`), which is whole-tool granularity.
If Explorer were a parameter of `Agent`, subagents would lose both. As its own tool, children can be
given `excludeTools: ["Agent"]` while keeping `Explorer` — which satisfies the core requirement that
**every agent, including subagents, can explore**, while nothing can spawn a full agent recursively.

Explorers are ordinary child sessions in every other respect: same extensions, same `context-cap.ts`
behaviour, same F2 watch view. Only model and tool set differ.

## Decisions (locked)

| Aspect | Decision |
| --- | --- |
| Shape | New `Explorer` tool, own file `pi/extensions/explorer.ts` |
| Shared code | Extract `createChildSession`, `ChildView`, `watchChild`, meta/footer, watch shortcut into `pi/extensions/lib/child-session.ts`. Verified: pi's loader scans top-level `*.ts` only (`core/package-manager.js:373-397,438`), so `lib/` is invisible to it — no default export needed |
| Output contract | Strict *in the prompt*: `path:line-range — one line why`, no pasted code, no answers. **Not** validated or reshaped — models drift and the caller is smart enough to read through it |
| Model | `anthropic/claude-haiku-4-5` (200k ctx, $1/$5 per M, cacheRead $0.10) — configurable, not hardcoded |
| Config store | `~/.pi/agent/explorer-model.json`, copied once from repo reference `pi/explorer-model.json` by `install-pi.sh` (same pattern as `settings.json`). Extensions get no `settingsManager` in `ExtensionContext`, so an own file is the only option |
| Default value | `null`. No hardcoded guess. Install prints a reminder; pi shows a **startup notice once per session** while unset — communicate it as early as possible |
| Config UX | `/explorer-model` slash command with an interactive selector over `registry.getAvailable()` (ids here come from a local proxy and are not guessable). Optional `provider/id` argument as a shortcut |
| Failure policy | Fail fast, fail hard. Resolve locally at spawn (`registry.find` + `hasConfiguredAuth` — snapshot reads, no network, no tokens burned). Unresolvable → Explorer returns an error telling the agent to have the user run `/explorer-model`. **Never** auto-fall back to the parent model |
| Explorer tools | Keeps `Read`, `grep`, `find`, `ls`, `context_handoff`. Excludes `Agent`, `Explorer`, `Edit`, `Write`, `Bash`, `timer` |
| Budget | None. No turn cap, no "be quick", no mid-flight abort. The cheap model *is* the cost control; the model decides when it is done. Only ceiling is the existing context window / `context-cap.ts`, inherited unchanged |
| `Agent` description | Rewritten to drop the "Exploration" bullet (implementation, verification, multi-file edit loops). It does **not** mention Explorer — `Explorer`'s own description must be strong enough to pull exploration work to itself |

## Key Assumptions to Validate

- [ ] **Haiku's pointers are good enough.** Bad pointers cost double: the caller reads the wrong files
      and then explores anyway. *Test:* 3 real tasks in this repo, compare Explorer output against
      exploration done by hand. (Prior art: Claude Code has used a haiku-class model for its Explore
      agent — encouraging, not proof.)
- [ ] **Agents actually reach for Explorer.** Nothing forces it; only the tool description's pull.
      *Test:* after the description rewrite, count Explorer calls vs. unaided grep-storms over a week
      of normal use.
- [ ] **Cost and context actually drop.** *Test:* one Explorer run's meta line shows non-zero cost and
      a small context number. Proxy checked: usage is passed through byte-for-byte
      (`anthropicAPIProxy/src/sse-parser.ts:27`, `src/proxy.ts:86-99`), and pi computes cost itself from
      pi-ai's shipped catalog (`pi-ai/dist/providers/data/anthropic.json`), so the meta line is correct
      with no `models.json` change. Proxy-side dashboard mispricing already fixed:
      `anthropicAPIProxy` commit `7a1d0c5` adds the `claude-haiku-4-5` entry (prefix-covers the dated id).

## MVP Scope

**In:**
- `pi/extensions/lib/child-session.ts` — plumbing extracted from `subagent.ts`, shared `liveChildren`
  map so the F2 watch view lists Agents and Explorers together.
- `pi/extensions/explorer.ts` — `Explorer` tool: cheap model, read-only tool set, pointer-contract
  system prompt, hard error when unconfigured.
- `/explorer-model` selector + `~/.pi/agent/explorer-model.json` read/write.
- `pi/explorer-model.json` reference copy (`null`) + `install-pi.sh` copy-once and reminder.
- `Agent` tool description rewrite.

**Out:** everything in the next section.

## Not Doing (and Why)

- **Output-shape validation / corrective turns** — brittle; models drift from any format and the
  calling agent reads through it fine. A rejection loop costs more than a chatty explorer.
- **Hard work budgets (max tool calls / turns, mid-flight abort)** — would kill the approach.
  A haiku reading 20 files is still cheaper than an opus reading 3.
- **Auto-fallback to the parent model** — silently pays opus prices at haiku expectations. Error out.
- **Env-var configuration** — too opaque; the runtime selector is the interface.
- **Hardcoded default model id** — the local proxy's ids are not guessable and a wrong id fails late.
  Force an explicit choice at install time.
- **Explorers spawning explorers** — depth is capped at one on purpose; recursion is how cheap becomes
  expensive.
- **`Bash` for the explorer** — `grep`/`find`/`ls` cover exploration, and `Bash` is an escape hatch to
  writing files.
- **Special context-cap handling for explorers** — they inherit the same behaviour as any child. If a
  scope is too big to fit, that is rare and fine.
- **Parallel explorer fan-out, cached repo "index cards"** — interesting, but not until the basic tool
  proves it earns its keep.
- **A pointer-count hint ("return at most N pointers")** — any N would be picked from thin air today.
  Revisit only if real runs show explorers dumping too much or too little.
- **A cheap non-LLM `locate()` ripgrep tool** — plausible alternative that would cost $0, deliberately
  deferred: it cannot rank relevance or answer "how does Y work".

## Open Questions

None blocking — ready to implement.
