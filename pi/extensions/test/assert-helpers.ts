/**
 * Narrowing assertion for indexed reads under `noUncheckedIndexedAccess`.
 * Dependency-free on purpose (unlike harness.ts, which boots pi), so any test
 * file can import it. A missing element fails the test with a message naming
 * the index instead of a TypeError one line later.
 */
import assert from "node:assert/strict";

/** `arr[i]` (negative `i` counts from the end, like Array#at), asserted present. */
export function at<T>(arr: readonly T[], i: number): T {
	const item = arr.at(i);
	assert.ok(item !== undefined, `expected an element at index ${i} (length ${arr.length})`);
	return item;
}
