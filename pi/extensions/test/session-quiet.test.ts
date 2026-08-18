/**
 * waitForSessionQuiet is the Agent tool's "child is really done" primitive: it is
 * what keeps the parent's tool call open across a child's timer wake-up. These
 * tests drive it against a real session + the real timer extension — the exact
 * parent-side behavior, minus the TUI.
 *
 * The sessions that arm a timer run with `mode: "tui"`: only there does timer take
 * its async, claim-holding branch. A real child has no timer tool at all (timer.ts
 * registers nothing in child sessions — child-timer.test.ts), so today this
 * primitive is a safety net: it is what keeps the Agent tool correct if any
 * extension ever claims pending work in a child again.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, sleep, textStep, toolStep } from "./harness.ts";
import { cancelPendingWork, hasPendingWork } from "../lib/pending-work.ts";
import { waitForSessionQuiet } from "../lib/session-quiet.ts";

const TIMER_EXTENSION = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../timer.ts");

test("idle, unclaimed session is quiet immediately", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		tools: ["timer"],
		llmDelayMs: 20,
		script: [textStep("done, no timer")],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	const before = Date.now();
	await waitForSessionQuiet(t.session, sessionId, undefined);
	assert.ok(Date.now() - before < 200, "no pending work: must not wait");

	t.dispose();
});

test("quiet only after the timer wake-up run completed (the Agent-tool contract)", async () => {
	const TIMER_SECONDS = 0.3;
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "build", seconds: TIMER_SECONDS }),
			textStep("waiting for the build"),
			textStep("build checked, all done"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	// prompt() resolved between runs — the naive caller would return here and lose
	// everything after the wake-up. waitForSessionQuiet must bridge the gap.
	assert.equal(hasPendingWork(sessionId), true);

	const waitingReasons: string[][] = [];
	const before = Date.now();
	await waitForSessionQuiet(t.session, sessionId, undefined, (reasons) => {
		waitingReasons.push(reasons);
	});
	const waited = Date.now() - before;

	assert.ok(waited >= TIMER_SECONDS * 1000 - 50, `must wait through the timer (waited ${waited}ms)`);
	assert.equal(t.session.isIdle, true);
	assert.equal(hasPendingWork(sessionId), false);
	assert.ok(
		waitingReasons.some((r) => r.includes("timer")),
		"caller must be told it is waiting on the timer",
	);
	const wake = t.deliveredUserMessages.filter((m) => m.text.includes("expired"));
	assert.equal(wake.length, 1, "exactly one wake-up delivered");
	const finalText = t.session.messages
		.filter((m: { role: string }) => m.role === "assistant")
		.flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text)
		.at(-1);
	assert.equal(finalText, "build checked, all done", "post-wake-up work must be included");

	t.dispose();
});

test("abort stops the wait promptly and the armed timer can be disarmed", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "long", seconds: 30 }),
			textStep("waiting for a long timer"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	assert.equal(hasPendingWork(sessionId), true);

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const before = Date.now();
	await waitForSessionQuiet(t.session, sessionId, controller.signal);
	assert.ok(Date.now() - before < 2000, "abort must end the wait, not the 30s timer");

	// What the Agent tool does on its way out: leave nothing armed behind.
	cancelPendingWork(sessionId);
	assert.equal(hasPendingWork(sessionId), false);
	await sleep(100);
	assert.equal(t.session.isIdle, true);

	t.dispose();
});
