/**
 * F2 watch view pieces that are pure: the scroll state (WatchViewport — follow /
 * clamp / handoff jumps / window) and the header / hint / position text. The
 * overlay wiring around them is covered in child-watch-overlay.test.ts; these
 * pin the semantics per operation so a change shows up as one failing line.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-watchviewport-agentdir-"));
process.env.PI_OFFLINE = "1";

import type { ChildRecord } from "../lib/child-session.ts";
import {
	EXPAND_KEY,
	WATCH_KEY,
	WatchViewport,
	sgrWheelDelta,
	watchHeaderLines,
	watchHintLine,
	watchPositionLabel,
} from "../lib/watch-viewport.ts";

/** Body 40 lines, viewport 12 → maxOffset 28. */
const BODY = 40;
const ROWS = 12;
const MAX = BODY - ROWS;

function laidOut(): WatchViewport {
	const scroll = new WatchViewport();
	scroll.layout(BODY, ROWS);
	return scroll;
}

const state = (s: WatchViewport) => ({ offset: s.offset, follow: s.follow, viewport: s.viewport, maxOffset: s.maxOffset });

test("fresh viewport follows the tail", () => {
	assert.deepEqual(state(new WatchViewport()), { offset: 0, follow: true, viewport: 1, maxOffset: 0 });
});

test("layout while following pins the offset to maxOffset", () => {
	const scroll = laidOut();
	assert.deepEqual(state(scroll), { offset: MAX, follow: true, viewport: ROWS, maxOffset: MAX });
	// The body grows: following tracks the new tail.
	scroll.layout(BODY + 5, ROWS);
	assert.equal(scroll.offset, MAX + 5);
	// Body shorter than the viewport: tail is 0.
	scroll.layout(5, 20);
	assert.deepEqual(state(scroll), { offset: 0, follow: true, viewport: 20, maxOffset: 0 });
});

test("scrollBy pauses; layout keeps a paused offset above the tail", () => {
	const scroll = laidOut();
	scroll.scrollBy(-5);
	assert.deepEqual([scroll.offset, scroll.follow], [MAX - 5, false]);
	scroll.layout(BODY + 10, ROWS); // body grows while paused: the offset stays
	assert.deepEqual([scroll.offset, scroll.follow], [MAX - 5, false]);
});

test("scrollBy clamps at 0 immediately, at the tail only on the next layout (which re-follows)", () => {
	const scroll = laidOut();
	scroll.scrollBy(-1000);
	assert.deepEqual([scroll.offset, scroll.follow], [0, false]);
	scroll.scrollBy(MAX + 10);
	assert.equal(scroll.offset, MAX + 10, "no upper clamp until layout knows the body");
	scroll.layout(BODY, ROWS);
	assert.deepEqual([scroll.offset, scroll.follow], [MAX, true]);
	// Landing exactly on maxOffset re-follows too.
	scroll.scrollBy(-1);
	scroll.scrollBy(1);
	assert.equal(scroll.follow, false);
	scroll.layout(BODY, ROWS);
	assert.deepEqual([scroll.offset, scroll.follow], [MAX, true]);
});

test("home goes to the top paused; end follows the tail", () => {
	const scroll = laidOut();
	scroll.home();
	assert.deepEqual([scroll.offset, scroll.follow], [0, false]);
	scroll.layout(BODY, ROWS);
	assert.deepEqual([scroll.offset, scroll.follow], [0, false]);
	scroll.end();
	assert.equal(scroll.follow, true);
	scroll.layout(BODY, ROWS);
	assert.equal(scroll.offset, MAX);
	// Home on a body that fits the viewport: top IS the tail, so layout re-follows.
	scroll.home();
	scroll.layout(5, ROWS);
	assert.deepEqual([scroll.offset, scroll.follow], [0, true]);
});

test("jumpHandoff: down to each reachable anchor, then the tail; up to the previous anchor", () => {
	const anchors = [10, 20, 30]; // 30 > MAX: on the final screen
	const scroll = laidOut();
	scroll.home();
	assert.equal(scroll.jumpHandoff(anchors, 1), true);
	assert.deepEqual([scroll.offset, scroll.follow], [10, false]);
	assert.equal(scroll.jumpHandoff(anchors, 1), true);
	assert.deepEqual([scroll.offset, scroll.follow], [20, false]);
	assert.equal(scroll.jumpHandoff(anchors, 1), true, "anchor 30 unreachable as top → tail");
	assert.equal(scroll.follow, true);
	scroll.layout(BODY, ROWS);
	assert.equal(scroll.offset, MAX);
	// From the (following) tail the effective top is maxOffset.
	assert.equal(scroll.jumpHandoff(anchors, -1), true);
	assert.deepEqual([scroll.offset, scroll.follow], [20, false]);
	scroll.jumpHandoff(anchors, -1);
	assert.equal(scroll.offset, 10);
	// No anchor above: reports no change and leaves the state alone.
	assert.equal(scroll.jumpHandoff(anchors, -1), false);
	assert.deepEqual([scroll.offset, scroll.follow], [10, false]);
});

