/**
 * waitForSessionQuiet is the Agent tool's "child is really done" primitive:
 * after the child's prompt() resolved, it waits for idle + an empty message
 * queue, with a bounded grace for a queued steer/follow-up whose run is about
 * to start (or that was stranded by the settle race).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createTestSession, textStep } from "./harness.ts";
import { type QuietSession, waitForSessionQuiet } from "../lib/session-quiet.ts";

test("idle session with an empty queue is quiet immediately", async () => {
	const t = await createTestSession({ extensionPaths: [], llmDelayMs: 20, script: [textStep("done")] });
	try {
		await t.session.prompt("start");
		const before = Date.now();
		await waitForSessionQuiet(t.session, undefined);
		assert.ok(Date.now() - before < 200, "nothing queued: must not wait");
	} finally {
		t.dispose();
	}
});

/** Fake session whose queue drains after `drainAfterMs` (never, if undefined). */
function queuedSession(drainAfterMs: number | undefined): QuietSession & { idleWaits: number } {
	const startedAt = Date.now();
	return {
		idleWaits: 0,
		isIdle: true,
		get pendingMessageCount() {
			return drainAfterMs !== undefined && Date.now() - startedAt >= drainAfterMs ? 0 : 1;
		},
		async waitForIdle() {
			this.idleWaits++;
		},
	};
}

test("a queued message keeps the wait open until it is delivered", async () => {
	const session = queuedSession(600);
	const before = Date.now();
	await waitForSessionQuiet(session, undefined);
	const waited = Date.now() - before;
	assert.ok(waited >= 550, `must wait for the queued run (waited ${waited}ms)`);
	assert.ok(waited < 1500, `must return once the queue drained (waited ${waited}ms)`);
	assert.ok(session.idleWaits >= 2, "must re-check idle after each grace poll");
});

test("a permanently stranded message cannot hold the wait past the grace budget", async () => {
	const before = Date.now();
	await waitForSessionQuiet(queuedSession(undefined), undefined);
	const waited = Date.now() - before;
	assert.ok(waited >= 1900 && waited < 3500, `grace budget is ~2s (waited ${waited}ms)`);
});

test("abort ends the grace wait promptly", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const before = Date.now();
	await waitForSessionQuiet(queuedSession(undefined), controller.signal);
	assert.ok(Date.now() - before < 800, "abort must end the wait before the grace budget");
});
