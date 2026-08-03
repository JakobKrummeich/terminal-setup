# Experiment: does the Explorer tool earn its keep?

Status: **complete** (round 1: 2026-08-02, round 2: 2026-08-03). Final verdict at the bottom.
 Protocol below is fixed before results are collected. Results and the
verdict live at the bottom; nothing above the results section is edited once a run has started.

Subject: the `Explorer` tool added in `pi/extensions/explorer.ts` (design: `docs/ideas/explorer-subagent.md`).

## Questions

1. **Is Explorer actually used** when an agent has it?
2. **Does it lower cost** — total USD per task, including the explorer's own tokens?
3. **Does it lower wall-clock time** per task?
4. **Does output quality change** — correctness and code quality of the result?

Q2–Q4 are only worth measuring if Q1 is yes. Hence a preflight.

## Design

A/B, within-task, paired.

| | Arm A (control) | Arm B (treatment) |
|---|---|---|
| Main agent | `anthropic/claude-opus-5`, thinking `high` | same |
| Explorer tool | removed (`--exclude-tools Explorer`) | available |
| Explorer model | — | `anthropic/claude-haiku-4-5` |
| Everything else | same prompt, same repo state, same tools (`Agent` included) | identical |

- **Paired**: each task is run once per arm, so tasks are their own control.
- **Isolation**: every run gets a fresh `git clone` of `/home/dev/lightspeed` into
  `/tmp/explorer-ab/<run-id>/repo` with `node_modules` symlinked in. **The real repo is never
  modified**; `git -C /home/dev/lightspeed status --short` must be empty before and after each run.
- **Session isolation**: `PI_CODING_AGENT_SESSION_DIR` points at the run directory, so the parent
  session *and* every child (agent/explorer) session file lands there and nowhere else. This is
  also how cost is attributed: the proxy's SQLite log cannot be used, because the operator's own
  pi session runs through the same proxy on the same model.
- **Blinding**: the judge sees two anonymised diffs (`solution-1` / `solution-2`) in randomised
  order, with no arm labels, no tool logs, no cost data.

### Why this shape

The honest alternative — many tasks, many repetitions — is unaffordable at opus prices. With n=3
paired tasks per arm this experiment cannot produce statistical significance, and does not claim
to. It is a **decision aid**: a large, consistent effect is worth acting on; a small or
inconsistent one means "no measurable benefit yet", not "no benefit".

## Measures

Per run, extracted from the run's session files (`*.jsonl`) and the wrapper:

- `cost_usd` — sum of `usage.cost.total` over every assistant message in **all** session files of
  the run (parent + subagents + explorers). Includes the explorer's own spend by construction.
- `wall_s` — wall-clock seconds of the `pi -p` process.
- `explorer_calls`, `agent_calls` — count of `toolCall` blocks by name in the parent session.
- `tool_calls_total`, `parent_context_tokens` — activity and final context size of the parent.
- `files_changed`, `diff_lines` — from `git diff --stat` in the clone.
- `tests_pass` — `npm test` in the clone after the run (baseline: 1112 passing, 0 failing).

## Preflight (Q1 only)

Arm B only, one run per task. Success criterion, fixed in advance:

> **Explorer is used in at least 2 of 3 tasks, with ≥1 call each.**

If it fails, the tool description in `pi/extensions/explorer.ts` is rewritten (only the
description — no change to behaviour, model or tool set) and the preflight is repeated. Every
iteration is logged below with what changed and why. The main experiment starts only after the
criterion is met. Rationale: comparing arms is meaningless if the treatment is never applied.

## Tasks

Three tasks in `lightspeed`, each requiring the agent to first find where things live (no file
paths or function names are given), each verifiable by `npm test` plus diff review.

- **T1 — session purge:** add a way to list all stored review sessions (including closed ones,
  hidden by default) and delete closed/old ones, with dry-run, a guard against deleting active
  sessions, and a count of what was removed. Follow existing CLI output/error conventions.
- **T2 — exclude noise paths:** add a repeatable CLI option plus a persistent per-repo config key
  that drops glob-matched paths (lockfiles, build output) from the extracted change set, keeps
  counters consistent, reports how many files were excluded, and fails cleanly if everything is
  excluded.
