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
	cancelPendingWork,
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

test("registry: cancelPendingWork invokes cancel callbacks and clears all claims", () => {
	const id = `unit-cancel-${Date.now()}`;
	const cancelled: string[] = [];
	claimPendingWork(id, "a", 10_000, () => cancelled.push("a"));
	claimPendingWork(id, "b", 10_000); // no callback — must not break the sweep
	claimPendingWork(id, "c", 10_000, () => {
		throw new Error("broken cancel"); // must not break the bookkeeping
	});

	let notified = false;
	void waitForPendingWorkChange(id).then(() => {
		notified = true;
	});
	cancelPendingWork(id);
	assert.equal(hasPendingWork(id), false);
	assert.deepEqual(cancelled, ["a"]);
	return sleep(0).then(() => assert.equal(notified, true));
});

test("an armed timer keeps the session claimed past the end of the run", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
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
		mode: "tui",
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

// The caller walked away (abort / expiry fallback): cancelPendingWork must disarm
// the timer itself — the wake-up may never fire into an unsupervised session that
// shares the caller's worktree.
test("cancelPendingWork disarms a claimed timer completely", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: TIMER_SECONDS }),
			textStep("waiting for the timer"),
			textStep("this run must never happen"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	await t.session.prompt("start");
	assert.equal(hasPendingWork(sessionId), true, "armed timer should hold a claim");

	cancelPendingWork(sessionId);
	assert.equal(hasPendingWork(sessionId), false);

	// Sleep well past the would-be expiry: no wake-up may arrive, no run may start.
	await sleep(TIMER_SECONDS * 1000 + 300);
	const wake = t.deliveredUserMessages.filter((m) => m.text.includes("expired"));
	assert.equal(wake.length, 0, "disarmed timer must never fire");
	assert.equal(t.session.isIdle, true);

	t.dispose();
});

// The settle race: expiry fires between a run's final queue-drain check and its
// agent_settled, so the steered wake-up lands in a loop that already ended. The
// old code released the claim there and the wake-up was lost; now the timer must
// re-send it (the session is idle at settle) and release only after delivery.
test("a wake-up stranded by the settle race is re-sent, not lost", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: 20,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: 0.2 }),
			textStep("run over, waiting"),
			textStep("woke up after resend"),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();

	// Deterministically open the race window: hold the run between its final
	// queue-drain check (_handlePostAgentRun → false) and agent_settled, so the
	// 200ms expiry fires exactly where its steer gets stranded. Patches a private
	// method of the installed pi build — re-verify after `pi update`.
	const sessionAny = t.session as { _handlePostAgentRun: () => Promise<boolean> };
	const orig = sessionAny._handlePostAgentRun.bind(t.session);
	sessionAny._handlePostAgentRun = async () => {
		const more = await orig();
		if (!more) await sleep(400);
		return more;
	};

	await t.session.prompt("start");

	const delivered = await waitUntil(() =>
		t.deliveredUserMessages.some((m) => m.text.includes("expired")),
	);
	assert.equal(delivered, true, "stranded wake-up must be re-delivered");
	const released = await waitUntil(() => !hasPendingWork(sessionId));
	assert.equal(released, true, "claim must be released after the wake-up run");
	await t.session.waitForIdle();

	const texts = (t.session.messages as Array<{ role: string; content?: unknown }>)
		.filter((m) => m.role === "assistant")
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text ?? "");
	assert.ok(
		texts.includes("woke up after resend"),
		`wake-up run must have executed, got: ${JSON.stringify(texts)}`,
	);

	t.dispose();
});
