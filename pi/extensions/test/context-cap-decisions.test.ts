/**
 * context-cap state machine, decision tables: one row per branch of the
 * message_end / turn_end / /handoff decisions (lib/context-cap-decide.ts) and of
 * the `context` handler's view (lib/context-cap-view.ts llmView). The
 * end-to-end context-cap-*.test.ts files pin the side effects each action runs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { llmView } from "../lib/context-cap-view.ts";
import {
	type CapsView,
	type CycleState,
	decideManual,
	decideMessageEnd,
	decideTurnEnd,
	decideTurnGate,
	hardFallbackSwap,
	idleCycle,
	type ManualAction,
	MAX_RETRIES,
	type MessageEndAction,
	type MessageEndInput,
	messageEndTokens,
	type StagedSwap,
	type TurnEndAction,
	type TurnEndInput,
	type TurnGateAction,
	type TurnGateInput,
} from "../lib/context-cap-decide.ts";
import { HANDOFF_DEMAND_TYPE, SWAP_MARKER_TYPE } from "../lib/message-types.ts";

const CAPS: CapsView = { soft: 100, hard: 200, disabled: false };
const OFF: CapsView = { soft: Number.POSITIVE_INFINITY, hard: Number.POSITIVE_INFINITY, disabled: true };
const PATH = "/tmp/cc/sid-1.md";

function cycle(over: Partial<CycleState> = {}): CycleState {
	return { ...idleCycle(), ...over };
}
/** A cycle armed by a cap crossing (startCycle + origin/phase). */
function armed(phase: CycleState["phase"], over: Partial<CycleState> = {}): CycleState {
	return cycle({ phase, origin: "soft", expectedPath: PATH, seq: 1, ...over });
}
/** A /handoff demand typed mid-run, waiting for the run to settle. */
const waitingManual = (): CycleState => armed("pending", { origin: "manual", demandAt: "settle", ending: "new-session" });
const DOC = { body: "## Current Task\nx", author: "agent" as const };

