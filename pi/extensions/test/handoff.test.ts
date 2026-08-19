/**
 * /handoff prompt alignment: the section list and line budget must come from
 * lib/handoff-writer.ts — the same source context-cap quotes — so the
 * CONTEXT_CAP_SCHEMA lever governs both and the two handoff flavours never
 * drift apart. Delivery differences (reply-harvest, no auto-continue) are the
 * command's own contract and are pinned in the prompt text itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as handoffModule from "../handoff.ts";
import { handoffLineBudget, handoffSections } from "../lib/handoff-writer.ts";

const { HANDOFF_PROMPT, HANDOFF_PREAMBLE, extractHandoffSummary } = handoffModule as unknown as {
	HANDOFF_PROMPT: string;
	HANDOFF_PREAMBLE: string;
	extractHandoffSummary: (
		branch: Array<{ type: string; message?: { role?: string; stopReason?: string; content?: unknown } }>,
	) => { ok: true; text: string } | { ok: false; reason: string };
};

const assistant = (content: unknown, stopReason = "stop") => ({
	type: "message",
	message: { role: "assistant", stopReason, content },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

// ESM/CJS interop unwrap, same pattern as kill-switch.test.ts.
type ExtensionFn = (pi: unknown) => void;
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

test("/handoff quotes the live schema: sections and budget from lib/handoff-writer.ts", () => {
	assert.ok(HANDOFF_PROMPT.includes(handoffSections()), "section list must be the shared one, verbatim");
	assert.ok(HANDOFF_PROMPT.includes(`~${handoffLineBudget()} lines`), "line budget must be the shared one");
	// The v2 essentials the old 4-bullet prompt lacked — present via the shared list.
	for (const needle of ['"## Current Task"', '"## Files"', '"## Next Step"', '"## Dead Ends"']) {
		assert.ok(HANDOFF_PROMPT.includes(needle), `prompt must demand ${needle}`);
	}
});

test("/handoff is reply-mode: document as reply, tools banned, no auto-continue suffix", () => {
	assert.match(HANDOFF_PROMPT, /as your reply/);
	assert.match(HANDOFF_PROMPT, /do NOT call any tools/);
	assert.match(HANDOFF_PROMPT, /not even context_handoff/);
	// The successor stays interactive: the injected message must not tell it to
	// continue on its own (that suffix belongs to context-cap's swap summary).
	assert.ok(!HANDOFF_PROMPT.includes("Continue your work."), "no auto-continue instruction");
});

test("preamble matches context-cap's swap preamble byte for byte", () => {
	// Keep in sync with PREAMBLE in context-cap.ts: successors read the same
	// opening line whether the handoff came from a cap swap or from /handoff.
	assert.equal(
		HANDOFF_PREAMBLE,
		"You are continuing work from a previous session. The agent before you left you this information:",
	);
});

test("harvest accepts only a clean, non-empty reply", () => {
	const doc = "## Current Task\nfinish the demo";
	assert.deepEqual(
		extractHandoffSummary([user("prompt"), assistant([{ type: "text", text: doc }])]),
		{ ok: true, text: doc },
	);
	assert.deepEqual(extractHandoffSummary([assistant(doc)]), { ok: true, text: doc }, "string content");
	// The newest assistant message wins — never an older one.
	const r = extractHandoffSummary([assistant("old reply"), user("prompt"), assistant("new doc")]);
	assert.deepEqual(r, { ok: true, text: "new doc" });
});

test("harvest rejects errored, aborted and empty replies — even with partial text", () => {
	// Observed live: a timed-out request synthesizes stopReason 'error'. With
	// partial streamed text attached, seeding it would ship a truncated handoff.
	const errored = extractHandoffSummary([
		assistant([{ type: "text", text: "## Current Task\ntruncated half-docu" }], "error"),
	]);
	assert.equal(errored.ok, false);
	assert.match((errored as { reason: string }).reason, /failed.*run \/handoff again/);

	const aborted = extractHandoffSummary([assistant("partial", "aborted")]);
	assert.equal(aborted.ok, false);
	assert.match((aborted as { reason: string }).reason, /aborted.*run \/handoff again/);

	assert.equal(extractHandoffSummary([assistant([])]).ok, false, "empty reply");
	assert.equal(extractHandoffSummary([assistant("   ")]).ok, false, "whitespace-only reply");
	assert.equal(extractHandoffSummary([user("prompt only")]).ok, false, "no assistant at all");
});

test("extension registers the /handoff command", () => {
	const commands: string[] = [];
	defaultExport(handoffModule)({
		on: () => {},
		registerCommand: (name: string) => commands.push(name),
	});
	assert.deepEqual(commands, ["handoff"]);
});
