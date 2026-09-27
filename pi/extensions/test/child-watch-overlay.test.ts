/**
 * F2 watch overlay wiring (watchOverlay → renderView/handleViewInput and the
 * picker), driven through the real ui.custom factory with a fake TUI:
 *   - header line 2 `⇄ N handoffs · context k/N+1 · duration` (live duration
 *     for a running child), viewport = rows − 4 − footer lines;
 *   - hint: `shift+↑↓ handoff` only with handoffs, `paused` first, truncated;
 *   - Shift+↓/↑ handoff jumps, including anchors on the final screen (→ tail,
 *     never stuck) and the tail's `context k` = the last visible line's;
 *   - picker rows carry `⇄N` right after `kind#id` and fit the width.
 *
 * Every test disposes the overlay (its 1s ticker would otherwise keep the
 * process alive) and clears liveChildren. process.stdout.write is captured
 * while the overlay is open: it writes mouse-mode escapes there.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-watchoverlay-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-watchoverlay-sessions-"));
process.env.PI_OFFLINE = "1";

import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChildView } from "../lib/child-view.ts";
import {
	type ChildRecord,
	liveChildren,
	openChildPicker,
	openChildView,
	pickerRow,
} from "../lib/child-session.ts";

initTheme(undefined, false);

const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const HOME = "\x1b[H";
const END = "\x1b[F";
const WIDTH = 80;
const ROWS = 20;
/** renderFooterLines always yields two lines. */
const FOOTER_LINES = 2;
const VIEWPORT = ROWS - 4 - FOOTER_LINES;

const CWD = mkdtempSync(path.join(tmpdir(), "pi-watchoverlay-cwd-")); // no .git: branch null
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

const userEntry = (text: string) => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});
const marker = (content: string, tokensAtSwap: number) => ({
	type: "custom_message",
	customType: "context-cap-swap",
	content,
	display: true,
	details: { tokensAtSwap, trigger: "soft" },
});
const filler = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => assistantEntry(`${prefix} line ${i + 1}`));

/** Task, 10 filler, handoff 1, 10 filler, handoff 2, `tail` filler. */
const twoHandoffs = (tail: number) => [
	userEntry("TASK"),
	...filler("A", 10),
	marker("HANDOFF-ONE body", 162_000),
	...filler("B", 10),
	marker("HANDOFF-TWO body", 58_400),
	...filler("C", tail),
];

function makeRecord(id: string, entries: unknown[], extra: Partial<ChildRecord> = {}): ChildRecord {
	const session = {
		getContextUsage: () => ({ tokens: 1500, contextWindow: 200_000, percent: 0.75 }),
		getSessionStats: () => ({ cost: 0.25 }),
		sessionManager: { getEntries: () => [] },
		messages: [],
		sessionName: `agent#${id}`,
		thinkingLevel: "off",
		model: undefined,
		dispose() {},
	};
	const view = new ChildView({ getToolDefinition: () => undefined } as never, "/tmp");
	view.replay(entries);
	const record: ChildRecord = {
		id,
		kind: "agent",
		sid: `sid-${id}`,
		rootSid: "root",
		session: session as never,
		view,
		description: `desc ${id}`,
		turns: 3,
		elapsedMs: 65_000,
		running: false,
		...extra,
	};
	liveChildren.set(id, record);
	return record;
}

