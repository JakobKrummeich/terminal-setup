/**
 * extractWireSystemPrompt: the system instructions pulled out of each
 * provider's wire payload shape (Anthropic messages, OpenAI responses,
 * OpenAI completions), and undefined when a payload carries none.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractWireSystemPrompt } from "../dump-system-prompt.ts";

test("extractWireSystemPrompt: one row per wire shape", () => {
	const rows: [string, unknown, string | undefined][] = [
		["non-object payload", "system", undefined],
		["null payload", null, undefined],
		["anthropic string", { system: "S" }, "S"],
		["anthropic blocks", { system: ["a", { type: "text", text: "b" }, { type: "image" }, 7] }, "a\nb\n\n"],
		["anthropic wins over instructions", { system: "S", instructions: "I" }, "S"],
		["openai responses", { instructions: "I", messages: [{ role: "system", content: "M" }] }, "I"],
		[
			"openai completions: system + developer, string/array/other content",
			{
				messages: [
					{ role: "system", content: "one" },
					{ role: "user", content: "skip" },
					{ role: "developer", content: [{ text: "two" }, { type: "image" }] },
					{ role: "system", content: 5 },
				],
			},
			"one\ntwo\n\n",
		],
		["no system messages", { messages: [{ role: "user", content: "hi" }] }, undefined],
		["messages not an array", { messages: "nope" }, undefined],
		["non-string system/instructions ignored", { system: 5, instructions: 6 }, undefined],
	];
	for (const [name, payload, expected] of rows) {
		assert.equal(extractWireSystemPrompt(payload), expected, name);
	}
});
