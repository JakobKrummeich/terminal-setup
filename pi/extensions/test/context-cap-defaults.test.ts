/**
 * context-cap levers, pure half: the configured defaults and the recency-tail
 * slicer. No session, no env — this file pins what an unconfigured install does.
 *
 * The slicer is the risky part of the tail lever: a tool result whose toolCall
 * was cut, or a toolCall whose result was cut, is a provider error, i.e. strictly
 * worse than keeping nothing. Every degenerate case below must therefore end in
 * "keep nothing" rather than in a clever partial answer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageTokens, selectContextTail } from "../context-cap.ts";
import {
	CONTEXT_CAP_HARD_TRIGGER,
	CONTEXT_CAP_SCHEMA,
	CONTEXT_CAP_SOFT_TRIGGER,
	CONTEXT_CAP_TAIL_TOKENS,
} from "../lib/env.ts";
import { handoffLineBudget, handoffSections, HANDOFF_SECTIONS_V1, HANDOFF_SECTIONS_V2 } from "../lib/handoff-writer.ts";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("trigger defaults: soft 260k, hard 325k, hard = 1.25 x soft", () => {
	// The constants resolve at import time and ESM hoists imports above any
	// statement in this file, so it cannot scrub its own environment. Assert the
	// precondition instead: defaults are only meaningful with nothing set.
	for (const key of ["CONTEXT_CAP_SOFT", "CONTEXT_CAP_HARD", "CONTEXT_CAP_SCHEMA", "CONTEXT_CAP_TAIL_TOKENS"]) {
		assert.equal(process.env[key], undefined, `${key} must be unset when checking defaults`);
	}
	assert.equal(CONTEXT_CAP_SOFT_TRIGGER, 260_000);
	assert.equal(CONTEXT_CAP_HARD_TRIGGER, 325_000);
	assert.equal(CONTEXT_CAP_HARD_TRIGGER, CONTEXT_CAP_SOFT_TRIGGER * 1.25);
	// The fresh-window reset guard is SOFT/2 and must stay derived, not pinned.
	assert.equal(CONTEXT_CAP_SOFT_TRIGGER / 2, 130_000);
});

test("lever defaults: schema v2, no recency tail", () => {
	assert.equal(CONTEXT_CAP_SCHEMA, "v2");
	assert.equal(CONTEXT_CAP_TAIL_TOKENS, 0);
	assert.equal(handoffSections(), HANDOFF_SECTIONS_V2, "the default schema selects the v2 text");
	assert.equal(handoffLineBudget(), 60);
	assert.equal(handoffLineBudget("v1"), 30);
	assert.equal(handoffSections("v1"), HANDOFF_SECTIONS_V1);
});

test("v2 is the path-heavy schema: files section, imperative, real paths only", () => {
	assert.match(HANDOFF_SECTIONS_V2, /"## Current Task" — FIRST section/);
	assert.match(HANDOFF_SECTIONS_V2, /"## Files" — EVERY path/);
	assert.match(HANDOFF_SECTIONS_V2, /`path — state`/);
	assert.match(HANDOFF_SECTIONS_V2, /no globs, no bare directory names/);
	assert.match(HANDOFF_SECTIONS_V2, /unverified/);
	assert.match(HANDOFF_SECTIONS_V2, /"## Dead Ends"/);
	// No repo/VCS section: the cwd is often not the repo the work is in, so a
	// handoff cannot answer `git status` reliably. See lib/handoff-writer.ts.
	assert.doesNotMatch(HANDOFF_SECTIONS_V2, /Repo State|git status|git log|branch/);
	assert.equal(HANDOFF_SECTIONS_V2.split("\n").length, 6, "six sections, one line each");
});

// ---------------------------------------------------------------------------
// Recency-tail slicer
// ---------------------------------------------------------------------------

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (callIds: string[], text = "ok") => ({
	role: "assistant",
	content: [
		{ type: "text", text },
		...callIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: "/tmp/x" } })),
	],
	timestamp: 1,
});
const toolResult = (id: string, text = "result") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});
const marker = () => ({ role: "custom", customType: "context-cap-swap", content: "handoff", display: true, timestamp: 1 });

/** [user, assistant(call), toolResult] x turns, then the swap marker. */
function transcript(turns: number, textLen = 40): unknown[] {
	const msgs: unknown[] = [];
	for (let i = 0; i < turns; i++) {
		msgs.push(user(`prompt ${i} `.padEnd(textLen, "p")));
		msgs.push(assistant([`c${i}`], `working ${i}`));
		msgs.push(toolResult(`c${i}`, `output ${i} `.padEnd(textLen, "o")));
	}
	msgs.push(marker());
	return msgs;
}

