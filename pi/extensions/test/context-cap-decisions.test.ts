/**
 * context-cap state machine, decision tables: one row per branch of the
 * message_end / turn_end decisions (lib/context-cap-decide.ts) and of the
 * `context` handler's view (lib/context-cap-view.ts llmView). The expected
 * actions characterize the behaviour the handlers had before the decisions were
 * extracted; the end-to-end context-cap-*.test.ts files pin the side effects
 * each action runs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { llmView } from "../lib/context-cap-view.ts";
import {
	type CapsView,
	type CycleState,
	decideMessageEnd,
	decideTurnEnd,
	decideTurnGate,
	hardFallbackSwap,
	idleCycle,
	MAX_RETRIES,
	type MessageEndAction,
	type MessageEndInput,
	type StagedSwap,
	type TurnEndAction,
	type TurnEndInput,
	type TurnGateAction,
	type TurnGateInput,
} from "../lib/context-cap-decide.ts";
import { SWAP_MARKER_TYPE } from "../lib/message-types.ts";

const CAPS: CapsView = { soft: 100, hard: 200, disabled: false };
const OFF: CapsView = { soft: Number.POSITIVE_INFINITY, hard: Number.POSITIVE_INFINITY, disabled: true };
const PATH = "/tmp/cc/sid-1.md";

function cycle(over: Partial<CycleState> = {}): CycleState {
	return { ...idleCycle(), ...over };
}
/** A cycle armed by a steer/prompt (startCycle + phase). */
function armed(phase: CycleState["phase"], over: Partial<CycleState> = {}): CycleState {
	return cycle({ phase, expectedPath: PATH, seq: 1, ...over });
}

test("idleCycle: every field at its reset value", () => {
	assert.deepEqual(idleCycle(), {
		phase: "idle",
		expectedPath: undefined,
		seq: 0,
		retries: 0,
		tokensAtTrigger: 0,
		handoffWritten: false,
		hardGraceUsed: false,
		cycleCaps: null,
		stagedSwap: null,
	});
	assert.notEqual(idleCycle(), idleCycle(), "a fresh object per reset — no shared mutable default");
});

// ---------------------------------------------------------------------------
// message_end
// ---------------------------------------------------------------------------

