/**
 * enterAltScreenWatch: the F2 watch view must render on the terminal's
 * ALTERNATE screen, not as a main-screen overlay.
 *
 * Why: pi-tui composites overlays into the same frame buffer whose rows the
 * differential renderer scrolls into terminal scrollback, so a full-screen
 * child view could end up committed verbatim into the parent transcript's
 * history ("agent#… · turn N · running read" mingled into scrollback). On the
 * alt screen nothing ever reaches scrollback, and leaving it restores the
 * exact pre-F2 main screen.
 *
 * These tests pin the contract with pi-tui's internal render-state API
 * (captureRenderState/restoreRenderState — re-verify after `pi update`):
 * feature-detect and refuse on non-main-screen TUIs, blank the state on entry
 * so the first alt-screen frame is a clear-free full paint, hand back the
 * captured state on exit, and stay idempotent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { enterAltScreenWatch } from "../lib/child-session.ts";

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";

interface FakeState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
	someFutureField?: string;
}

function makeTui(mode: string | null = "regular") {
	const captured: FakeState = {
		previousLines: ["line a", "line b"],
		previousWidth: 80,
		previousHeight: 24,
		cursorRow: 1,
		hardwareCursorRow: 1,
		maxLinesRendered: 2,
		previousViewportTop: 0,
		someFutureField: "keep-me",
	};
	const restored: unknown[] = [];
	let renders = 0;
	return {
		captured,
		restored,
		renders: () => renders,
		tui: {
			// null models a TUI with no mode field at all (spread as undefined-ish
			// is impossible here: an explicit undefined argument re-triggers the
			// default parameter).
			...(mode === null ? {} : { mode }),
			captureRenderState: () => captured,
			restoreRenderState: (s: unknown) => restored.push(s),
			requestRender: () => renders++,
		},
	};
}

function captureStdout(fn: () => void): string[] {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks;
}

test("refuses non-main-screen TUIs and missing internals", () => {
	// TuiAltScreen reports mode "fullscreen": pi already runs everything on the
	// alt screen there, and nesting 1049h/l would corrupt its screen handling.
	assert.equal(enterAltScreenWatch(makeTui("fullscreen").tui), null);
	assert.equal(enterAltScreenWatch(makeTui(null).tui), null);
	// Renamed/removed internals after a pi update: degrade to the old overlay.
	const { tui } = makeTui();
	const noCapture = { ...tui, captureRenderState: undefined };
	assert.equal(enterAltScreenWatch(noCapture), null);
	const noRestore = { ...tui, restoreRenderState: undefined };
	assert.equal(enterAltScreenWatch(noRestore), null);
});

test("enter: switches to alt screen and blanks render state for a clear-free full paint", () => {
	const fake = makeTui();
	let handle: { exit(): void } | null = null;
	const writes = captureStdout(() => {
		handle = enterAltScreenWatch(fake.tui);
	});
	assert.ok(handle, "main-screen TUI must be accepted");
	assert.deepEqual(writes, [ALT_ON]);
	assert.equal(fake.restored.length, 1);
	const blank = fake.restored[0] as FakeState;
	// Blanked fields: previousLines empty and width/height 0 (NOT -1) steer the
	// next doRender into the "first render" branch — a full paint from the alt
	// screen's home position without \x1b[2J/\x1b[3J.
	assert.deepEqual(blank.previousLines, []);
	assert.equal(blank.previousWidth, 0);
	assert.equal(blank.previousHeight, 0);
	assert.equal(blank.cursorRow, 0);
	assert.equal(blank.hardwareCursorRow, 0);
	assert.equal(blank.maxLinesRendered, 0);
	assert.equal(blank.previousViewportTop, 0);
	// Unknown fields from the captured shape survive the blanking.
	assert.equal(blank.someFutureField, "keep-me");
});

test("exit: leaves alt screen, restores the captured state, requests a render — once", () => {
	const fake = makeTui();
	const handle = enterAltScreenWatch(fake.tui)!;
	fake.restored.length = 0; // drop the enter-time blank state
	const writes = captureStdout(() => handle.exit());
	assert.deepEqual(writes, [ALT_OFF]);
	// The renderer resumes diffing against exactly what 1049l put back on screen.
	assert.equal(fake.restored.length, 1);
	assert.equal(fake.restored[0], fake.captured);
	assert.equal(fake.renders(), 1);
	// Second exit (defensive dispose paths) must not touch the terminal again.
	const writesAgain = captureStdout(() => handle.exit());
	assert.deepEqual(writesAgain, []);
	assert.equal(fake.restored.length, 1);
	assert.equal(fake.renders(), 1);
});
