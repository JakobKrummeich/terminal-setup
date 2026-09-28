/**
 * lib/context-cap-view.ts, the pieces context-cap-defaults.test.ts does not
 * table: per-part accounting of the token estimate and the pairing walk's
 * less common shapes. Pure — no session, no env.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageTokens, isCapWarning, selectContextTail } from "../lib/context-cap-view.ts";

/** Envelope (4) + ceil(chars / 4). */
const est = (chars: number) => 4 + Math.ceil(chars / 4);

test("estimate: every counted field, one row each", () => {
	const unserializable = { big: 1n };
	const rows: [string, unknown, number][] = [
		["null message", null, est(0)],
		["no content", { role: "user" }, est(0)],
		["string content", { role: "user", content: "x".repeat(10) }, est(10)],
		["non-array object content", { role: "user", content: { text: "ignored" } }, est(0)],
		["text part", { content: [{ type: "text", text: "abcd" }] }, est(4)],
		["thinking part", { content: [{ type: "thinking", thinking: "abcdefgh" }] }, est(8)],
		["image part (flat guess)", { content: [{ type: "image", data: "…" }] }, est(4000)],
		[
			"toolCall: name + JSON arguments",
			{ content: [{ type: "toolCall", name: "read", arguments: { p: 1 } }] },
			est(4 + JSON.stringify({ p: 1 }).length),
		],
		["toolCall without name or arguments", { content: [{ type: "toolCall" }] }, est(JSON.stringify("").length)],
		[
			"toolCall with unserializable arguments",
			{ content: [{ type: "toolCall", name: "ab", arguments: unserializable }] },
			est(2 + 200),
		],
		["null part", { content: [null, { type: "text", text: "ab" }] }, est(2)],
		["summary / command / output", { summary: "a", command: "bb", output: "ccc" }, est(6)],
		["non-string extras ignored", { summary: 5, command: null, output: {} }, est(0)],
		[
			"all parts summed before rounding",
			{ content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }], output: "c" },
			est(3),
		],
	];
	for (const [label, message, expected] of rows) assert.equal(estimateMessageTokens(message), expected, label);
});

const user = { role: "user", content: "u" };
const marker = { role: "custom", customType: "context-cap-swap", content: "handoff" };
const call = (...ids: (string | undefined)[]) => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "r", arguments: {} })),
});
const result = (toolCallId?: string) => ({ role: "toolResult", toolCallId, content: [] });

test("tail pairing: shapes around the walk", () => {
	const rows: [string, unknown[], number][] = [
		// [label, messages ending in the marker, expected start]
		["one assistant, two calls, both answered", [user, call("a", "b"), result("a"), result("b"), marker], 0],
		["one of two calls unanswered: keep nothing", [user, call("a", "b"), result("a"), marker], 3],
		["result without a toolCallId pins nothing", [user, result(undefined), marker], 0],
		["toolCall without an id is not a call", [user, call(undefined), marker], 0],
		["non-toolCall assistant parts are ignored", [user, { role: "assistant", content: [{ type: "text", text: "t" }] }, marker], 0],
		["assistant with non-array content", [user, { role: "assistant", content: "t" }, marker], 0],
		["a later user message is the safe cut when earlier pairs break", [call("x"), result("y"), user, marker], 2],
	];
	for (const [label, msgs, start] of rows) {
		assert.equal(selectContextTail(msgs, msgs.length - 1, 100_000).start, start, label);
	}
});

test("isCapWarning: user role only, first text part decides", () => {
	const rows: [unknown, boolean][] = [
		[{ role: "user", content: "[context-cap] x" }, true],
		[{ role: "user", content: [{ type: "image" }, { type: "text", text: "[context-cap] x" }] }, true],
		[{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "[context-cap] x" }] }, false],
		[{ role: "assistant", content: "[context-cap] x" }, false],
		[{ role: "user", content: "x [context-cap]" }, false],
		[{ role: "user" }, false],
		[null, false],
	];
	for (const [message, expected] of rows) assert.equal(isCapWarning(message), expected, JSON.stringify(message));
});
