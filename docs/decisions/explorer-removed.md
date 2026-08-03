# Explorer extension: built, measured, removed

**Decision (2026-08-03): the `Explorer` tool is removed from this repo and from the live pi
config.** It is in git history (`pi/extensions/explorer.ts`, `pi/explorer-model.json`, design notes
`docs/ideas/explorer-subagent.md`); the full experiment, harness and raw data live in
`~/agent-experiments/explorer-ab/`.

## What it was

A second child-session tool next to `Agent`, sharing `lib/child-session.ts`. It ran a cheap model
(haiku) read-only and reported *where to look* — `path:line-range — why`, never code, never answers
— so the caller could spend flagship tokens on thinking instead of grepping. Every agent had it at
every depth; the model was user configuration (`/explorer-model`), shipped unset.

## What was measured

Three A/B rounds, paired within task, blinded judging in both orderings, ~$220 of runs:

| round | subject | tasks | Explorer calls/run | cost | wall | context | quality (blinded pref) |
|---|---|---|---|---|---|---|---|
| 1 | `lightspeed`, small CLI tasks | 3 | 1 | −11% | +12% | −6% peak parent | control 5/6 |
| 2 | `ValuesWorkshop`, small tasks | 6 | 1 | −13% | +22% | −14% peak parent | control 8/12 |
| 3 | same repo, 4 large vertical slices, "repeated use" description | 4 | 2–7 | −10% (range −50%…+46%) | −13% | −23% caller total, handoffs 2.0→1.5 | control 5/8 |
| 2b | round-2 tasks, round-3 description | 6 | 1.3 | +14% vs no tool | +41% | +3% vs no tool | not judged |

## Why it was removed

1. **Quality never improved.** Control was preferred in **18 of 26** blinded judgments. The failure
   mode repeated in every round: pointers create false confidence in coverage, the agent stops
   exploring, and it misses conventions the control arm found by reading more.
2. **No reliable cost or time saving.** Direction was consistent for cost but small and
   outlier-driven; wall-clock was worse on ordinary work in every round.
3. **The context benefit is real but small where it matters.** ~7–8.5k tokens per call, one call per
   run — about 4% of a 200k window. It only became large (−23%, fewer forced cap swaps) on tasks big
   enough to saturate context, and only by replacing subagent fan-out.
4. **Tuning it for large tasks made it worse for small ones** (round 2b): a description pushing
   repeated use cost more, took 41% longer and gave back the context saving. There is no single
   setting that is right for both regimes.
5. **It cost complexity**: a second child-session tool, a model-selection command, a reference-copy
   config file, and a pricing entry in the proxy — for no measured net gain.

## What was kept

- `subagent.ts` and `lib/child-session.ts` stay; the `Agent` tool was never in question.
- The harness generalises to any "does tool X help" question and lives in `~/agent-experiments`.
- The open follow-up the data actually points at: **subagent context hygiene**. Cost in round 3
  tracked the number of fresh 161k-context callers a task spawned (control s1: 5 subagents, 732k
  summed caller context, $36.22; treatment: 1 subagent + explorers, 270k, $18.54). Making `Agent`
  briefs pointer-precise, its children tool-restricted and its returns compact is the untested
  lever — testable with the same harness.
