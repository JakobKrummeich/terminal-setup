/**
 * lib/context-cap-resolver.ts: the per-session memory around resolveTriggers —
 * last known window and warn-once — as a table. The trigger arithmetic itself
 * lives in context-cap-triggers.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createCapResolver } from "../lib/context-cap-resolver.ts";

const CAP_ENV = ["CONTEXT_CAP_SOFT", "CONTEXT_CAP_HARD", "CONTEXT_CAP_RESERVE"] as const;

function withEnv<T>(env: Partial<Record<(typeof CAP_ENV)[number], string>>, run: () => T): T {
	const saved = CAP_ENV.map((k) => [k, process.env[k]] as const);
	for (const k of CAP_ENV) delete process.env[k];
	Object.assign(process.env, env);
	try {
		return run();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Runs `windows` through one resolver; returns every notification as "level: text". */
function notifications(windows: readonly (number | null | undefined)[]): string[] {
	const seen: string[] = [];
	const resolve = createCapResolver();
	for (const contextWindow of windows) {
		resolve({ contextWindow }, (message, level) => void seen.push(`${level}: ${message}`));
	}
	return seen;
}

test("resolver: garbage windows count as unseen and never replace the last real one", () => {
	const resolve = createCapResolver();
	assert.equal(resolve({ contextWindow: 200_000 }).contextWindow, 200_000);
	for (const garbage of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(resolve({ contextWindow: garbage }).contextWindow, 200_000, `window ${garbage}`);
	}
	assert.equal(resolve(undefined).contextWindow, 200_000);
	assert.equal(resolve(null).contextWindow, 200_000);
	assert.equal(resolve({ contextWindow: 1_000_000 }).contextWindow, 1_000_000, "a new real window wins");
});

test("resolver: each warning once per resolver, with its level", () => {
	withEnv({}, () => {
		assert.deepEqual(notifications([undefined, undefined]), [
			"info: context-cap: context window unknown — using static caps 260000/325000",
		]);
		assert.deepEqual(notifications([1_000, 1_000, 200_000, 1_000]), [
			"warning: context-cap: context window 1000 cannot hold a cap below pi's own compaction (reserve 16384) — cap disabled",
		]);
		assert.deepEqual(notifications([1_000_000, 200_000]), [], "a healthy window notifies nothing");
	});
});

test("resolver: two conditions in one check notify in order clamped, then fallback", () => {
	withEnv({ CONTEXT_CAP_SOFT: "400000" }, () => {
		assert.deepEqual(notifications([undefined, undefined]), [
			"warning: context-cap: soft cap ≥ hard cap — soft clamped to 324999 (hard 325000)",
			"info: context-cap: context window unknown — using static caps 324999/325000",
		]);
	});
});

test("resolver: a check without notify still uses up the warning", () => {
	withEnv({}, () => {
		const seen: string[] = [];
		const resolve = createCapResolver();
		resolve(undefined);
		resolve(undefined, (message) => void seen.push(message));
		assert.deepEqual(seen, []);
	});
});
