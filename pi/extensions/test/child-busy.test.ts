/**
 * lib/child-busy.ts in isolation: the busy-group semaphore runChildTool uses.
 * End-to-end latching (serialized Agent calls, N parallel explorers, the latch
 * shared across module copies) is covered in explore.test.ts; these pin the
 * slot arithmetic and the settling wind-down per operation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type BusyGroup, busyGroup, releaseSlot, tryAcquireSlot } from "../lib/child-busy.ts";

/** A session stub: idle or not, with a waitForIdle the test resolves by hand. */
function fakeSession(isIdle: boolean) {
	let settle: () => void = () => {};
	const idle = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const session = { isIdle, waitForIdle: () => idle } as unknown as AgentSession;
	return { session, settle };
}

test("busyGroup creates a group once per name (limit 1, empty)", () => {
	const groups = new Map<string, BusyGroup>();
	const group = busyGroup(groups, "agent");
	assert.deepEqual({ active: group.active, limit: group.limit, settling: group.settling.size }, {
		active: 0,
		limit: 1,
		settling: 0,
	});
	assert.equal(busyGroup(groups, "agent"), group);
	assert.notEqual(busyGroup(groups, "explorer"), group);
});

test("tryAcquireSlot: refreshes the limit (floored, min 1) and rejects when full", () => {
	const group = busyGroup(new Map(), "explorer");
	assert.equal(tryAcquireSlot(group, 2.7), true);
	assert.equal(group.limit, 2);
	assert.equal(tryAcquireSlot(group, 2), true);
	assert.equal(tryAcquireSlot(group, 2), false, "third caller at limit 2");
	assert.equal(group.active, 2);
	assert.equal(tryAcquireSlot(group, undefined), false, "undefined concurrency = limit 1");
	assert.equal(group.limit, 1);
	assert.equal(tryAcquireSlot(busyGroup(new Map(), "x"), 0), true, "limit is at least 1");
});

test("releaseSlot: no session or an idle one frees the slot at once", () => {
	const group = busyGroup(new Map(), "agent");
	tryAcquireSlot(group, 1);
	releaseSlot(group, undefined);
	assert.equal(group.active, 0);
	tryAcquireSlot(group, 1);
	releaseSlot(group, fakeSession(true).session);
	assert.equal(group.active, 0);
	assert.equal(group.settling.size, 0);
});

test("releaseSlot: a still-draining session keeps its slot until idle, released once", async () => {
	const group = busyGroup(new Map(), "agent");
	tryAcquireSlot(group, 1);
	const { session, settle } = fakeSession(false);
	releaseSlot(group, session);
	assert.equal(group.active, 1, "slot held while settling");
	assert.ok(group.settling.has(session));
	assert.equal(tryAcquireSlot(group, 1), false, "a new child must not overlap the draining one");
	settle();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(group.active, 0);
	assert.equal(group.settling.size, 0);
});

// A hung child (waitForIdle never resolves) must not strand its slot: at limit 1
// the Agent tool would stay busy for the rest of the pi session. And when the hung
// child DOES go idle after the expiry, that late release must be a no-op — a
// second decrement would free the next child's slot and let two agents share one
// worktree.
test("releaseSlot: a hung session's slot self-expires after 60s; a late idle releases nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const group = busyGroup(new Map(), "agent");
	tryAcquireSlot(group, 1);
	const hung = fakeSession(false);
	releaseSlot(group, hung.session);
	t.mock.timers.tick(59_999);
	assert.equal(group.active, 1, "slot held until the 60s expiry");
	t.mock.timers.tick(1);
	assert.equal(group.active, 0, "expired slot is free again");
	assert.equal(group.settling.size, 0);

	assert.equal(tryAcquireSlot(group, 1), true, "next child takes the freed slot");
	hung.settle();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(group.active, 1, "late idle must not release the next child's slot");
	assert.equal(tryAcquireSlot(group, 1), false, "limit 1 still holds");
});

test("releaseSlot: after an idle release the expiry timer releases nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const group = busyGroup(new Map(), "agent");
	tryAcquireSlot(group, 1);
	const draining = fakeSession(false);
	releaseSlot(group, draining.session);
	draining.settle();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(group.active, 0);

	assert.equal(tryAcquireSlot(group, 1), true);
	t.mock.timers.tick(60_000);
	assert.equal(group.active, 1, "expiry must not release the next child's slot");
});