const messageEndRows: Array<[string, CycleState, MessageEndInput, MessageEndAction]> = [
	// skips
	["errored message skipped even above hard mid-cycle", armed("steered"), { stopReason: "error", tokens: 999, caps: CAPS }, { kind: "skip", reason: "failed-stop" }],
	["aborted message skipped", cycle(), { stopReason: "aborted", tokens: 999, caps: CAPS }, { kind: "skip", reason: "failed-stop" }],
	["unknown usage (undefined) never triggers", cycle(), { stopReason: "toolUse", tokens: undefined, caps: CAPS }, { kind: "skip", reason: "no-usage" }],
	["unknown usage (null) never triggers", armed("steered"), { stopReason: "toolUse", tokens: null, caps: CAPS }, { kind: "skip", reason: "no-usage" }],
	["disabled cap skipped", cycle(), { stopReason: "toolUse", tokens: 10_000_000, caps: OFF }, { kind: "skip", reason: "cap-disabled" }],
	// fresh-window guard
	["mid-cycle shrink below soft/2 resets", armed("steered"), { stopReason: "toolUse", tokens: 49, caps: CAPS }, { kind: "reset-shrunk", tokens: 49 }],
	["exhausted cycle shrink resets too", armed("exhausted"), { stopReason: "stop", tokens: 0, caps: CAPS }, { kind: "reset-shrunk", tokens: 0 }],
	["exactly soft/2 is not a shrink", armed("steered"), { stopReason: "toolUse", tokens: 50, caps: CAPS }, { kind: "none" }],
	["idle below soft/2: no cycle to reset", cycle(), { stopReason: "toolUse", tokens: 10, caps: CAPS }, { kind: "none" }],
	// hard cap
	["one-jump crossing (idle, toolUse) → emergency steer", cycle(), { stopReason: "toolUse", tokens: 200, caps: CAPS }, { kind: "steer-hard-jump", tokens: 200 }],
	["idle, backstop-armed path, toolUse → emergency steer (phase decides, not path)", cycle({ expectedPath: PATH }), { stopReason: "toolUse", tokens: 300, caps: CAPS }, { kind: "steer-hard-jump", tokens: 300 }],
	["idle crossing without tool calls → backstop", cycle(), { stopReason: "stop", tokens: 200, caps: CAPS }, { kind: "hard-cap", tokens: 200 }],
	["steered cycle, toolUse, no handoff yet → one grace turn", armed("steered"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-grace" }],
	["prompted cycle gets the grace too", armed("prompted"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-grace" }],
	["grace is one-shot per cycle", armed("steered", { hardGraceUsed: true }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace once the handoff is written", armed("steered", { handoffWritten: true }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace for an exhausted cycle", armed("exhausted"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace without tool calls", armed("steered"), { stopReason: "stop", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace without a cycle path", cycle({ phase: "steered" }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	// soft cap
	["soft crossing mid-tool-use → steer", cycle(), { stopReason: "toolUse", tokens: 100, caps: CAPS }, { kind: "steer-soft", tokens: 100 }],
	["soft crossing without tool calls → left to turn_end silent stop", cycle(), { stopReason: "stop", tokens: 150, caps: CAPS }, { kind: "none" }],
	["soft crossing while a cycle runs → nothing new", armed("steered"), { stopReason: "toolUse", tokens: 150, caps: CAPS }, { kind: "none" }],
	["below soft → nothing", cycle(), { stopReason: "toolUse", tokens: 99, caps: CAPS }, { kind: "none" }],
];

for (const [name, state, input, expected] of messageEndRows) {
	test(`decideMessageEnd: ${name}`, () => {
		assert.deepEqual(decideMessageEnd(state, input), expected);
	});
}

test("hardFallbackSwap: fresh file / older stale file / no file", () => {
	assert.deepEqual(hardFallbackSwap(PATH, PATH), { stale: false, trigger: "hard" });
	assert.deepEqual(hardFallbackSwap(undefined, "/tmp/cc/sid-0.md"), { stale: true, trigger: "hard" });
	assert.deepEqual(hardFallbackSwap(undefined, undefined), { stale: false, trigger: "hard-no-file" });
});

// ---------------------------------------------------------------------------
// turn_end
// ---------------------------------------------------------------------------

const OWN = { role: "assistant", stopReason: "toolUse" };
const OTHER = { role: "assistant", stopReason: "toolUse" };
const staged = (sourceMessage: unknown) => ({ sourceMessage }) as StagedSwap;
const gate = (over: Partial<TurnGateInput> = {}): TurnGateInput => ({
	stopReason: "toolUse",
	outcome: undefined,
	aborted: false,
	message: OWN,
	...over,
});

const turnGateRows: Array<[string, CycleState, TurnGateInput, TurnGateAction]> = [
	["errored message", armed("steered"), gate({ stopReason: "error" }), { kind: "skip-failed" }],
	["aborted message", armed("steered"), gate({ stopReason: "aborted" }), { kind: "skip-failed" }],
	["errored outcome", armed("steered"), gate({ outcome: "error" }), { kind: "skip-failed" }],
	["aborted outcome", armed("steered"), gate({ outcome: "aborted" }), { kind: "skip-failed" }],
	["aborted signal", armed("steered"), gate({ aborted: true }), { kind: "skip-failed" }],
	["failure beats an own staged swap (draft dropped)", armed("steered", { stagedSwap: staged(OWN) }), gate({ outcome: "error" }), { kind: "skip-failed" }],
	["staged swap from another message → discarded", armed("steered", { stagedSwap: staged(OTHER) }), gate(), { kind: "discard-stale-staged" }],
	["staged swap from this message → committed", armed("steered", { stagedSwap: staged(OWN) }), gate(), { kind: "commit-staged" }],
	["nothing staged → evaluate", armed("steered"), gate(), { kind: "evaluate" }],
];

for (const [name, state, input, expected] of turnGateRows) {
	test(`decideTurnGate: ${name}`, () => {
		assert.deepEqual(decideTurnGate(state, input), expected);
	});
}

const turn = (over: Partial<TurnEndInput> = {}): TurnEndInput => ({ tokens: 150, hasToolCalls: false, caps: CAPS, ...over });

const turnEndRows: Array<[string, CycleState, TurnEndInput, TurnEndAction]> = [
	// verification
	["handoff written → soft swap", armed("steered", { handoffWritten: true }), turn({ hasToolCalls: true }), { kind: "swap-soft", path: PATH }],
	["handoff written after exhaustion → soft swap", armed("exhausted", { handoffWritten: true }), turn(), { kind: "swap-soft", path: PATH }],
	["verification runs with the cap disabled", armed("prompted", { handoffWritten: true }), turn({ caps: OFF, tokens: undefined }), { kind: "swap-soft", path: PATH }],
	["still working (tool calls) → wait", armed("steered"), turn({ hasToolCalls: true }), { kind: "keep-waiting" }],
	["exhausted → wait for the hard cap", armed("exhausted"), turn(), { kind: "keep-waiting" }],
	["no handoff, no tools → reminder 1", armed("steered"), turn(), { kind: "remind", attempt: 1 }],
	["second refusal → reminder 2", armed("prompted", { retries: 1 }), turn(), { kind: "remind", attempt: 2 }],
	["reminders used up → exhausted", armed("steered", { retries: MAX_RETRIES }), turn(), { kind: "exhaust" }],
	// silent stop
	["idle, crossed soft without tool calls → silent-stop prompt", cycle(), turn({ tokens: 100 }), { kind: "silent-stop", tokens: 100 }],
	["idle, backstop-armed path → silent stop still fires (phase decides)", cycle({ expectedPath: PATH }), turn({ tokens: 150 }), { kind: "silent-stop", tokens: 150 }],
	["idle with tool calls → message_end's job", cycle(), turn({ hasToolCalls: true }), { kind: "none" }],
	["idle, cap disabled → nothing", cycle(), turn({ caps: OFF, tokens: 10_000_000 }), { kind: "none" }],
	["idle, unknown usage → nothing", cycle(), turn({ tokens: undefined }), { kind: "none" }],
	["idle, below soft → nothing", cycle(), turn({ tokens: 99 }), { kind: "none" }],
	["non-idle phase without a path → nothing (unreachable in practice)", cycle({ phase: "steered" }), turn(), { kind: "none" }],
];

for (const [name, state, input, expected] of turnEndRows) {
	test(`decideTurnEnd: ${name}`, () => {
		assert.deepEqual(decideTurnEnd(state, input), expected);
	});
}

// ---------------------------------------------------------------------------
// context: the LLM view (lib/context-cap-view.ts llmView)
// ---------------------------------------------------------------------------

const U = { role: "user", content: "task" };
const A = { role: "assistant", content: [{ type: "text", text: "done" }] };
const W1 = { role: "user", content: "[context-cap] ⚠️ old warning" };
const W2 = { role: "user", content: [{ type: "text", text: "[context-cap] No handoff was recorded" }] };
const M = { role: "custom", customType: SWAP_MARKER_TYPE, content: "handoff" };
const POST = { role: "user", content: "after the swap" };

const viewRows: Array<[string, unknown[], boolean, number, unknown[], boolean]> = [
	["no marker, no warning: untouched", [U, A], false, 0, [U, A], false],
	["no cycle armed: every warning is stranded → scrubbed", [U, W1, A, W2], false, 0, [U, A], true],
	["cycle armed, no marker: warnings stand", [U, W1, A], true, 0, [U, W1, A], false],
	["marker: everything before it is cut (tail off)", [U, A, M, POST], true, 0, [M, POST], true],
	["marker first: nothing to cut", [M, POST], false, 0, [M, POST], false],
	["armed: warning behind the marker scrubbed, after it kept", [U, W1, M, W2], true, 0, [M, W2], true],
	["idle: warning after the marker scrubbed too", [M, W2, POST], false, 0, [M, POST], true],
	["tail lever keeps whole turns before the marker", [U, A, M], true, 1000, [U, A, M], false],
	["tail lever never keeps a behind-marker warning", [U, W1, A, M], true, 1000, [U, A, M], true],
];

for (const [name, messages, armedCycle, tail, expected, changed] of viewRows) {
	test(`llmView: ${name}`, () => {
		const view = llmView(messages, armedCycle, tail);
		assert.deepEqual({ messages: [...view.messages], changed: view.changed }, { messages: expected, changed });
	});
}