- **T3 — age and lifecycle in the overview:** enrich the session overview with human-readable age
  from an injectable clock, a stale marker, an option to include closed sessions, and a summary
  line counting total/active/stale.

Full briefs: `tasks/*.md` next to this file. Each ends with the same acceptance boilerplate
(existing tests keep passing, add tests, keep conventions) so wording cannot favour an arm.

## Judging (Q4)

A fresh pi session (`claude-opus-5`, no memory of this work) receives:

- the task brief,
- both diffs, labelled `solution-1` / `solution-2` in randomised order,
- the test result for each.

It scores each on **correctness** (does it do what was asked, do the tests support it) and
**quality** (fit with existing conventions, clarity, test quality, absence of over-engineering),
0–10 each, with a short justification and a forced preference. The randomisation key is not
revealed until scores are written down.

Threats to validity, accepted: n is small; judge is the same model family as the worker; tasks
come from one repo; the operator's own pi session shares the proxy (mitigated by per-run session
dirs); haiku availability and latency vary with load.

## Runner

`docs/experiments/explorer-ab/run.sh` — one run: clone, launch pi with the arm's flags, time it,
run the test suite, extract metrics into `result.json`. `collect.py` aggregates runs into a table.

## How to resume this experiment (read this first if you just picked it up)

This file is the contract. Do not redesign it, do not stop early, do not ask the user for
permission to continue — the experiment is only finished when the four questions above are
answered with evidence in the Results section and reported to the user.

State is on disk: every run leaves `/tmp/explorer-ab/<run-id>/` with `result.json`, `solution.diff`,
`stdout.txt`, `test.txt` and its own `sessions/`. Check what exists before running anything.

Steps, in order:

1. **Preflight** (`docs/experiments/explorer-ab/preflight.sh <iteration>`): treatment arm, tasks
   t1–t3. Read `explorer_calls` in each `result.json`.
2. If the criterion (≥2 of 3 tasks with ≥1 Explorer call) fails: edit **only** `TOOL_DESCRIPTION`
   in `pi/extensions/explorer.ts`, log the change and its rationale in Results, then rerun the
   preflight with the next iteration number. Repeat until it passes. Change nothing else — not the
   model, not the tool set, not the tasks.
3. **Main experiment**: for each task t1–t3, one `control` run and one `treatment` run
   (`run.sh <arm> <task> <run-id>`). Runs are sequential, never parallel — parallel runs would
   corrupt the wall-clock measure.
4. **Judging**: build `judge/` with the two diffs per task, labelled `solution-1` / `solution-2` in
   a randomised order recorded in a key file the judge cannot see. Run a fresh blinded pi session
   per task (`pi -p --model anthropic/claude-opus-5`, cwd outside the subject repo). Write the
   scores down before unblinding.
5. **Report**: fill in Results, answer Q1–Q4 explicitly, state effect sizes and the honest
   caveats (n=3, no significance claim), and tell the user.

Rules that must not be broken: the subject repo `/home/dev/lightspeed` is never modified (the
runner aborts if it is dirty); every run gets a fresh clone and its own session dir; the judge
never sees arm labels, costs or tool logs.

## Results

### Preflight (Q1)

One iteration, no description change needed. Explorer was called in **3 of 3** tasks (criterion:
≥2 of 3), exactly **once each**, always as the opening move, after which the agent explored on its
own (12–16 `read`, 15–28 `bash`). Runs: `/tmp/explorer-ab/preflight1-*`.

### Main experiment

Six runs, paired, sequential. Raw data: `/tmp/explorer-ab/main-*/result.json`.

| task | arm | cost $ | wall s | parent tool calls | Explorer calls | parent ctx tokens | files | diff lines | tests |
|---|---|---|---|---|---|---|---|---|---|
| t1 | control | 3.01 | 490 | 54 | 0 | 80847 | 11 | 1170 | 1171 |
| t1 | treatment | 3.22 | 536 | 60 | 1 | 86170 | 14 | 1271 | 1171 |
| t2 | control | 3.55 | 504 | 68 | 0 | 87773 | 15 | 887 | 1185 |
| t2 | treatment | 3.70 | 723 | 61 | 1 | 95966 | 14 | 963 | 1180 |
| t3 | control | 2.73 | 417 | 62 | 0 | 74833 | 10 | 752 | 1181 |
| t3 | treatment | 1.35 | 322 | 34 | 1 | 45980 | 7 | 447 | 1171 |
| **mean** | control | **3.10** | **470** | 61 | 0 | 81151 | | | |
| **mean** | treatment | **2.76** | **527** | 52 | 1 | 76039 | | | |

