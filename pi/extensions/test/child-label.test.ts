/**
 * lib/child-session.ts labelFromPrompt: the description a child gets when the
 * Agent/Explore call passes none. It lands in the spawn row of agent-runs.jsonl,
 * so the F2 picker, the dashboard and a post-restart reopen all show it; the
 * wiring itself is pinned in agent-runs.test.ts. These pin the shaping rules.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { labelFromPrompt } from "../lib/child-session.ts";

test("labelFromPrompt: first five words of the first non-blank line, whitespace collapsed", () => {
	assert.equal(labelFromPrompt("Find the parser entry point in src and report"), "Find the parser entry point");
	assert.equal(labelFromPrompt("\n   \n\t fix  the\tbug \nsecond line words"), "fix the bug", "leading blank lines skipped");
	assert.equal(labelFromPrompt("one\ntwo three"), "one", "never reaches past the first non-blank line");
});

test("labelFromPrompt: empty or whitespace-only prompt → 'agent task'", () => {
	assert.equal(labelFromPrompt(""), "agent task");
	assert.equal(labelFromPrompt("  \n\t\n "), "agent task");
});

test("labelFromPrompt: over 48 chars → cut to 47 + ellipsis; exactly 48 kept verbatim", () => {
	const long = `${"a".repeat(24)} ${"b".repeat(24)}`;
	assert.equal(long.length, 49, "one past the cap");
	const label = labelFromPrompt(long);
	assert.equal(label, `${long.slice(0, 47)}\u2026`);
	assert.equal(label.length, 48);
	const exact = `${"c".repeat(23)} ${"d".repeat(24)}`;
	assert.equal(exact.length, 48);
	assert.equal(labelFromPrompt(exact), exact);
});
