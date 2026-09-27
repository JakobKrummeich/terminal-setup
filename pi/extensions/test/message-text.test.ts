/**
 * lib/message-text.ts: the one "text of a message's content" helper used by
 * timer.ts, handoff.ts, lib/child-session.ts and lib/child-view.ts. Pins the exact output those
 * call sites had before they shared it ("\n" join, text blocks only).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { messageText } from "../lib/message-text.ts";

test("messageText: string content is returned verbatim", () => {
	assert.equal(messageText("  hello\n"), "  hello\n");
});

test("messageText: text blocks joined with newline, other blocks dropped", () => {
	assert.equal(
		messageText([
			{ type: "text", text: "a" },
			{ type: "image", data: "…" },
			{ type: "toolCall", name: "x" },
			{ type: "text", text: "b" },
		]),
		"a\nb",
	);
	// A text block without text still takes its slot (empty line), as the old copies did.
	assert.equal(messageText([{ type: "text" }, { type: "text", text: "b" }]), "\nb");
	assert.equal(messageText([null, { type: "text", text: "b" }]), "b", "null blocks are skipped, not thrown on");
});

test("messageText: missing or non-text content yields empty string", () => {
	assert.equal(messageText(undefined), "");
	assert.equal(messageText(null), "");
	assert.equal(messageText([]), "");
	assert.equal(messageText({ type: "text", text: "not an array" }), "");
});