Every run left the suite green (baseline 1112; each arm added its own tests).
Explorer's own spend: **$0.09–$0.12 per call** (23–43 internal tool calls) — about **3%** of a run.

### Judging (Q4)

Two blinded passes, counterbalanced. Pass 1 randomised — unluckily placing treatment at
`solution-1` in all three tasks — so pass 2 was run with the labels swapped, which is also what
exposed a strong position bias in the judge.

| task | pass 1 (treatment = solution-1) | pass 2 (control = solution-1) | treatment score c+q | control score c+q |
|---|---|---|---|---|
| t1 | prefers control | prefers control | 15 / 13 | 16 / 17 |
| t2 | prefers treatment | prefers control | 17 / 15 | 15 / 17 |
| t3 | prefers control | prefers control | 14 / 13 | 17 / 17 |

**Control preferred in 5 of 6 blinded judgments.** Mean total score (correctness + quality, max 20):
**control 16.5, treatment 14.5**. The judge preferred `solution-1` in 4 of 6 judgments, so position
bias is real — but it cannot explain the result, because control wins in both orderings.

Judge reasoning, verbatim, in `/tmp/explorer-ab/judge*/t*/verdict.txt`.

## Verdict

1. **Is Explorer used? Yes — but shallowly.** 3/3 preflight and 3/3 treatment runs called it,
   always exactly once, as the opening move. It never became the agent's way of working: after the
   one call, the agent read and grepped as much as the control arm did. The description earns the
   first call and no more.
2. **Cost: no reliable saving.** Mean −11% ($2.76 vs $3.10), but that is one task carrying
   everything: t3 −50%, while t1 +7% and t2 +4%. The explorer itself is nearly free (~3% of a run),
   so the mechanism that matters is whether its pointers *replace* the parent's own reading — and
   twice out of three they did not.
3. **Speed: no, slightly worse.** Mean +12% wall-clock (527s vs 470s); slower in t1 (+9%) and t2
   (+43%), faster only in t3 (−23%). An Explorer call is a blocking round trip, and unless it
   removes work downstream it is pure added latency.