test("idleCycle: every field at its reset value", () => {
	assert.deepEqual(idleCycle(), {
		phase: "idle",
		origin: null,
		ending: "swap",
		demandAt: "turn_end",
		expectedPath: undefined,
		seq: 0,
		retries: 0,
		tokensAtTrigger: 0,
		doc: null,
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
	["errored message skipped even above hard mid-cycle", armed("demanded"), { stopReason: "error", tokens: 999, caps: CAPS }, { kind: "skip", reason: "failed-stop" }],
	["aborted message skipped", cycle(), { stopReason: "aborted", tokens: 999, caps: CAPS }, { kind: "skip", reason: "failed-stop" }],
	["unknown usage (undefined) never triggers", cycle(), { stopReason: "toolUse", tokens: undefined, caps: CAPS }, { kind: "skip", reason: "no-usage" }],
	["unknown usage (null) never triggers", armed("demanded"), { stopReason: "toolUse", tokens: null, caps: CAPS }, { kind: "skip", reason: "no-usage" }],
	["disabled cap skipped", cycle(), { stopReason: "toolUse", tokens: 10_000_000, caps: OFF }, { kind: "skip", reason: "cap-disabled" }],
	// fresh-window guard
	["mid-cycle shrink below soft/2 resets", armed("demanded"), { stopReason: "toolUse", tokens: 49, caps: CAPS }, { kind: "reset-shrunk", tokens: 49 }],
	["exhausted cycle shrink resets too", armed("exhausted"), { stopReason: "stop", tokens: 0, caps: CAPS }, { kind: "reset-shrunk", tokens: 0 }],
	["a /handoff cycle is exempt: the user asks at any size", armed("demanded", { origin: "manual" }), { stopReason: "toolUse", tokens: 10, caps: CAPS }, { kind: "none" }],
	["exactly soft/2 is not a shrink", armed("demanded"), { stopReason: "toolUse", tokens: 50, caps: CAPS }, { kind: "none" }],
	["idle below soft/2: no cycle to reset", cycle(), { stopReason: "toolUse", tokens: 10, caps: CAPS }, { kind: "none" }],
	// hard cap
	["one-jump crossing (idle, toolUse) → emergency demand", cycle(), { stopReason: "toolUse", tokens: 200, caps: CAPS }, { kind: "demand", origin: "hard-jump", tokens: 200 }],
	["idle, backstop-armed path, toolUse → emergency demand (phase decides, not path)", cycle({ expectedPath: PATH }), { stopReason: "toolUse", tokens: 300, caps: CAPS }, { kind: "demand", origin: "hard-jump", tokens: 300 }],
	["idle crossing without tool calls → backstop", cycle(), { stopReason: "stop", tokens: 200, caps: CAPS }, { kind: "hard-cap", tokens: 200 }],
	["demanded, toolUse, no handoff yet → one grace turn", armed("demanded"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-grace" }],
	["a silent-stop demand gets the grace too", armed("demanded", { origin: "silent" }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-grace" }],
	["grace is one-shot per cycle", armed("demanded", { hardGraceUsed: true }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace once the handoff is recorded", armed("demanded", { doc: DOC }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace for an exhausted cycle", armed("exhausted"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace without tool calls", armed("demanded"), { stopReason: "stop", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace without a cycle path", cycle({ phase: "demanded" }), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["no grace before the demand is in context", armed("pending"), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	["waiting /handoff + one-jump crossing → its demand moves to this turn", waitingManual(), { stopReason: "toolUse", tokens: 250, caps: CAPS }, { kind: "advance-demand", tokens: 250 }],
	["waiting /handoff + hard crossing without tool calls → backstop", waitingManual(), { stopReason: "stop", tokens: 250, caps: CAPS }, { kind: "hard-cap", tokens: 250 }],
	// soft cap
	["soft crossing mid-tool-use → demand", cycle(), { stopReason: "toolUse", tokens: 100, caps: CAPS }, { kind: "demand", origin: "soft", tokens: 100 }],
	["soft crossing without tool calls → left to turn_end silent stop", cycle(), { stopReason: "stop", tokens: 150, caps: CAPS }, { kind: "none" }],
	["soft crossing while a demand is out → nothing new", armed("demanded"), { stopReason: "toolUse", tokens: 150, caps: CAPS }, { kind: "none" }],
	["soft crossing during a joined /handoff → nothing new", armed("demanded", { origin: "manual", ending: "new-session" }), { stopReason: "toolUse", tokens: 150, caps: CAPS }, { kind: "none" }],
	["waiting /handoff + soft crossing → its demand moves to this turn", waitingManual(), { stopReason: "toolUse", tokens: 150, caps: CAPS }, { kind: "advance-demand", tokens: 150 }],
	["waiting /handoff + soft crossing without tool calls → stays at settle", waitingManual(), { stopReason: "stop", tokens: 150, caps: CAPS }, { kind: "none" }],
	["below soft → nothing", cycle(), { stopReason: "toolUse", tokens: 99, caps: CAPS }, { kind: "none" }],
];

for (const [name, state, input, expected] of messageEndRows) {
	test(`decideMessageEnd: ${name}`, () => {
		assert.deepEqual(decideMessageEnd(state, input), expected);
	});
}

test("messageEndTokens: fresh usage wins, failed stops and missing usage fall back", () => {
	assert.equal(messageEndTokens("toolUse", 120, 80), 120);
	assert.equal(messageEndTokens("stop", 0, 80), 0, "a real 0 reading is still a reading");
	assert.equal(messageEndTokens("stop", undefined, 80), 80);
	assert.equal(messageEndTokens("stop", Number.NaN, 80), 80);
	assert.equal(messageEndTokens("aborted", 0, 80), 80, "ESC-abort's zeroed usage must not reach the footer");
	assert.equal(messageEndTokens("error", 99, 80), 80);
	assert.equal(messageEndTokens("aborted", 0, undefined), undefined);
});

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
	["errored message", armed("demanded"), gate({ stopReason: "error" }), { kind: "skip-failed" }],
	["aborted message", armed("demanded"), gate({ stopReason: "aborted" }), { kind: "skip-failed" }],
	["errored outcome", armed("demanded"), gate({ outcome: "error" }), { kind: "skip-failed" }],
	["aborted outcome", armed("demanded"), gate({ outcome: "aborted" }), { kind: "skip-failed" }],
	["aborted signal", armed("demanded"), gate({ aborted: true }), { kind: "skip-failed" }],
	["failure beats an own staged swap (draft dropped)", armed("demanded", { stagedSwap: staged(OWN) }), gate({ outcome: "error" }), { kind: "skip-failed" }],
	["staged swap from another message → discarded", armed("demanded", { stagedSwap: staged(OTHER) }), gate(), { kind: "discard-stale-staged" }],
	["staged swap from this message → committed", armed("demanded", { stagedSwap: staged(OWN) }), gate(), { kind: "commit-staged" }],
	["nothing staged → evaluate", armed("demanded"), gate(), { kind: "evaluate" }],
];

for (const [name, state, input, expected] of turnGateRows) {
	test(`decideTurnGate: ${name}`, () => {
		assert.deepEqual(decideTurnGate(state, input), expected);
	});
}

const turn = (over: Partial<TurnEndInput> = {}): TurnEndInput => ({ tokens: 150, hasToolCalls: false, caps: CAPS, ...over });

const turnEndRows: Array<[string, CycleState, TurnEndInput, TurnEndAction]> = [
	// demand delivery
	["demand decided at this turn's message_end → commit it now", armed("pending"), turn({ hasToolCalls: true }), { kind: "commit-demand" }],
	["advanced /handoff demand → commit it now", armed("pending", { origin: "manual" }), turn({ hasToolCalls: true }), { kind: "commit-demand" }],
	["/handoff demand waiting for the settle → nothing at turn_end", waitingManual(), turn(), { kind: "none" }],
	// verification
	["handoff recorded → collect", armed("demanded", { doc: DOC }), turn({ hasToolCalls: true }), { kind: "collect", path: PATH }],
	["handoff recorded after exhaustion → collect", armed("exhausted", { doc: DOC }), turn(), { kind: "collect", path: PATH }],
	["verification runs with the cap disabled", armed("demanded", { doc: DOC }), turn({ caps: OFF, tokens: undefined }), { kind: "collect", path: PATH }],
	["still working (tool calls) → wait", armed("demanded"), turn({ hasToolCalls: true }), { kind: "keep-waiting" }],
	["exhausted → wait for the hard cap", armed("exhausted"), turn(), { kind: "keep-waiting" }],
	["no handoff, no tools → reminder 1", armed("demanded"), turn(), { kind: "remind", attempt: 1 }],
	["second refusal → reminder 2", armed("demanded", { retries: 1 }), turn(), { kind: "remind", attempt: 2 }],
	["a /handoff cycle is reminded too", armed("demanded", { origin: "manual" }), turn({ tokens: 10 }), { kind: "remind", attempt: 1 }],
	["reminders used up → exhausted", armed("demanded", { retries: MAX_RETRIES }), turn(), { kind: "exhaust" }],
	// silent stop
	["idle, crossed soft without tool calls → silent-stop demand", cycle(), turn({ tokens: 100 }), { kind: "silent-stop", tokens: 100 }],
	["idle, backstop-armed path → silent stop still fires (phase decides)", cycle({ expectedPath: PATH }), turn({ tokens: 150 }), { kind: "silent-stop", tokens: 150 }],
	["idle with tool calls → message_end's job", cycle(), turn({ hasToolCalls: true }), { kind: "none" }],
	["idle, cap disabled → nothing", cycle(), turn({ caps: OFF, tokens: 10_000_000 }), { kind: "none" }],
	["idle, unknown usage → nothing", cycle(), turn({ tokens: undefined }), { kind: "none" }],
	["idle, below soft → nothing", cycle(), turn({ tokens: 99 }), { kind: "none" }],
	["non-idle phase without a path → nothing (unreachable in practice)", cycle({ phase: "demanded" }), turn(), { kind: "none" }],
];

for (const [name, state, input, expected] of turnEndRows) {
	test(`decideTurnEnd: ${name}`, () => {
		assert.deepEqual(decideTurnEnd(state, input), expected);
	});
}

// ---------------------------------------------------------------------------
// /handoff
// ---------------------------------------------------------------------------

const manualRows: Array<[string, CycleState, boolean, ManualAction]> = [
	["nothing armed, idle → demand now, fresh cycle", cycle(), true, { kind: "demand-now", open: true }],
	["nothing armed, run in flight → demand at settle, fresh cycle", cycle(), false, { kind: "demand-at-settle", open: true }],
	["backstop-armed path only → still a fresh cycle", cycle({ expectedPath: PATH }), false, { kind: "demand-at-settle", open: true }],
	["document recorded, idle → finish now", armed("demanded", { doc: DOC }), true, { kind: "finish" }],
	["document recorded, run in flight → join (turn_end hands it over)", armed("demanded", { doc: DOC }), false, { kind: "join" }],
	["hard swap staged, run in flight → join", armed("demanded", { stagedSwap: { summary: "s" } as StagedSwap }), false, { kind: "join" }],
	["cap demand out, run in flight → join, no second demand", armed("demanded"), false, { kind: "join" }],
	["cap demand pending at this turn_end → join", armed("pending"), false, { kind: "join" }],
	["cap demand abandoned by an aborted run, idle → demand again", armed("demanded"), true, { kind: "demand-now", open: false }],
	["exhausted cycle, idle → demand again", armed("exhausted"), true, { kind: "demand-now", open: false }],
	["exhausted cycle, run in flight → demand at settle", armed("exhausted"), false, { kind: "demand-at-settle", open: false }],
];

for (const [name, state, idle, expected] of manualRows) {
	test(`decideManual: ${name}`, () => {
		assert.deepEqual(decideManual(state, idle), expected);
	});
}

// ---------------------------------------------------------------------------
// context: the LLM view (lib/context-cap-view.ts llmView)
// ---------------------------------------------------------------------------

const U = { role: "user", content: "task" };
const A = { role: "assistant", content: [{ type: "text", text: "done" }] };
const D1 = { role: "custom", customType: HANDOFF_DEMAND_TYPE, content: "[context-cap] ⚠️ demand" };
const D2 = { role: "custom", customType: HANDOFF_DEMAND_TYPE, content: "Write the handoff document" };
/** A cap warning from a session written before demands became boundary entries. */
const LEGACY = { role: "user", content: "[context-cap] ⚠️ old warning" };
const M = { role: "custom", customType: SWAP_MARKER_TYPE, content: "handoff" };
const POST = { role: "user", content: "after the swap" };

const viewRows: Array<[string, unknown[], number, unknown[], boolean]> = [
	["no marker: untouched, demands stand", [U, D1, A, D2], 0, [U, D1, A, D2], false],
	["no marker: legacy warnings stand too (never rewrite a marker-less view)", [U, LEGACY, A], 0, [U, LEGACY, A], false],
	["marker: everything before it is cut (tail off)", [U, A, M, POST], 0, [M, POST], true],
	["marker first: nothing to cut", [M, POST], 0, [M, POST], false],
	["demand behind the marker cut, after it kept", [U, D1, M, D2], 0, [M, D2], true],
	["tail lever keeps whole turns before the marker", [U, A, M], 1000, [U, A, M], false],
	["tail lever never keeps a behind-marker demand", [U, D1, A, M], 1000, [U, A, M], true],
	["tail lever never keeps a behind-marker legacy warning", [U, LEGACY, A, M], 1000, [U, A, M], true],
];

for (const [name, messages, tail, expected, changed] of viewRows) {
	test(`llmView: ${name}`, () => {
		const view = llmView(messages, tail);
		assert.deepEqual({ messages: [...view.messages], changed: view.changed }, { messages: expected, changed });
	});
}
