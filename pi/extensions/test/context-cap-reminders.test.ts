/**
 * context-cap reminder budget, end to end: an agent that ignores the handoff
 * demand gets exactly MAX_RETRIES (2) followUp reminders, then the cycle goes
 * "exhausted" — silent, waiting for the hard-cap backstop — and a handoff the
 * agent still writes later is collected by the same cycle (soft swap).
 *
 * The decision itself is table-tested in context-cap-decisions.test.ts; this
 * pins the handler wiring (the retry counter must advance per reminder, or the
 * agent is reminded forever).
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, textStep, toolStep, type TestSession } from "./harness.ts";
import { SWAP_MARKER_TYPE } from "../lib/message-types.ts";
import { contextCapDir } from "../lib/agent-dir.ts";
import { at } from "./assert-helpers.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");

function reminders(t: TestSession): string[] {
	return t.deliveredUserMessages.map((m) => m.text).filter((text) => text.includes("No handoff was recorded"));
}

test("two reminders, then exhausted and silent; a late handoff still swaps", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 5,
		script: [
			// Tokens 10 >= soft 5, toolUse -> soft steer.
			toolStep("s1", "timer", { action: "cancel" }, 10),
			// Three refusals (no tool calls): reminder 1/2, reminder 2/2, exhausted.
			textStep("refusal 1", 10),
			textStep("refusal 2", 10),
			textStep("refusal 3", 10),
			// User re-prompts: another refusal while exhausted -> no reminder.
			textStep("refusal 4", 10),
			// User re-prompts: the agent finally writes the handoff -> soft swap.
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nLate but written." }, 10),
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();
	try {
		await t.session.prompt("start");
		assert.deepEqual(
			reminders(t).map((r) => r.match(/reminder (\d\/\d)/)?.[1]),
			["1/2", "2/2"],
			`exactly two reminders before exhaustion, got: ${JSON.stringify(reminders(t))}`,
		);

		await t.session.prompt("go on");
		assert.equal(reminders(t).length, 2, "an exhausted cycle sends no further reminder");

		await t.session.prompt("write the handoff now");
		assert.equal(t.session.isIdle, true);
		const markers = (t.session.messages as Array<{ role: string; customType?: string; details?: { trigger?: string } }>).filter(
			(m) => m.role === "custom" && m.customType === SWAP_MARKER_TYPE,
		);
		assert.equal(markers.length, 1, "one swap");
		assert.equal(at(markers, 0).details?.trigger, "soft", "the exhausted cycle still collects the agent's handoff");
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
