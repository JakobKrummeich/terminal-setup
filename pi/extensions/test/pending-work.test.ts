/**
 * Pending-work claims: the signal a child session (Agent tool) uses to decide it is
 * really finished, instead of "the run ended".
 *
 * Timer is the interesting producer: the agent sets a timer and ends its turn, so
 * `session.prompt()` resolves while more work is guaranteed to follow. The claim must
 * survive that gap and only be released once the wake-up run has settled.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, sleep, textStep, toolStep } from "./harness.ts";
import {
	claimPendingWork,
	hasPendingWork,
	pendingWorkReasons,
	releasePendingWork,
	waitForPendingWorkChange,
} from "../lib/pending-work.ts";

const TIMER_EXTENSION = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../timer.ts");

const TIMER_SECONDS = 0.25;

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(20);
	}
	return predicate();
}

test("registry: claims are per reason and expire on their own", async () => {
	const id = `unit-${Date.now()}`;
	claimPendingWork(id, "a", 10_000);
	claimPendingWork(id, "b", 40);
	assert.deepEqual(pendingWorkReasons(id).sort(), ["a", "b"]);

	// b self-expires; the change notification fires with it.
	let notified = false;
	void waitForPendingWorkChange(id).then(() => {
		notified = true;
	});
	assert.equal(await waitUntil(() => pendingWorkReasons(id).length === 1), true);
	assert.deepEqual(pendingWorkReasons(id), ["a"]);
	assert.equal(notified, true);

	releasePendingWork(id, "a");
	assert.equal(hasPendingWork(id), false);
});

test("an armed timer keeps the session claimed past the end of the run", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: TIMER_SECONDS }),
			textStep("waiting for the timer"),
			textStep("woke up, done"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	// The run is over, but the agent explicitly asked to be woken: not done yet.
	assert.equal(t.session.isIdle, true);
	assert.equal(hasPendingWork(sessionId), true, "claim must outlive the run");

	const released = await waitUntil(() => !hasPendingWork(sessionId));
	assert.equal(released, true, "claim must be released after the wake-up run");
	assert.equal(t.session.isIdle, true);
	const wake = t.deliveredUserMessages.filter((m) => m.text.includes("expired"));
	assert.equal(wake.length, 1, "expiry message should have started exactly one wake-up run");

	t.dispose();
});

test("cancelling a timer releases the claim immediately", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: 30 }),
			toolStep("c1", "timer", { action: "cancel" }),
			textStep("done"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	assert.equal(hasPendingWork(sessionId), false, "cancelled timer must not block the caller");

	t.dispose();
});
