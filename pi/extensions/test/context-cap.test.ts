/**
 * context-cap handoff continuation: the whole soft-cap cycle — steer, handoff
 * write, swap marker, post-swap turn — must complete INSIDE one `session.prompt()`
 * call. This is the invariant that lets the Agent tool await a child's prompt()
 * without a pending-work claim for handoffs: every continuation (steered marker,
 * followUp reminders) is drained by pi's `_runAgentPrompt` loop before the run
 * settles. If this test ever fails after a `pi update`, handoffs need a claim
 * again (see lib/pending-work.ts).
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, textStep, toolStep } from "./harness.ts";
import { hasPendingWork } from "../lib/pending-work.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

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
		assert.ok(
			texts.includes("continued after swap"),
			`post-swap turn must complete inside prompt(), got: ${JSON.stringify(texts)}`,
		);

		// The swap really happened (marker entry persisted in the session).
		const marker = (t.session.messages as Array<{ role: string; customType?: string }>).find(
			(m) => m.role === "custom" && m.customType === "context-cap-swap",
		);
		assert.ok(marker, "swap marker must be in the session");

		// The handoff file was written by the tool.
		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1, "exactly one handoff file for this session");

		// And no pending-work claim was ever needed for any of it.
		assert.equal(hasPendingWork(sessionId), false);
	} finally {
		try {
			for (const n of fs.readdirSync(CAP_DIR)) {
				if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
			}
		} catch {}
		t.dispose();
	}
});
