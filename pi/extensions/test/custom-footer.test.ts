/**
 * custom-footer.ts sessionCost: the main footer's `$` figure. It replaces pi's
 * built-in footer, so it must sum the same entries pi's footer and
 * AgentSession.getSessionStats() do (the F2 child footer shows the latter) —
 * not only assistant messages, which hid every compaction summary (including
 * context-cap's own machine-written one), cache warming and billed tool calls.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionCost } from "../custom-footer.ts";

const usage = (total: number) => ({ cost: { total } });

test("sessionCost: every billed entry kind counts, like pi's own footer", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", usage: usage(0.5) } },
		{ type: "message", message: { role: "toolResult", usage: usage(0.25) } },
		{ type: "message", message: { role: "toolResult" } },
		{ type: "compaction", usage: usage(0.125) },
		{ type: "compaction" },
		{ type: "branch_summary", usage: usage(0.0625) },
		{ type: "usage", kind: "cache_warm", usage: usage(0.03125) },
		{ type: "custom_message", customType: "context-cap-swap" },
	] as unknown as SessionEntry[];
	assert.equal(sessionCost(entries), 0.96875);
});

test("sessionCost: an empty session costs nothing", () => {
	assert.equal(sessionCost([]), 0);
});