interface Overlay {
	render(width?: number): string[];
	/** handleInput + render (the real TUI renders between inputs). */
	press(data: string, width?: number): string[];
	dispose(): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Open the overlay (view when `initial` is set, else the picker) on a fake TUI. */
function openOverlay(initial: ChildRecord | undefined, rows = ROWS): Overlay {
	type Component = {
		render(width: number): string[];
		handleInput(data: string): void;
		dispose(): void;
	};
	let component: Component | undefined;
	const tui = { terminal: { rows, columns: WIDTH }, requestRender() {} };
	const ctx = {
		cwd: CWD,
		modelRegistry: { isUsingOAuth: () => false },
		ui: {
			custom(factory: (...args: unknown[]) => Component) {
				component = factory(tui, theme, {}, () => {});
				return new Promise(() => {}); // settles on done(); never needed here
			},
		},
	} as unknown as ExtensionContext;
	// watchOverlay runs synchronously up to ui.custom, so the factory has run on return.
	void (initial ? openChildView(ctx, initial) : openChildPicker(ctx));
	assert.ok(component, "ui.custom factory was invoked");
	const c = component;
	return {
		render: (width = WIDTH) => plain(c.render(width)),
		press(data, width = WIDTH) {
			c.handleInput(data);
			return plain(c.render(width));
		},
		dispose: () => c.dispose(),
	};
}

/**
 * Run `body` with an open overlay: stdout escapes captured, and the overlay
 * disposed + liveChildren cleared no matter what (a live ticker hangs the suite).
 */
function withOverlay(initial: ChildRecord | undefined, body: (overlay: Overlay) => void, rows = ROWS): void {
	const originalWrite = process.stdout.write;
	const writes: string[] = [];
	process.stdout.write = ((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	let overlay: Overlay | undefined;
	try {
		overlay = openOverlay(initial, rows);
		body(overlay);
	} finally {
		overlay?.dispose();
		process.stdout.write = originalWrite;
		liveChildren.clear();
	}
	assert.ok(writes.some((w) => w.includes("\x1b[?1000h")), "mouse mode was enabled (and captured)");
}

/** Layout of a view frame: 2 header lines, VIEWPORT body lines, blank, hint, footer. */
function parts(frame: string[]) {
	assert.equal(frame.length, ROWS, "frame fills the terminal rows");
	return {
		header: frame[0]!,
		header2: frame[1]!,
		body: frame.slice(2, 2 + VIEWPORT),
		blank: frame[2 + VIEWPORT]!,
		hint: frame[3 + VIEWPORT]!,
		footer: frame.slice(4 + VIEWPORT),
	};
}

/** The record's body and anchors at WIDTH (as renderView computes them). */
function layout(record: ChildRecord) {
	const body = plain(record.view.render(WIDTH));
	return { body, anchors: [...record.view.handoffAnchors], maxOffset: Math.max(0, body.length - VIEWPORT) };
}

test("no handoffs: header line 2, viewport height, hint without the handoff key", () => {
	const record = makeRecord("n0", [userEntry("TASK"), ...filler("A", 20)]);
	const { body, maxOffset } = layout(record);
	withOverlay(record, (overlay) => {
		const frame = parts(overlay.render());
		assert.equal(frame.header, "■ agent#n0 · desc n0 · 3 turns · finished");
		assert.equal(frame.header2, "  ⇄ no handoffs · 1m05s");
		assert.deepEqual(frame.body, body.slice(maxOffset, maxOffset + VIEWPORT), "follows the tail");
		assert.equal(frame.blank, "");
		assert.equal(frame.footer.length, FOOTER_LINES);
		assert.doesNotMatch(frame.hint, /shift\+↑↓ handoff/);
		assert.match(frame.hint, /^esc back · /, "following: no paused prefix");
		// Shift+↓ with no anchors: tail (already there), frame unchanged.
		assert.deepEqual(overlay.press(SHIFT_DOWN), overlay.render());
	});
});

test("handoffs: Shift+↓/↑ put dividers at the top; context k; paused first; tail at the end", () => {
	const record = makeRecord("h2", twoHandoffs(10));
	const { body, anchors, maxOffset } = layout(record);
	assert.equal(anchors.length, 2);
	assert.ok(anchors[1]! < maxOffset, "precondition: handoff 2 can be the top line");
	withOverlay(record, (overlay) => {
		let frame = parts(overlay.render());
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 1m05s");
		assert.match(frame.hint, /^esc back · wheel\/↑↓\/pgup\/pgdn scroll · shift\+↑↓ handoff · /);
		for (const line of overlay.render()) assert.ok(visibleWidth(line) <= WIDTH, `fits: ${line}`);

		frame = parts(overlay.press(HOME));
		assert.equal(frame.body[0], body[0]);
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 1/3 · 1m05s");
		assert.match(frame.hint, /^paused · esc back · /, "paused leads the hint");

		frame = parts(overlay.press(SHIFT_DOWN));
		assert.match(frame.body[0]!, /^── ⇄ handoff 1\/2 · at 162k tokens · soft cap ─+$/);
		assert.deepEqual(frame.body, body.slice(anchors[0]!, anchors[0]! + VIEWPORT));
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 2/3 · 1m05s");

		frame = parts(overlay.press(SHIFT_DOWN));
		assert.match(frame.body[0]!, /^── ⇄ handoff 2\/2 · at 58k tokens · soft cap ─+$/);
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 1m05s");
		assert.match(frame.hint, /^paused · /);

		// Past the last anchor: tail + follow, and it stays there.
		frame = parts(overlay.press(SHIFT_DOWN));
		assert.deepEqual(frame.body, body.slice(maxOffset));
		assert.match(frame.hint, /^esc back · /, "following again");
		assert.deepEqual(overlay.press(SHIFT_DOWN), overlay.render());

		// Up from the tail: the last anchor strictly above the top.
		frame = parts(overlay.press(SHIFT_UP));
		assert.equal(frame.body[0], body[anchors[1]!]);
		frame = parts(overlay.press(SHIFT_UP));
		assert.equal(frame.body[0], body[anchors[0]!]);
		// Up with no anchor above: stays put.
		assert.equal(parts(overlay.press(SHIFT_UP)).body[0], body[anchors[0]!]);

		frame = parts(overlay.press(END));
		assert.deepEqual(frame.body, body.slice(maxOffset));
	});
});

test("handoff on the final screen: Shift+↓ goes to the tail (no stuck repeat); tail shows its context", () => {
	const record = makeRecord("h3", twoHandoffs(2));
	const { body, anchors, maxOffset } = layout(record);
	assert.ok(anchors[1]! > maxOffset, "precondition: handoff 2 is on the final screen");
	assert.ok(anchors[0]! < maxOffset, "precondition: handoff 1 is above the final screen");
	withOverlay(record, (overlay) => {
		// Tail: top line is in context 2, the last visible line in context 3.
		let frame = parts(overlay.render());
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 1m05s");

		overlay.press(HOME);
		frame = parts(overlay.press(SHIFT_DOWN));
		assert.equal(frame.body[0], body[anchors[0]!]);
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 2/3 · 1m05s");

		frame = parts(overlay.press(SHIFT_DOWN));
		assert.deepEqual(frame.body, body.slice(maxOffset), "tail, not an unreachable anchor 2");
		assert.ok(frame.body.includes(body[anchors[1]!]!), "handoff 2 is visible on the tail screen");
		assert.match(frame.hint, /^esc back · /, "following");
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 1m05s");
		// Repeated Shift+↓: identical frame (no re-targeting).
		assert.deepEqual(overlay.press(SHIFT_DOWN), overlay.render());

		// Shift+↑ from the tail skips the on-screen anchor 2.
		frame = parts(overlay.press(SHIFT_UP));
		assert.equal(frame.body[0], body[anchors[0]!]);
		assert.equal(frame.header2, "  ⇄ 2 handoffs · context 2/3 · 1m05s");
	});
});

test("running child: header line 2 duration is live (previous runs + current run)", () => {
	const base = 1_700_000_000_000;
	const realNow = Date.now;
	let now = base;
	Date.now = () => now;
	try {
		const record = makeRecord("r1", twoHandoffs(10), {
			running: true,
			elapsedMs: 5_000,
			runStartedAt: base - 125_000,
		});
		withOverlay(record, (overlay) => {
			let frame = parts(overlay.render());
			assert.equal(frame.header, "▶ agent#r1 · desc r1 · turn 4 · thinking");
			assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 2m10s");
			now += 5_000;
			frame = parts(overlay.render());
			assert.equal(frame.header2, "  ⇄ 2 handoffs · context 3/3 · 2m15s");
		});
	} finally {
		Date.now = realNow;
	}
});

test("picker rows: ⇄N right after kind#id, rows truncated to the width", () => {
	const finished = makeRecord("h2", twoHandoffs(1));
	const running = makeRecord("r1", [userEntry("TASK"), marker("M", 1000)], {
		running: true,
		runStartedAt: Date.now(),
	});
	const none = makeRecord("n0", [userEntry("TASK")]);
	assert.equal(
		pickerRow(finished),
		"■ agent#h2 ⇄2 · 3 turns · ctx 2k/200k (1%) · 0 resets · $0.250 · 1m05s · desc h2",
	);
	assert.equal(pickerRow(running), "▶ agent#r1 ⇄1 · desc r1 · turn 4 · thinking");
	assert.equal(pickerRow(none), "■ agent#n0 · 3 turns · ctx 2k/200k (1%) · 0 resets · $0.250 · 1m05s · desc n0");
	withOverlay(undefined, (overlay) => {
		const frame = overlay.render();
		assert.equal(frame[0], "Agent sessions (3)");
		// 83 columns, truncated to 80: the description is clipped, not ⇄N.
		assert.equal(frame[2], "> ■ agent#h2 ⇄2 · 3 turns · ctx 2k/200k (1%) · 0 resets · $0.250 · 1m05s · de...");
		assert.equal(visibleWidth(frame[2]!), WIDTH);
		assert.equal(frame[3], "  ▶ agent#r1 ⇄1 · desc r1 · turn 4 · thinking");
		const narrow = overlay.render(40);
		for (const line of narrow.slice(2, 5)) assert.ok(visibleWidth(line) <= 40, `row fits 40 cols: ${line}`);
		assert.ok(narrow[2]!.startsWith("> ■ agent#h2 ⇄2 · "), "⇄N survives truncation");
	});
});