4. **Quality: no improvement, mild evidence of harm.** Control preferred in 5 of 6 blinded
   judgments, mean 16.5 vs 14.5. The cheapest treatment run (t3, −50% cost, −23% time) also produced
   the smallest diff (447 vs 752 lines) and the worst score — consistent with pointers giving false
   confidence in coverage: the agent stopped exploring early and missed conventions the control arm
   found (spec.md updates, the CLI's `unknownFlag` convention, TOON uniform-row output).

**Overall: the Explorer tool as it stands does not pay for itself on this workload.** It is used,
it is cheap, and it occasionally produces a large win — but on average it costs the same, takes
longer, and produces slightly worse work.

Caveats, stated plainly: n=3 paired tasks in one repository, one model pair, no repetitions, so
none of these differences are statistically significant. The t3 outlier drives every cost and time
average. Judge and worker are the same model family, and the judge shows position bias. This is
evidence to act on, not proof.

### What was worth trying next (round 2 does exactly this)

- Harder, larger-repo tasks where the control arm's own exploration is genuinely expensive; this
  repo (207 files) may simply be small enough that grepping directly is optimal.
- A description that pushes for *repeated* use ("before opening any file you have not read")
  rather than one opening call, then re-measure — the single-call pattern is what makes the current
  cost/latency ledger unfavourable.
- Measuring parent context tokens as the primary outcome rather than cost: treatment did reduce
  mean parent context (76k vs 81k), the one metric that moved in the intended direction outside t3.

---

# Round 2 — bigger repo, context as the primary outcome

Round 1 answered its four questions but left the interesting one open: the tool is *supposed* to
buy the caller **context headroom**, and round 1 measured cost. Round 2 keeps the design of round 1
and changes four things, all fixed before any run:

| | round 1 | round 2 |
|---|---|---|
| subject repo | `lightspeed`, 207 files, TypeScript | **frozen clone of `ValuesWorkshop`** (`/home/dev/.cache/vw-frozen`, pinned `3f898ba`), 406 files, C# backend + React/TS frontend |
| tasks | 3 synthetic CLI features | **6 tasks (r1–r6)** taken from the repo's real backlog, spread over domain, HTTP, and frontend |
| primary outcome | `cost_usd` | **`parent_peak_context`** (peak context tokens of the *caller's* session) |
| extra question | — | **Q6: do subagents (`Agent`) use Explorer themselves?** |

Everything else is unchanged: same models (opus-5 caller, haiku-4-5 explorer), same arms
(`--exclude-tools Explorer` vs available), paired within task, sequential runs, fresh clone and
private session dir per run, blinded judging.

Measures added in `measure2.py`: `parent_peak_context`, `caller_peak_context_sum` (parent plus any
subagent that itself acts as a caller), `explorer_calls_parent` vs `explorer_calls_subagent`,
`subagents`, `cost_explorers`, and per-session context peaks. Verification per run: `dotnet test`
(baseline 272 passing), `pnpm test` (baseline 167), `pnpm typecheck`.

Tasks (full briefs in `explorer-ab/tasks2/`): r1 facilitator quiz step controls; r2 roster cap with
invariant rejection; r3 `Retry-After` hint on rate-limited session creation; r4 participant lobby
screen; r5 facilitator roster panel; r6 session name through presenter state.

One protocol deviation, applied uniformly and after the fact: `run2.sh` captured the solution as
`git diff --cached`, which is empty when the agent commits its work (one run did). All 12 diffs
were recomputed against the frozen base commit by `explorer-ab/fixdiffs.sh` before judging. This
touches only how the diff is *read*, not how any run was produced.

## Round 2 results

12 runs, paired, sequential. Raw data: `/tmp/explorer-ab/r2-*/result.json`, copied to
`explorer-ab/results2/`. All 12 runs finished green (backend and frontend suites passing,
typecheck clean in every run).

| task | arm | cost $ | wall s | **parent peak ctx** | parent tool calls | Explorer calls | subagents | files | diff lines |
|---|---|---|---|---|---|---|---|---|---|
| r1 | control | 1.63 | 335 | 53939 | 39 | 0 | 0 | 10 | 516 |
| r1 | treatment | 1.59 | 335 | 54944 | 32 | 1 | 0 | 11 | 527 |
| r2 | control | 0.53 | 117 | 28550 | 21 | 0 | 0 | 3 | 60 |
| r2 | treatment | 0.48 | 211 | 20273 | 14 | 1 | 0 | 3 | 72 |
| r3 | control | 0.57 | 166 | 25521 | 18 | 0 | 0 | 2 | 39 |
| r3 | treatment | 0.40 | 162 | 18762 | 14 | 1 | 0 | 2 | 21 |
| r4 | control | 2.08 | 403 | 59453 | 72 | 0 | 0 | 13 | 511 |
| r4 | treatment | 1.43 | 322 | 50960 | 37 | 1 | 0 | 9 | 378 |
| r5 | control | 1.00 | 171 | 39972 | 42 | 0 | 0 | 8 | 286 |
| r5 | treatment | 0.82 | 239 | 32438 | 24 | 1 | 0 | 8 | 275 |
| r6 | control | 1.58 | 296 | 52792 | 52 | 0 | 0 | 9 | 170 |
| r6 | treatment | 1.73 | 398 | 53127 | 51 | 1 | 0 | 10 | 215 |
| **mean** | control | **1.23** | **248** | **43371** | **40.7** | 0 | 0 | | |
| **mean** | treatment | **1.08** | **278** | **38417** | **28.7** | 1 | 0 | | |

Mean paired deltas (treatment vs control, per task then averaged):

| metric | mean Δ | per task |
|---|---|---|
| parent peak context | **−14.3%** | r1 +1.9, r2 −29.0, r3 −26.5, r4 −14.3, r5 −18.8, r6 +0.6 |
| cost | **−13.2%** | r1 −2.4, r2 −8.3, r3 −28.7, r4 −31.4, r5 −17.7, r6 +9.6 |
| wall clock | **+21.7%** | r1 −0.2, r2 +79.6, r3 −2.5, r4 −20.3, r5 +39.3, r6 +34.4 |
| parent tool calls | **−27.8%** | r1 −17.9, r2 −33.3, r3 −22.2, r4 −48.6, r5 −42.9, r6 −1.9 |
| diff lines | −4.6% | r1 +2.1, r2 +20.0, r3 −46.2, r4 −26.0, r5 −3.8, r6 +26.5 |

Explorer's own footprint per call: **$0.05–$0.14** (5–27% of the run's spend, mean ~12%),
18–55 internal tool calls, 15k–31k of *its own* context — context the caller never pays for.

**Q6 — subagents: no data, and that is the finding.** `Agent` was called **zero** times in all 12
runs, in both arms. The workload (single, well-scoped feature tasks) never triggered delegation, so
`explorer_calls_subagent` is 0 everywhere. Whether a subagent would use Explorer is untested; what
is tested is that on this workload subagents do not appear at all.

## Round 2 judging (Q4)

Every task pair judged **twice**, once in each ordering (`judge2` = control first, `judge2-rev` =
treatment first), blinded, unblinded only after all 12 scores were recorded.
Raw verdicts: `explorer-ab/results2/judge2*/`.

| task | control c+q | treatment c+q | pref (control first) | pref (treatment first) |
|---|---|---|---|---|
| r1 | 16 / 16 | 17 / 17 | treatment | treatment |
| r2 | 17 / 17 | 14 / 15 | control | control |
| r3 | 18 / 17 | 14 / 15 | control | control |
| r4 | 17 / 17 | 15 / 15 | control | control |
| r5 | 17 / 18 | 15 / 17 | control | control |
| r6 | 15 / 16 | 18 / 18 | treatment | treatment |

**Control preferred in 8 of 12 judgments** (4 of 6 tasks). Mean total score: **control 16.75,
treatment 15.83**. The judge picked `solution-1` in 6 of 12 — **no position bias this round** — and
gave the *same* preference in both orderings for all six tasks, so these preferences are stable.

Where treatment lost, the judge's stated reasons repeat round 1's pattern: naming that drifts from
the repo's design documents, and missing adapter/integration tests in the layer the task named —
i.e. conventions the control arm found by reading more of the codebase itself. Where treatment won
(r1, r6) it matched the design docs' ubiquitous language *better*, which is exactly what a good
pointer report should produce.

# Final verdict (both rounds)

1. **Is Explorer used? Yes, reliably, and exactly once.** 9 of 9 treatment runs across both rounds
   called it, always as the opening move, never twice. Two repos, nine tasks, one call each. The
   description reliably earns the first call and never the second.
2. **Does it lower the caller's context usage? Yes — this is the real effect.** Round 2:
   **−14.3% mean peak parent context** (43.4k → 38.4k), reduction in 4 of 6 tasks, up to −29%, and
   never more than +2% worse. Round 1 saw the same direction (81k → 76k). The mechanism is visible
   in the tool counts: the parent makes **−27.8% fewer tool calls** and the explorer absorbs 15k–31k
   of context in a session the caller never pays for. If context headroom is the constraint —
   long sessions, compaction pressure — Explorer buys real room.
3. **Cost: a small saving, not the point.** Round 2 −13.2% mean, round 1 −11% (outlier-driven).
   Consistent direction across both rounds, but the effect is modest and one task went the other
   way in each round. Prompt caching makes the caller's own reading cheap (cacheRead $0.50/M), so
   cost understates the context benefit; treat cost as neutral-to-slightly-positive.
4. **Speed: no, consistently worse.** Round 2 **+21.7%** mean wall clock, round 1 +12%. An Explorer
   call is a blocking round trip on a slower path, and one call rarely removes enough downstream
   work to repay the latency. This is the price of the context saving, and it is real.
5. **Quality: slightly worse, consistently.** Control preferred in **13 of 18 blinded judgments**
   across both rounds (5/6 in round 1, 8/12 in round 2); mean score 16.75 vs 15.83 in round 2,
   16.5 vs 14.5 in round 1. Round 2 removes the round-1 position-bias worry: no positional skew,
   and identical preferences in both orderings. The recurring failure mode is the same in both
   rounds — pointers give false confidence in coverage, the agent stops exploring, and it misses
   conventions (design-doc naming, existing test layers) that the control arm found by reading more.
6. **Do subagents use their own Explorer? Unknown — they never appeared.** Zero `Agent` calls in
   all 12 round-2 runs. On single-feature tasks the caller does everything itself, so the nested
   case is untested by this experiment.

**Overall: Explorer is a context tool, not a speed or quality tool.** It reliably trades ~20% more
wall-clock time and a small quality risk for ~14% less caller context and ~13% less cost. Keep it
enabled when context is the binding constraint (long sessions, large repos, work that will be
compacted); it is not worth it for short, latency-sensitive tasks — and the single-call pattern
means it never becomes a *way of working*, only an opening move.

Caveats, stated plainly: 9 paired tasks across 2 repos, one model pair, no repetitions — no
statistical significance is claimed. Judge and worker are the same model family. Round-2 wall-clock
figures include shared-proxy load variance. The one deviation (post-hoc diff recomputation) is
documented above and was applied identically to both arms.

### If someone wants to push this further

- Make the tool *earn repeated use*: the single opening call is what makes the latency ledger bad.
  A description demanding a call before opening any unread file, then re-measure — with context as
  the primary outcome, not cost.
- Fix the quality leak directly: have the explorer report *conventions it saw* (design docs, test
  layers), not only file/line pointers. Both rounds' losses trace to missed conventions.
- Test the nested case deliberately with a task large enough to force `Agent` delegation.

---

# Round 3 — repeated use, and tasks big enough to feel context pressure

Protocol fixed 2026-08-03, before any run. Round 2 showed the benefit is a **fixed ~7–8.5k tokens
per Explorer call**, and the agent makes exactly one call, so the relative saving *shrinks* as tasks
grow (corr(control peak context, Δcontext%) = **+0.81** over round 2's six tasks). Round 3 attacks
both ends of that: make the tool ask to be used repeatedly, and use tasks large enough that context
is a real constraint.

Two changes from round 2, and nothing else:

1. **`TOOL_DESCRIPTION` in `pi/extensions/explorer.ts` rewritten** (description only — no change to
   the explorer's model, prompt, output format or behaviour) to demand repeated use: a standing
   rule to ask before opening/grepping any unread part of the repo, an explicit "one call at the
   start is not enough", one call per area touched, and a new "what are the conventions here" use
   case. Previous text preserved in git history (`pi/extensions/explorer.ts` before this commit).
2. **Four large vertical-slice tasks** (`tasks3/s1..s4.md`) instead of six small ones. Each spans
   domain → application → persistence → hub → frontend → tests in the same repo (`vw-frozen`,
   pinned `3f898ba`), each bundles 4–5 sub-features, none names a file path.
   - **s1** quiz answering: load quiz config, participant answer intent with duplicate rejection,
     live anonymous tallies, participant buttons, presenter tally view.
   - **s2** value selection: load value catalogue, exactly-ten submission with full server-side
     validation, lock-in across restart, facilitator progress count, participant picker.
   - **s3** final voting: five-vote allocation intent, anonymity by construction, close-round and
     tiebreak-round facilitator intents with the repeat-tie loop, exit guard, participant UI.
   - **s4** group formation: sizing rule from the repo's planning material, names from config,
     deterministic value deal-out, restart reproducibility, participant and facilitator views.

Unchanged: models, arms (`--exclude-tools Explorer` vs available), pairing within task, sequential
runs, fresh clone and private session dir per run, all measures from `measure2.py`, blinded judging
in both orderings. Round 2's diff-capture bug is fixed in `run3.sh` (diff taken against the frozen
base commit, so committed work is captured), and the per-run agent timeout is raised to 9000 s
because the tasks are much larger.

Prediction stated in advance, so it can be wrong: if the description works, treatment makes **≥3
Explorer calls per run**, and peak caller context drops by **more than the ~8k fixed offset** seen
in round 2. If calls stay at 1, the tool's single-call pattern is a property of the agent, not of
the wording, and no description will fix it.
