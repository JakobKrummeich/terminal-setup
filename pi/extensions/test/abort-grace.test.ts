/**
 * lib/abort-grace.ts in isolation: the race that bounds how long the parent's
 * ESC waits for a child run (runChildRecord in lib/child-session.ts).
 * child-retry.test.ts covers only the "stream never ends" branch end to end;
 * these pin the other branches, each of which a refactor could silently break:
 *  - no signal: the run itself, untouched (no grace race at all);
 *  - before the grace expires the result is the run's own, rejection included
 *    (runChildRecord's catch is what writes the "error" finish row);
 *  - a run that settles inside the grace returns at once, not after graceMs
 *    (otherwise every ESC would cost the full ABORT_GRACE_MS);
 *  - an orphan that rejects after the grace must not surface as an
 *    unhandledRejection — node's default for that is to kill the pi process.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { settleWithinAbortGrace } from "../lib/abort-grace.ts";

/** A run the test settles by hand. */
function pendingRun() {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const run = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { run, resolve, reject };
}

/** "settled" or "pending" after `ms`, without consuming a rejection as a pass. */
async function stateAfter(promise: Promise<void>, ms: number): Promise<"settled" | "pending"> {
	return Promise.race([promise.then(() => "settled" as const), sleep(ms).then(() => "pending" as const)]);
}

test("no signal: the run is returned as is (nothing to race)", () => {
	const { run, resolve } = pendingRun();
	assert.equal(settleWithinAbortGrace(run, undefined, 10), run);
	resolve();
});

test("no abort: the run's own result, resolve or reject", async () => {
	const controller = new AbortController();
	const ok = pendingRun();
	const settled = settleWithinAbortGrace(ok.run, controller.signal, 10);
	ok.resolve();
	await settled;

	const failing = pendingRun();
	const rejected = settleWithinAbortGrace(failing.run, controller.signal, 10);
	failing.reject(new Error("provider exploded"));
	await assert.rejects(rejected, /provider exploded/);
});

test("abort, then the run settles inside the grace: returns at once with the run's result", async () => {
	const controller = new AbortController();
	const ok = pendingRun();
	const settled = settleWithinAbortGrace(ok.run, controller.signal, 60_000);
	controller.abort();
	ok.resolve();
	assert.equal(await stateAfter(settled, 1_000), "settled", "must not wait out the 60 s grace");

	const failing = pendingRun();
	const rejected = settleWithinAbortGrace(failing.run, controller.signal, 60_000);
	failing.reject(new Error("aborted mid-stream"));
	await assert.rejects(rejected, /aborted mid-stream/);
});

test("abort, run never settles: resolves after the grace, not before", async () => {
	const controller = new AbortController();
	const { run } = pendingRun();
	const settled = settleWithinAbortGrace(run, controller.signal, 100);
	assert.equal(await stateAfter(settled, 30), "pending", "no abort yet: no grace running");
	controller.abort();
	assert.equal(await stateAfter(settled, 30), "pending", "still inside the grace");
	assert.equal(await stateAfter(settled, 1_000), "settled");
});

test("an already-aborted signal starts the grace immediately", async () => {
	const controller = new AbortController();
	controller.abort();
	const { run } = pendingRun();
	assert.equal(await stateAfter(settleWithinAbortGrace(run, controller.signal, 20), 1_000), "settled");
});

test("an orphan rejecting after the grace is swallowed, never an unhandledRejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const controller = new AbortController();
		controller.abort();
		const orphan = pendingRun();
		await settleWithinAbortGrace(orphan.run, controller.signal, 10);
		orphan.reject(new Error("late stream failure"));
		// unhandledRejection fires after the microtask queue drains; give it a few macrotasks.
		await sleep(20);
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
