/**
 * context-cap handoff continuation: the whole soft-cap cycle — steer, handoff
 * write, swap marker, post-swap turn — must complete INSIDE one `session.prompt()`
 * call. This is the invariant that lets the Agent tool await a child's prompt()
 * (plus the queue grace in lib/session-quiet.ts) and treat the child as done:
 * every continuation (steered marker, followUp reminders) is drained by pi's
 * `_runAgentPrompt` loop before the run settles. If this test ever fails after a
 * `pi update`, the Agent tool needs a new "child not finished yet" signal for
 * handoffs.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, textStep, toolStep } from "./harness.ts";
import { SWAP_MARKER_TYPE } from "../lib/message-types.ts";
import { contextCapDir } from "../lib/agent-dir.ts";
import { at } from "./assert-helpers.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");

function assistantTexts(session: { messages: Array<{ role: string; content?: unknown }> }): string[] {
	return session.messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text ?? "");
}

test("soft-cap handoff cycle completes inside a single prompt() call", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 20,
		script: [
			// Tokens 10 >= soft cap 5, stopReason toolUse -> steer requesting a handoff.
			// (timer cancel is just a harmless tool call to produce the toolUse stop.)
			toolStep("s1", "timer", { action: "cancel" }, 10),
			// The steered warning arrives; the agent writes the handoff.
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nFinish the demo." }, 10),
			// Turn ends -> verification swaps (steered marker) -> continuation turn.
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	try {
		await t.session.prompt("start");

		// The load-bearing assertion: when prompt() resolves, the POST-SWAP turn has
		// already happened — the swap continuation never escapes the awaited run.
		assert.equal(t.session.isIdle, true);
		const texts = assistantTexts(t.session);
		assert.equal(
			texts.filter((text) => text === "continued after swap").length,
			1,
			`exactly one post-swap continuation must run, got: ${JSON.stringify(texts)}`,
		);
		assert.equal(texts.includes("(script exhausted)"), false, "swap must not start a continuation loop");

		// Exactly one marker must be persisted, returned through the turn_end boundary.
		const sessionMessages = t.session.messages as Array<{ role: string; customType?: string }>;
		const markers = sessionMessages.filter((m) => m.role === "custom" && m.customType === SWAP_MARKER_TYPE);
		assert.equal(markers.length, 1, "swap marker must appear exactly once");
		const lastToolResult = sessionMessages.map((m) => m.role).lastIndexOf("toolResult");
		assert.ok(sessionMessages.indexOf(at(markers, 0)) > lastToolResult, "swap marker must follow tool-result entries");

		// The handoff file was written by the tool.
		const files = fs.readdirSync(contextCapDir()).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1, "exactly one handoff file for this session");
	} finally {
		try {
			for (const n of fs.readdirSync(contextCapDir())) {
				if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(contextCapDir(), n), { force: true });
			}
		} catch {
			// best-effort cleanup: the handoff dir may not exist
		}
		t.dispose();
	}
});