test("jumpHandoff without anchors: down follows the tail, up is a no-op", () => {
	const scroll = laidOut();
	scroll.scrollBy(-3);
	assert.equal(scroll.jumpHandoff([], -1), false);
	assert.equal(scroll.follow, false);
	assert.equal(scroll.jumpHandoff([], 1), true);
	assert.equal(scroll.follow, true);
});

test("window slices the body at the offset and pads to the viewport", () => {
	const body = Array.from({ length: BODY }, (_, i) => `L${i}`);
	const scroll = laidOut();
	assert.deepEqual(scroll.window(body), body.slice(MAX));
	scroll.home();
	assert.deepEqual(scroll.window(body), body.slice(0, ROWS));
	scroll.layout(3, 5);
	assert.deepEqual(scroll.window(["a", "b", "c"]), ["a", "b", "c", "", ""]);
});

test("contextIndex: top line's context, last visible line's at the tail", () => {
	const anchors = [10, 20, 30];
	const scroll = laidOut();
	assert.equal(scroll.contextIndex(anchors, BODY), 4, "tail: last visible line 39 is past anchor 30");
	scroll.home();
	assert.equal(scroll.contextIndex(anchors, BODY), 1);
	scroll.jumpHandoff(anchors, 1);
	scroll.jumpHandoff(anchors, 1);
	assert.equal(scroll.contextIndex(anchors, BODY), 3, "top on anchor 20");
});

// --- header / hint / position text ---

const record = (extra: Partial<ChildRecord> & { handoffCount?: number } = {}) =>
	({
		id: "x1",
		kind: "agent",
		description: "desc",
		turns: 3,
		elapsedMs: 65_000,
		running: false,
		...extra,
		view: { handoffCount: extra.handoffCount ?? 0 },
	}) as unknown as ChildRecord;

test("watchPositionLabel: ` (i/N)` only with more than one child and the child listed", () => {
	const a = record({ id: "a" });
	const b = record({ id: "b" });
	assert.equal(watchPositionLabel([a], a), "");
	assert.equal(watchPositionLabel([a, b], b), " (2/2)");
	assert.equal(watchPositionLabel([a, b], record({ id: "gone" })), "", "evicted: no position");
});

test("watchHeaderLines: finished header + handoff line", () => {
	assert.deepEqual(watchHeaderLines(record({ handoffCount: 2 }), " (1/2)", 3), [
		"■ agent#x1 · desc · 3 turns · finished (1/2)",
		"  ⇄ 2 handoffs · context 3/3 · 1m05s",
	]);
	assert.deepEqual(watchHeaderLines(record(), "", 1), ["■ agent#x1 · desc · 3 turns · finished", "  ⇄ no handoffs · 1m05s"]);
});

test("watchHintLine: paused first, handoff key only with handoffs, agents part only with a position", () => {
	const base = `esc back · wheel/↑↓/pgup/pgdn scroll · end follow · ${EXPAND_KEY} expand`;
	assert.equal(watchHintLine(true, 0, ""), base);
	assert.equal(watchHintLine(false, 0, ""), `paused · ${base}`);
	assert.equal(
		watchHintLine(true, 2, " (1/2)"),
		`esc back · wheel/↑↓/pgup/pgdn scroll · shift+↑↓ handoff · end follow · ${EXPAND_KEY} expand · ←/→ agents · ${WATCH_KEY} next (1/2)`,
	);
});

test("sgrWheelDelta: wheel up/down scroll 3 lines, other mouse events are swallowed (0), keys pass (undefined)", () => {
	assert.equal(sgrWheelDelta("\x1b[<64;10;5M"), -3);
	assert.equal(sgrWheelDelta("\x1b[<65;10;5M"), 3);
	assert.equal(sgrWheelDelta("\x1b[<0;10;5M"), 0, "left click");
	assert.equal(sgrWheelDelta("\x1b[<0;10;5m"), 0, "release");
	assert.equal(sgrWheelDelta("\x1b[A"), undefined, "arrow key is not a mouse report");
	assert.equal(sgrWheelDelta("q"), undefined);
});
