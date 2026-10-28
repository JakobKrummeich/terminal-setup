// BtwChat: the btw side chat's full-screen UI — transcript of one BtwThread
// (lib/btw-thread.ts) plus an editor. Shown by /btw (btw.ts, its own overlay) and
// as the F2 watch overlay's "btw" mode for a child (lib/child-watch.ts).
//
// Deliberately LOUD: a btw exchange is never part of the session, so the chat
// must never be mistaken for the normal transcript — full-width warning banner,
// a `┃` gutter on every line below it, and editor borders in the same color.
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Editor,
	type Focusable,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { enterAltScreenWatch, enterWatchMouse } from "./alt-screen.ts";
import { displayAnswer } from "./btw-context.ts";
import { type BtwInFlight, type BtwSource, BtwThread } from "./btw-thread.ts";
import { sgrWheelDelta, WatchViewport } from "./watch-viewport.ts";

export const BTW_BANNER = " BTW · SIDE CHAT — the agent does NOT see this · not saved ";
export const BTW_HINT = "enter send · shift+enter newline · pgup/pgdn scroll · esc close+abort";
export const BTW_PLACEHOLDER = 'Ask what the agent is doing — e.g. "what are you working on right now?"';
export const BTW_ANSWERING = "… answering";
const GUTTER_WIDTH = 2; // "┃ "
/**
 * OSC 133 shell-integration zone marks. pi's UserMessageComponent opens its lines
 * with them, and pi-tui strips them only at the START of a line. Behind the gutter
 * they would sit mid-line, where a terminal such as WezTerm treats `133;A` as
 * "fresh line" and breaks the row: every row below shifts down, the editor is cut
 * off and the differential renderer leaves stale rows (a ghost `… answering`).
 */
const OSC133 = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** The banner/gutter/border color — one token, so all btw chrome reads as one thing. */
const BTW_COLOR = "warning";

type BtwTheme = Pick<Theme, "fg" | "bold" | "inverse">;

export interface BtwChatOptions {
	/**
	 * Enter the alt screen + wheel reporting for the chat's lifetime (/btw's own
	 * overlay). False inside the F2 watch overlay, which already holds both.
	 */
	terminalModes: boolean;
}

/** `forked from <label> · <model id> · tools off · esc close` */
export function btwInfoLine(source: Pick<BtwSource, "label" | "modelId">): string {
	return `forked from ${source.label} · ${source.modelId() ?? "no model"} · tools off · esc close`;
}

