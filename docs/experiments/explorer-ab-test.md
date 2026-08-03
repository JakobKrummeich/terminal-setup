# Experiment: does the Explorer tool earn its keep?

Status: **complete** (2026-08-02). Verdict at the bottom.
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

### What would be worth trying next (not done here)

- Harder, larger-repo tasks where the control arm's own exploration is genuinely expensive; this
  repo (207 files) may simply be small enough that grepping directly is optimal.
- A description that pushes for *repeated* use ("before opening any file you have not read")
  rather than one opening call, then re-measure — the single-call pattern is what makes the current
  cost/latency ledger unfavourable.
- Measuring parent context tokens as the primary outcome rather than cost: treatment did reduce
  mean parent context (76k vs 81k), the one metric that moved in the intended direction outside t3.
