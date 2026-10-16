/**
 * lib/child-reopen.ts evictFinishedChildren in isolation: the memory-cap policy
 * runChildTool applies before every spawn and reopen. child-reopen.test.ts only
 * drives it end to end ("spawn fillers until the id is gone"), so these pin the
 * policy itself: keep at most 8 finished children, evict the OLDEST finished
 * first, never touch a running or still-settling child (disposing one would kill
 * a live run), dispose what is evicted, and leave a tombstone that reopens it.
 *
 * Records are stubs: only isIdle, dispose() and getSessionFile() are read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evictFinishedChildren } from "../lib/child-reopen.ts";
import type { ChildRecord, ChildRegistry } from "../lib/child-types.ts";

type State = "finished" | "running" | "settling";

/** Registry holding one stub record per entry of `states`, ids c0, c1, … in insertion order. */
function registryOf(states: State[], disposed: string[], throwOnDispose = new Set<string>()): ChildRegistry {
	const liveChildren = new Map<string, ChildRecord>();
	states.forEach((state, index) => {
		const id = `c${index}`;
		const session = {
			// "settling": the run's finally already cleared `running`, but a queued
			// steer/follow-up keeps the session busy.
			isIdle: state !== "running" && state !== "settling",
			dispose: () => {
				disposed.push(id);
				if (throwOnDispose.has(id)) throw new Error(`dispose ${id} failed`);
			},
			sessionManager: { getSessionFile: () => `/sessions/${id}.jsonl` },
		};
		const record = {
			id,
			kind: index % 2 ? "explorer" : "agent",
			sid: `sid-${id}`,
			rootSid: "root",
			session,
			view: {},
			description: `desc ${id}`,
			turns: index,
			elapsedMs: index * 1000,
			running: state === "running",
		};
		liveChildren.set(id, record as unknown as ChildRecord);
	});
	return { liveChildren, evicted: new Map(), reopening: new Set() };
}

const finished = (count: number): State[] => Array.from({ length: count }, () => "finished");

test("up to 8 finished children are kept: nothing evicted, nothing disposed", () => {
	const disposed: string[] = [];
	const registry = registryOf([...finished(8), "running", "settling"], disposed);
	evictFinishedChildren(registry);
	assert.equal(registry.liveChildren.size, 10);
	assert.equal(registry.evicted.size, 0);
	assert.deepEqual(disposed, []);
});

test("beyond 8 finished: the oldest finished go; running and settling children are never evicted", () => {
	const disposed: string[] = [];
	// The oldest entries are a running and a settling child: eviction must skip
	// past them to the oldest FINISHED ones (c2, c3), not stop or take them.
	const registry = registryOf(["running", "settling", ...finished(10)], disposed);
	evictFinishedChildren(registry);
	assert.deepEqual([...registry.liveChildren.keys()], ["c0", "c1", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11"]);
	assert.deepEqual([...registry.evicted.keys()], ["c2", "c3"]);
	assert.deepEqual(disposed, ["c2", "c3"], "evicted sessions are disposed, survivors are not");
});

test("the tombstone carries everything a later resume_id needs to reopen the child", () => {
	const registry = registryOf(finished(9), []);
	evictFinishedChildren(registry);
	assert.deepEqual(registry.evicted.get("c0"), {
		id: "c0",
		kind: "agent",
		sid: "sid-c0",
		rootSid: "root",
		sessionFile: "/sessions/c0.jsonl",
		description: "desc c0",
		turns: 0,
		elapsedMs: 0,
	});
});

test("a throwing dispose does not stop the eviction loop", () => {
	const disposed: string[] = [];
	const registry = registryOf(finished(10), disposed, new Set(["c0"]));
	assert.doesNotThrow(() => evictFinishedChildren(registry));
	assert.deepEqual(disposed, ["c0", "c1"]);
	assert.deepEqual([...registry.evicted.keys()], ["c0", "c1"], "the child whose dispose threw is still tombstoned");
	assert.equal(registry.liveChildren.size, 8);
});
