/**
 * lib/format.ts: the one token formatter for the main footer (context-cap.ts)
 * and the F2 watch (child footer, picker, handoff dividers). Before it existed,
 * context-cap had its own `k`-only formatter, so a 1M window showed as `1000k`
 * in the main footer but `1.0M` in the child footer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatCapStatus, formatTokenCount } from "../lib/format.ts";

test("formatTokenCount: plain, k and M ranges", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1000), "1k");
	assert.equal(formatTokenCount(162_400), "162k");
	assert.equal(formatTokenCount(260_000), "260k");
	assert.equal(formatTokenCount(1_000_000), "1.0M");
	assert.equal(formatTokenCount(1_234_567), "1.2M");
});

test("formatTokenCount: never renders 1000k — the k/M boundary is where k would round to 1000", () => {
	assert.equal(formatTokenCount(999_499), "999k");
	assert.equal(formatTokenCount(999_500), "1.0M");
	assert.equal(formatTokenCount(999_999), "1.0M");
});

test("formatTokenCount: a disabled cap (+Infinity) renders as off", () => {
	assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), "off");
});

test("formatCapStatus: tokens/soft with optional suffix, ? for unknown usage", () => {
	assert.equal(formatCapStatus(12_000, 260_000), "12k/260k");
	assert.equal(formatCapStatus(null, 260_000), "?/260k");
	assert.equal(formatCapStatus(undefined, Number.POSITIVE_INFINITY), "?/off");
	assert.equal(formatCapStatus(1_200_000, 1_000_000, " ⚠ handoff"), "1.2M/1.0M ⚠ handoff");
});
