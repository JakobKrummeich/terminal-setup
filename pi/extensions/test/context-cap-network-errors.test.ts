/**
 * context-cap under network errors (flaky-network bug, observed live 2026-08):
 *
 * pi's failure path (handleRunFailure) synthesizes an assistant message with
 * stopReason "error"/"aborted" and still fires message_end + turn_end
 * (toolResults []). The old state machine treated those synthetic events as
 * agent decisions:
 *  - each errored turn_end burned a reminder retry — two network blips pushed
 *    the cycle to "exhausted" although the agent never saw a single reminder,
 *    and the queued reminders were delivered much later, possibly into a fresh
 *    post-swap window (stale handoff demands);
 *  - an errored message_end during a hard-cap cycle skipped the grace gate
 *    (stopReason !== "toolUse") and fired the hard-no-file backstop wipe
 *    mid-flake, with the handoff still perfectly reachable.
 *
 * Also covered: a cycle whose context shrank under it (swap/compaction raced an
 * error, or the steer was dropped) must reset instead of demanding a handoff
 * from a fresh window, and cap messages must carry a stale-ignore clause.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { abortedStep, createTestSession, errorStep, textStep, toolStep, type TestSession } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

interface SwapMarker {
	role: string;
	customType?: string;
	details?: { trigger?: string; handoffPath?: string | null };
}

function swapMarkers(t: TestSession): SwapMarker[] {
	return (t.session.messages as SwapMarker[]).filter(
		(m) => m.role === "custom" && m.customType === "context-cap-swap",
	);
}

function delivered(t: TestSession, needle: string): string[] {
	return t.deliveredUserMessages.map((m) => m.text).filter((text) => text.includes(needle));
}

function toolResultTexts(t: TestSession): string[] {
	return (t.session.messages as Array<{ role: string; content?: unknown }>)
		.filter((m) => m.role === "toolResult")
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text ?? "");
}

function cleanup(t: TestSession, sessionId: string) {
	try {
		for (const n of fs.readdirSync(CAP_DIR)) {
			if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
		}
	} catch {}
	t.dispose();
}

test("errored turns don't burn reminder retries; the cycle survives a flaky patch", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 20,
		script: [
			// Tokens 10 >= soft 5, toolUse -> steer requesting a handoff.
			toolStep("s1", "timer", { action: "cancel" }, 10),
			// Two network deaths in a row. Old code: turn_end x2 -> retries 2/2 ->
			// phase "exhausted", both reminders queued although the agent saw nothing.
			errorStep(),
			errorStep(),
			// Network back. A real turn WITHOUT a handoff -> this must get reminder 1/2.
			textStep("network is back, still working", 10),
			// The reminder arrives; the agent complies.
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nFinish the demo." }, 10),
			// Post-swap continuation.
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	try {
		// Each errored run settles (nothing queued); the user re-prompts, as live.
		await t.session.prompt("start");
		await t.session.prompt("retry after network blip");
		await t.session.prompt("retry again");

		assert.equal(t.session.isIdle, true);

		const reminders = delivered(t, "No handoff was recorded");
		assert.equal(
			reminders.length,
			1,
			`exactly one reminder, sent for the real refusal turn, got: ${JSON.stringify(reminders)}`,
		);
		assert.ok(reminders[0].includes("reminder 1/2"), "the two errored turns must not have consumed retries");

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1, "one swap");
		assert.equal(markers[0].details?.trigger, "soft", "handoff-backed swap, not a backstop wipe");

		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1, "the handoff file was written");
	} finally {
		cleanup(t, sessionId);
	}
});

test("an aborted turn is skipped the same way: no retry burn, no spurious swap", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "cancel" }, 10),
			// User hits ESC while the steered turn's call is in flight.
			abortedStep(),
			// Resumed later: a real turn without a handoff -> reminder 1/2, not 2/2.
			textStep("resumed, still working", 10),
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nFinish the demo." }, 10),
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	try {
		await t.session.prompt("start");
		await t.session.prompt("resume after abort");

		assert.equal(t.session.isIdle, true);

		// The branch under test really ran: the synthesized message says "aborted".
		const aborted = (t.session.messages as Array<{ role: string; stopReason?: string }>).filter(
			(m) => m.role === "assistant" && m.stopReason === "aborted",
		);
		assert.equal(aborted.length, 1, "the aborted assistant message is in the session");

		const reminders = delivered(t, "No handoff was recorded");
		assert.equal(reminders.length, 1, `one reminder for the real refusal turn, got: ${JSON.stringify(reminders)}`);
		assert.ok(reminders[0].includes("reminder 1/2"), "the aborted turn must not have consumed a retry");

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1, "one swap");
		assert.equal(markers[0].details?.trigger, "soft", "handoff-backed swap, not a backstop wipe");
	} finally {
		cleanup(t, sessionId);
	}
});

test("a network error during a hard-cap cycle must not fire the no-file backstop wipe", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 20,
		script: [
			// One-jump crossing: 60 >= hard 50 -> emergency steer (641e53c behavior).
			toolStep("t1", "timer", { action: "cancel" }, 60),
			// The steered turn's LLM call dies. Old code: errored message_end reads the
			// stale 60-token usage, stopReason "error" skips the grace gate -> hardCap
			// -> hard-no-file wipe, although the handoff was still reachable.
			errorStep(),
			// Network back: the agent answers the (already delivered) emergency steer.
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nAlmost lost." }, 60),
			textStep("post-swap report", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	try {
		await t.session.prompt("start");
		await t.session.prompt("retry after network blip");

		assert.equal(t.session.isIdle, true);

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1, `exactly one swap, got: ${JSON.stringify(markers.map((m) => m.details))}`);
		assert.equal(markers[0].details?.trigger, "soft", "swap must carry the handoff, not hard-no-file");
		assert.ok(markers[0].details?.handoffPath, "handoff file recorded on the marker");

		const refusals = toolResultTexts(t).filter((text) => text.includes("Refused: no handoff was requested"));
		assert.equal(refusals.length, 0, "the handoff tool call must be accepted, not refused post-wipe");

		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1, "the handoff file exists");
	} finally {
		cleanup(t, sessionId);
	}
});

test("a cycle stranded in a fresh window resets instead of demanding a handoff", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 20,
		script: [
			// Steer at 10 tokens (phase leaves idle).
			toolStep("s1", "timer", { action: "cancel" }, 10),
			// Context reports 2 tokens: far below soft 5 — the window shrank under the
			// cycle (models compaction / a raced swap / a dropped steer + fresh start).
			// Old code: turn_end verification fires reminder 1/2, then 2/2, then
			// "exhausted" — handoff demands aimed at a fresh window.
			textStep("recovered in a small context", 2),
			textStep("still small, still no handoff needed", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	try {
		await t.session.prompt("start");
		await t.session.prompt("keep going");

		assert.equal(t.session.isIdle, true);

		const steers = delivered(t, "CONTEXT LIMIT WARNING");
		assert.equal(steers.length, 1, "the original steer was delivered");
		assert.ok(
			steers[0].includes("this warning is stale"),
			"cap messages must carry the stale-ignore clause for late delivery",
		);

		assert.equal(
			delivered(t, "No handoff was recorded").length,
			0,
			"no reminders may target a fresh window",
		);
		assert.equal(swapMarkers(t).length, 0, "no swap");
		assert.equal(
			fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`)).length,
			0,
			"no handoff file demanded or written",
		);
	} finally {
		cleanup(t, sessionId);
	}
});
