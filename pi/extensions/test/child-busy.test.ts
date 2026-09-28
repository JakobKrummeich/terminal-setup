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
