/**
 * BtwChat (lib/btw-chat.ts), driven on a fake TUI:
 *   - unmistakable chrome: full-width inverse banner on line 1, `┃` gutter on
 *     every other line, all lines within the width, frame = terminal rows;
 *   - placeholder on an empty thread, `… answering` while streaming;
 *   - Enter submits through the source's request; Esc aborts the streaming
 *     answer (turn lost) and closes;
 *   - pgup scrolls the transcript; terminalModes toggles wheel reporting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BTW_ANSWERING, BTW_BANNER, BTW_HINT, BTW_PLACEHOLDER, BtwChat } from "../lib/btw-chat.ts";
import { type BtwAgentMessage, ForkSnapshot } from "../lib/btw-context.ts";
import { type BtwSource, BtwThread, btwRequest } from "../lib/btw-thread.ts";
import { assistantMessage, fakeRegistry, finish, flush, streamPartial } from "./btw-fakes.ts";

initTheme(undefined, false);

const WIDTH = 60;
const ROWS = 24;
const ESC = "\x1b";
const ENTER = "\r";
const PAGE_UP = "\x1b[5~";
const YELLOW = "\x1b[33m";
const INVERSE = "\x1b[7m";

/** Real ANSI so widths and stripping behave like the real theme. */
const theme = {
	fg: (_color: string, text: string) => `${YELLOW}${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string) => `${INVERSE}${text}\x1b[27m`,
} as any;

function setup(options: { mode?: string } = {}) {
	const registry = fakeRegistry();
	const snapshot = new ForkSnapshot();
	snapshot.onRequest([{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 }] as BtwAgentMessage[]);
	const thread = new BtwThread();
	const source: BtwSource = {
		label: "main session",
		modelId: () => "m-1",
		request: () =>
			btwRequest({
				registry,
				model: { id: "m-1" } as any,
				thinkingLevel: "off",
				sessionId: "s",
				fork: snapshot.fork(),
			}),
	};
	const tui = { mode: options.mode, terminal: { rows: ROWS, columns: WIDTH }, requestRender() {} } as any;
	let closed = 0;
	const chat = new BtwChat(tui, theme, thread, source, () => closed++, { terminalModes: options.mode !== undefined });
	const type = (text: string) => {
		for (const ch of text) chat.handleInput(ch);
	};
	const frame = () => chat.render(WIDTH);
	return { registry, thread, chat, type, frame, closed: () => closed };
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

test("chrome: inverse full-width banner, gutter on every other line, fits width and rows", () => {
	const { chat, frame } = setup();
	chat.focused = true;
	const raw = frame();
	const lines = plain(raw);
	assert.equal(raw.length, ROWS, "fills the terminal height");
	assert.equal(lines[0], BTW_BANNER.padEnd(WIDTH, " "), "banner padded to the full width");
	assert.ok(raw[0]!.includes(INVERSE), "banner is a solid (inverse) bar");
	assert.equal(lines[1], "┃ forked from main session · m-1 · tools off · esc close");
	for (const [i, line] of raw.entries()) {
		assert.ok(visibleWidth(line) <= WIDTH, `line ${i} fits: ${lines[i]}`);
		if (i > 0) assert.ok(line.startsWith(`${YELLOW}┃`), `line ${i} carries the colored gutter: ${lines[i]}`);
	}
	assert.ok(lines.at(-1)!.startsWith(`┃ ${BTW_HINT.slice(0, 40)}`), `hint is the last line: ${lines.at(-1)}`);
	assert.ok(lines.some((l) => l.includes(BTW_PLACEHOLDER.slice(0, 30))), "empty-thread placeholder");
	// Editor borders in the banner color, inside the gutter.
	assert.ok(raw.some((l) => l.startsWith(`${YELLOW}┃\x1b[39m ${YELLOW}─`)), "editor border colored like the banner");
});

test("Enter sends the typed question; answering marker while streaming; answer shown after", async () => {
	const { registry, thread, type, frame } = setup();
	type("what now?");
	assert.equal(registry.calls.length, 0, "typing alone sends nothing");
	type(ENTER);
	assert.equal(registry.calls.length, 1, "Enter submits");
	assert.equal(thread.inFlight?.question, "what now?");
	let lines = plain(frame());
	assert.ok(lines.some((l) => l.includes("what now?")), "question shown (without the hidden preamble)");
	assert.ok(!lines.some((l) => l.includes("[btw —")), "preamble never shown");
	assert.ok(lines.some((l) => l.includes(BTW_ANSWERING)));

	type("second");
	type(ENTER);
	assert.equal(registry.calls.length, 1, "submit disabled while answering");

	streamPartial(registry.calls[0]!, "partial words");
	await flush();
	assert.ok(plain(frame()).some((l) => l.includes("partial words")), "streams into the view");

	finish(registry.calls[0]!, assistantMessage("I am refactoring the parser."));
	await flush();
	lines = plain(frame());
	assert.ok(lines.some((l) => l.includes("I am refactoring the parser.")));
	assert.ok(!lines.some((l) => l.includes(BTW_ANSWERING)));
	assert.ok(!lines.some((l) => l.includes(BTW_PLACEHOLDER.slice(0, 30))));
});

test("Esc while streaming: aborts (turn lost) and closes", async () => {
	const { registry, thread, chat, type, closed } = setup();
	type("q");
	type(ENTER);
	const call = registry.calls[0]!;
	chat.handleInput(ESC);
	assert.equal(closed(), 1, "esc closes");
	assert.equal(call.options.signal.aborted, true, "esc aborts the request");
	assert.equal(thread.answering, false);
	await flush();
	assert.deepEqual(thread.turns, [], "the in-flight turn is dropped");
});

test("pgup scrolls the transcript; wheel reports never reach the editor", async () => {
	const { registry, chat, type, frame } = setup();
	type("long?");
	type(ENTER);
	const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n");
	finish(registry.calls[0]!, assistantMessage(long));
	await flush();
	const tail = plain(frame());
	assert.ok(tail.some((l) => l.includes("line 60")), "follows the tail");
	chat.handleInput(PAGE_UP);
	const up = plain(frame());
	assert.ok(!up.some((l) => l.includes("line 60")), "scrolled up a page");
	chat.handleInput("\x1b[<64;10;5M"); // wheel up
	chat.handleInput("\x1b[<0;10;5M"); // click: swallowed
	assert.ok(!plain(frame()).some((l) => l.includes("[<")), "mouse reports did not land in the editor");
});

test("terminalModes: wheel reporting on for the chat's lifetime (main-screen pi)", () => {
	const originalWrite = process.stdout.write;
	const writes: string[] = [];
	process.stdout.write = ((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		const { chat } = setup({ mode: "regular" });
		assert.ok(writes.some((w) => w.includes("\x1b[?1000h")), "mouse on at open");
		chat.dispose();
		assert.ok(writes.some((w) => w.includes("\x1b[?1000l")), "mouse off at dispose");
	} finally {
		process.stdout.write = originalWrite;
	}
});
