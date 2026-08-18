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

const { HANDOFF_PROMPT, HANDOFF_PREAMBLE } = handoffModule as unknown as {
	HANDOFF_PROMPT: string;
	HANDOFF_PREAMBLE: string;
};

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

test("extension registers the /handoff command", () => {
	const commands: string[] = [];
	defaultExport(handoffModule)({
		on: () => {},
		registerCommand: (name: string) => commands.push(name),
	});
	assert.deepEqual(commands, ["handoff"]);
});