/** Re-checks pairing on a slice the way a provider would. */
function isPaired(msgs: readonly unknown[]): boolean {
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();
	for (const raw of msgs) {
		const m = raw as { role?: string; content?: unknown; toolCallId?: string };
		if (m.role === "assistant") {
			for (const c of (Array.isArray(m.content) ? m.content : []) as { type?: string; id?: string }[]) {
				if (c.type === "toolCall" && typeof c.id === "string") seenCalls.add(c.id);
			}
		} else if (m.role === "toolResult") {
			if (!m.toolCallId || !seenCalls.has(m.toolCallId)) return false; // orphan result
			seenResults.add(m.toolCallId);
		}
	}
	for (const id of seenCalls) if (!seenResults.has(id)) return false; // dangling call
	return true;
}

test("tail budget 0 keeps nothing — the pre-lever slice, exactly", () => {
	const msgs = transcript(3);
	const markerIndex = msgs.length - 1;
	assert.deepEqual(selectContextTail(msgs, markerIndex, 0), { start: markerIndex, tokens: 0 });
	assert.deepEqual(selectContextTail(msgs, markerIndex, -5), { start: markerIndex, tokens: 0 });
	assert.deepEqual(selectContextTail(msgs, markerIndex, Number.NaN), { start: markerIndex, tokens: 0 });
	assert.deepEqual(selectContextTail(msgs, 0, 10_000), { start: 0, tokens: 0 }, "no marker prefix, nothing to keep");
});

test("a budget that covers everything keeps everything, from the first message", () => {
	const msgs = transcript(3);
	const markerIndex = msgs.length - 1;
	const tail = selectContextTail(msgs, markerIndex, 100_000);
	assert.equal(tail.start, 0);
	assert.ok(tail.tokens > 0);
	assert.equal(isPaired(msgs.slice(tail.start, markerIndex)), true);
});

test("the budget is respected and the cut lands on a turn boundary", () => {
	const msgs = transcript(6, 400);
	const markerIndex = msgs.length - 1;
	const full = selectContextTail(msgs, markerIndex, 100_000).tokens;
	const budget = Math.floor(full / 3);

	const tail = selectContextTail(msgs, markerIndex, budget);
	assert.ok(tail.start > 0 && tail.start < markerIndex, `expected a partial tail, got start=${tail.start}`);
	assert.ok(tail.tokens <= budget, `kept ${tail.tokens} tokens > budget ${budget}`);
	assert.equal((msgs[tail.start] as { role: string }).role, "user", "cuts start a complete turn");
	assert.equal(isPaired(msgs.slice(tail.start, markerIndex)), true);

	// It is the EARLIEST boundary that fits: one turn more must not fit.
	const oneTurnEarlier = selectContextTail(msgs, markerIndex, 100_000);
	assert.ok(oneTurnEarlier.tokens > budget, "sanity: the full tail is over budget");
	const bigger = selectContextTail(msgs, markerIndex, budget * 2);
	assert.ok(bigger.start < tail.start, "a bigger budget reaches further back");
});

test("a boundary that would orphan a tool result is skipped, not taken", () => {
	// pi can inject a user message (a context-cap steer) between an assistant's
	// tool call and its result. Cutting at that user message orphans the result.
	const msgs = [
		user("first"),
		assistant(["a1"]),
		user("injected steer"),
		toolResult("a1"),
		marker(),
	];
	const tail = selectContextTail(msgs, msgs.length - 1, 100_000);
	assert.equal(tail.start, 0, "must walk past the unsafe boundary to the one before the tool call");
	assert.equal(isPaired(msgs.slice(tail.start, msgs.length - 1)), true);
});

test("a tool call whose result is beyond the marker: keep nothing", () => {
	const msgs = [user("first"), assistant(["a1"]), toolResult("a1"), user("second"), assistant(["a2"]), marker()];
	const markerIndex = msgs.length - 1;
	const tail = selectContextTail(msgs, markerIndex, 100_000);
	assert.deepEqual(tail, { start: markerIndex, tokens: 0 }, "no safe boundary ⇒ keep nothing, never a broken pair");
});

test("no safe boundary inside the budget: keep nothing", () => {
	const msgs = [user("x".repeat(4000)), assistant(["a1"]), toolResult("a1", "y".repeat(4000)), marker()];
	const markerIndex = msgs.length - 1;
	// Enough for the tool result alone, nowhere near the user message that would
	// make the slice safe.
	const tail = selectContextTail(msgs, markerIndex, 1100);
	assert.deepEqual(tail, { start: markerIndex, tokens: 0 });
});

test("messages with no content at all never throw and cost only the envelope", () => {
	const msgs = [{}, undefined, { role: "user" }, marker()];
	const tail = selectContextTail(msgs, 3, 100);
	assert.ok(tail.start <= 2, "a shapeless prefix is still cuttable");
	assert.equal(estimateMessageTokens(undefined), 4);
	assert.equal(estimateMessageTokens({ role: "user", content: "x".repeat(400) }), 104, "chars/4 plus envelope");
	assert.equal(
		estimateMessageTokens({ role: "assistant", content: [{ type: "text", text: "x".repeat(400) }] }),
		104,
	);
	assert.ok(
		estimateMessageTokens({ role: "bashExecution", command: "ls", output: "z".repeat(400) }) >= 100,
		"bashExecution text lives outside `content` and must still be counted",
	);
});
