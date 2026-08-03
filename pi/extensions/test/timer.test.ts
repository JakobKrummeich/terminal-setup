/**
 * Timer extension: expiry-delivery behaviour while the agent is busy.
 *
 * Failure mode these tests pin down (observed live): the expiry message was
 * injected with `deliverAs: "followUp"`. pi delivers follow-ups only when the
 * whole agent run ends (no more tool calls). During a long run the wake-up
 * therefore never arrives; every expiry piles up in the queue instead, and the
 * stack is flushed as several stale wake-ups once the run finally ends.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, sleep, textStep, toolStep } from "./harness.ts";

const TIMER_EXTENSION = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../timer.ts");

const LLM_DELAY_MS = 60;
const TIMER_SECONDS = 0.25;

const isExpiry = (text: string) => text.startsWith("Timer ") && text.includes("expired");

/**
 * A long agent run: the agent sets a timer, then keeps calling tools for much
 * longer than the timer duration, sets a second timer, and only stops at the end.
 */
async function runBusyAgentWithTimers() {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		tools: ["timer", "bash"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: TIMER_SECONDS }),
			toolStep("w1", "bash", { command: "sleep 0.05" }),
			toolStep("w2", "bash", { command: "sleep 0.05" }),
			toolStep("w3", "bash", { command: "sleep 0.05" }),
			toolStep("s2", "timer", { action: "set", name: "t2", seconds: TIMER_SECONDS }),
			toolStep("w4", "bash", { command: "sleep 0.05" }),
			toolStep("w5", "bash", { command: "sleep 0.05" }),
			toolStep("w6", "bash", { command: "sleep 0.05" }),
			textStep("all done"),
		],
	});

	await t.session.prompt("start the long task");
	await sleep(300); // let any straggling queued message be delivered
	return t;
}

test("expiry wakes the agent at the next turn boundary, not at the end of the run", async () => {
	const t = await runBusyAgentWithTimers();
	try {
		const expiry = t.queueSnapshots.find((s) =>
			[...s.steering, ...s.followUp].some((m) => isExpiry(m) && m.includes('"t1"')),
		);
		assert.ok(expiry, "t1 expiry message was never queued");

		const delivery = t.deliveredUserMessages.find((m) => isExpiry(m.text) && m.text.includes('"t1"'));
		assert.ok(delivery, "t1 expiry message was never delivered to the agent");

		// The wake-up must land at the first turn boundary after expiry. Allow one
		// boundary (the one that delivers it); more means it waited for the run to end.
		const boundariesWaited = t.turnEnds.filter(
			(at) => at >= expiry.atMs && at <= delivery.atMs,
		).length;
		assert.ok(
			boundariesWaited <= 1,
			`expiry message waited ${boundariesWaited} turn boundaries (queued ${expiry.atMs}ms, delivered ${delivery.atMs}ms) — it should be delivered at the next turn boundary`,
		);
	} finally {
		t.dispose();
	}
});

test("expiry while the agent is idle starts a new turn", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		tools: ["timer"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "idle-check", seconds: TIMER_SECONDS }),
			textStep("waiting"),
			textStep("woken up"),
		],
	});
	try {
		await t.session.prompt("start"); // run ends well before the timer expires
		const runEndedAt = t.now();
		await sleep(TIMER_SECONDS * 1000 + 400);

		const delivery = t.deliveredUserMessages.find((m) => isExpiry(m.text));
		assert.ok(delivery, "expiry message was never delivered while idle");
		assert.ok(
			delivery.atMs > runEndedAt,
			"expiry should arrive after the run ended, starting a fresh turn",
		);
	} finally {
		t.dispose();
	}
});

test("expiry messages never stack up in the queue", async () => {
	const t = await runBusyAgentWithTimers();
	try {
		const worst = t.queueSnapshots.reduce((max, s) => {
			const pending = [...s.steering, ...s.followUp].filter(isExpiry).length;
			return Math.max(max, pending);
		}, 0);
		assert.ok(
			worst <= 1,
			`${worst} timer expiry messages were queued at the same time — expiries must be delivered before the next one can be queued`,
		);

		const delivered = t.deliveredUserMessages.filter((m) => isExpiry(m.text)).map((m) => m.text);
		assert.equal(delivered.length, 2, `expected both expiries delivered once, got ${JSON.stringify(delivered)}`);
	} finally {
		t.dispose();
	}
});