export class BtwChat implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: BtwTheme;
	/**
	 * Ephemeral by design: one thread per open chat, never kept after close — a btw
	 * exchange is a quick status check, so reopening always starts empty.
	 */
	readonly thread = new BtwThread();
	private readonly source: BtwSource;
	private readonly onClose: () => void;
	private readonly editor: Editor;
	private readonly scroll = new WatchViewport();
	private readonly unsubscribe: () => void;
	private readonly modes: Array<{ exit(): void }> = [];
	private body = new Container();
	private streaming: AssistantMessageComponent | undefined;
	/** What `body` was built from: rebuilt only when a turn or the flight changes. */
	private shownTurns = -1;
	private shownFlight: BtwInFlight | undefined;
	private focusState = false;

	constructor(
		tui: TUI,
		theme: BtwTheme,
		source: BtwSource,
		onClose: () => void,
		options: BtwChatOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.onClose = onClose;
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg(BTW_COLOR, text),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => this.submit(text);
		this.unsubscribe = this.thread.subscribe(() => this.sync());
		if (options.terminalModes) {
			// Same order as the F2 WatchOverlay: mouse first, alt screen second; dispose
			// exits them in reverse (alt screen before the mouse reset).
			const mouse = enterWatchMouse(tui);
			const altScreen = enterAltScreenWatch(tui);
			for (const mode of [altScreen, mouse]) if (mode) this.modes.push(mode);
		}
		this.sync();
	}

	get focused(): boolean {
		return this.focusState;
	}

	/** Focusable: forwarded so the editor emits the hardware-cursor marker. */
	set focused(value: boolean) {
		this.focusState = value;
		this.editor.focused = value;
	}

	/** Send a question (Enter, or /btw's argument). Ignored while an answer streams. */
	submit(question: string): void {
		const text = question.trim();
		if (!text || this.thread.answering) return;
		this.scroll.end();
		void this.thread.ask(text, () => this.source.request());
	}

	/** Esc: abort a streaming answer (its turn is lost), then close. */
	close(): void {
		this.thread.abort();
		this.onClose();
	}

	dispose(): void {
		this.unsubscribe();
		this.thread.abort();
		for (const mode of this.modes.splice(0)) mode.exit();
	}

	invalidate(): void {
		this.body.invalidate();
		this.editor.invalidate();
	}

	handleInput(data: string): void {
		// Mouse reports first and always consumed (a click must not reach the editor as keys).
		const wheel = sgrWheelDelta(data);
		if (wheel !== undefined) this.scrollBy(wheel);
		else if (matchesKey(data, "escape")) this.close();
		else if (matchesKey(data, "pageUp")) this.scrollBy(-(this.scroll.viewport - 1));
		else if (matchesKey(data, "pageDown")) this.scrollBy(this.scroll.viewport - 1);
		else this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - GUTTER_WIDTH);
		const rows = this.tui.terminal.rows;
		const editorLines = this.editor.render(inner);
		const header = [this.banner(width), truncateToWidth(btwInfoLine(this.source), inner)];
		const hint = this.theme.fg("muted", truncateToWidth(BTW_HINT, inner));
		const viewport = Math.max(1, rows - header.length - editorLines.length - 1);
		const body = this.body.render(inner);
		this.scroll.layout(body.length, viewport);
		const guttered = [header[1]!, ...this.scroll.window(body), ...editorLines, hint].map((line) =>
			this.gutter(line),
		);
		return [header[0]!, ...guttered].slice(0, rows);
	}

	private scrollBy(delta: number): void {
		if (delta !== 0) this.scroll.scrollBy(delta);
	}

	private banner(width: number): string {
		const padded = truncateToWidth(BTW_BANNER, width, "", true);
		// inverse of the warning foreground = a solid warning-colored bar on any theme.
		return this.theme.inverse(this.theme.bold(this.theme.fg(BTW_COLOR, padded)));
	}

	private gutter(line: string): string {
		return `${this.theme.fg(BTW_COLOR, "┃")} ${line.replace(OSC133, "")}`;
	}

	/** Thread changed: rebuild on a new turn/flight, else stream into the live answer. */
	private sync(): void {
		const flight = this.thread.inFlight;
		if (this.thread.turns.length !== this.shownTurns || flight !== this.shownFlight) this.rebuild();
		else if (flight?.partial) this.streaming?.updateContent(displayAnswer(flight.partial));
		this.editor.disableSubmit = this.thread.answering;
		this.tui.requestRender();
	}

	private rebuild(): void {
		const { turns, inFlight } = this.thread;
		this.shownTurns = turns.length;
		this.shownFlight = inFlight;
		const body = new Container();
		if (turns.length === 0 && !inFlight) body.addChild(new Text(this.theme.fg("muted", BTW_PLACEHOLDER), 0, 0));
		for (const turn of turns) {
			addExchange(body, turn.question, new AssistantMessageComponent(displayAnswer(turn.answer), false, getMarkdownTheme()));
		}
		this.streaming = undefined;
		if (inFlight) {
			const partial = inFlight.partial && displayAnswer(inFlight.partial);
			this.streaming = new AssistantMessageComponent(partial, false, getMarkdownTheme());
			addExchange(body, inFlight.question, this.streaming);
			body.addChild(new Text(this.theme.fg(BTW_COLOR, BTW_ANSWERING), 0, 0));
		}
		this.body = body;
	}
}

function addExchange(body: Container, question: string, answer: Component): void {
	body.addChild(new Spacer(1));
	body.addChild(new UserMessageComponent(question, getMarkdownTheme()));
	body.addChild(answer);
}
