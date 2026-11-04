/**
 * lib/env.ts integer env vars: envInt (timer's PI_TIMER_MAX_WAIT_S /
 * PI_TIMER_HEARTBEAT_MS, the import-time CONTEXT_CAP_* constants) and
 * envIntOrNull (resolveTriggers) share ONE rule — a whole positive decimal
 * integer, else the fallback / null. The bug this pins: parseInt read a numeric
 * PREFIX, so "200k" became 200 and "1e6" became 1 instead of falling back.
 * envIntOrNull's own cases live in context-cap-triggers.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { envInt, envIntOrNull } from "../lib/env.ts";

const KEY = "PI_ENV_TEST_INT";

function withValue<T>(value: string | undefined, fn: () => T): T {
	const saved = process.env[KEY];
	if (value === undefined) delete process.env[KEY];
	else process.env[KEY] = value;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
	}
}

test("envInt: whole positive integers are read, surrounding whitespace tolerated", () => {
	for (const [raw, want] of [["300", 300], [" 300 ", 300], ["0300", 300], ["1", 1]] as const) {
		assert.equal(withValue(raw, () => envInt(KEY, 7)), want, JSON.stringify(raw));
	}
});

test("envInt: unset, non-positive and partially numeric values fall back", () => {
	for (const raw of [undefined, "", " ", "abc", "0", "-5", "200k", "1e6", "2.5", "260_000", "5m", "+5"]) {
		assert.equal(withValue(raw, () => envInt(KEY, 7)), 7, `${JSON.stringify(raw)} must fall back`);
	}
});

test("envInt and envIntOrNull agree on every value", () => {
	for (const raw of [undefined, "300", " 42 ", "0", "200k", "1e6", "9".repeat(400)]) {
		const strict = withValue(raw, () => envIntOrNull(KEY));
		assert.equal(withValue(raw, () => envInt(KEY, 7)), strict ?? 7, JSON.stringify(raw));
	}
});
