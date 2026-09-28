// F2 watch view chrome, pure: the scroll state of the transcript viewport
// (WatchViewport), the header / hint / position text around it, the handoff
// navigation math, and the SGR mouse-wheel decoding. The overlay that wires them
// to the TUI lives in lib/child-watch.ts.
import type { KeyId } from "@earendil-works/pi-tui";
import { formatDuration, statusLine } from "./child-runs.ts";
import type { ChildRecord } from "./child-types.ts";

const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
const EXPAND_KEY = (process.env.PI_SUBAGENT_EXPAND_KEY ?? "ctrl+o") as KeyId;
const SGR_MOUSE = /^\u001b\[<(\d+);\d+;\d+([Mm])$/;
const WHEEL_LINES = 3;

export { WATCH_KEY, EXPAND_KEY };

/** Total run time including the in-flight run (elapsedMs only grows when a run ends). */
export function liveElapsedMs(
	record: Pick<ChildRecord, "elapsedMs" | "running" | "runStartedAt">,
	now = Date.now(),
): number {
	return record.elapsedMs + (record.running && record.runStartedAt ? Math.max(0, now - record.runStartedAt) : 0);
}

/**
 * Second header line of the watch view: `⇄ N handoffs · context k/N+1 · duration`
 * (`⇄ no handoffs · duration` without any). No ctx/cost: the child footer below
 * shows those. `k` is the 1-based context the viewport shows (handoffViewContext).
 */
export function handoffHeaderLine(count: number, k: number, durationMs: number): string {
	const handoffs =
		count === 0
			? ["\u21c4 no handoffs"]
			: [`\u21c4 ${count} ${count === 1 ? "handoff" : "handoffs"}`, `context ${k}/${count + 1}`];
	return [...handoffs, formatDuration(durationMs)].join(" \u00b7 ");
}

/** 1-based context index of body line `top`: 1 + handoff anchors at or above it. */
export function handoffContextIndex(anchors: readonly number[], top: number): number {
	return 1 + anchors.filter((anchor) => anchor <= top).length;
}

/**
 * The context `k` the watch header shows for a viewport at `offset` (`viewport`
 * lines of a `bodyLength`-line body): the top line's context — except at the
 * tail (offset ≥ maxOffset, incl. following), where it is the LAST visible
 * line's, so a live run shows the context it is currently in.
 */
export function handoffViewContext(
	anchors: readonly number[],
	offset: number,
	viewport: number,
	bodyLength: number,
): number {
	const maxOffset = Math.max(0, bodyLength - viewport);
	if (offset < maxOffset) return handoffContextIndex(anchors, offset);
	return handoffContextIndex(anchors, Math.min(offset + viewport, bodyLength) - 1);
}

/**
 * Shift+↑/↓ target in the watch view: the first anchor strictly below `top`
 * (dir 1) or the last anchor strictly above it (dir -1; undefined = stay put).
 * Down returns "tail" (follow the end) when there is no such anchor or it lies
 * beyond `maxOffset` — it is already on the final screen and can never become
 * the top line, so re-targeting it would get stuck. Up from the tail skips
 * anchors on the final screen by design (they are already visible).
 */
export function handoffJumpTarget(
	anchors: readonly number[],
	top: number,
	dir: -1 | 1,
	maxOffset: number,
): number | "tail" | undefined {
	if (dir === 1) {
		const next = anchors.find((anchor) => anchor > top);
		return next === undefined || next > maxOffset ? "tail" : next;
	}
	return anchors.filter((anchor) => anchor < top).at(-1);
}

/**
 * Scroll state of one watch view: which body lines the viewport shows. One
 * instance per open overlay (a WatchOverlay field, lib/child-watch.ts) — never module state.
 * `offset` is the top body line; while `follow` is set, layout() pins it to the
 * tail so a live run scrolls along. `viewport` and `maxOffset` are those of the
 * LATEST layout(): input handlers act on what the user currently sees.
 */
export class WatchViewport {
	offset = 0;
	follow = true;
	viewport = 1;
	/** Largest top offset of the latest layout (the Shift+↓ tail bound). */
	maxOffset = 0;

	/**
	 * Settle the offset for a `bodyLength`-line body in `viewport` rows. Following →
	 * the tail; a paused offset at or past the tail (scrolled down onto it, or the
	 * body shrank) re-follows, so scrolling to the end resumes live tracking.
	 */
	layout(bodyLength: number, viewport: number): void {
		this.viewport = viewport;
		this.maxOffset = Math.max(0, bodyLength - viewport);
		if (this.follow) this.offset = this.maxOffset;
		else if (this.offset >= this.maxOffset) {
			this.offset = this.maxOffset;
			this.follow = true;
		}
	}

	/** Pause and move the top by `delta` lines; the tail clamp happens in layout(). */
	scrollBy(delta: number): void {
		this.follow = false;
		this.offset = Math.max(0, this.offset + delta);
	}

	home(): void {
		this.follow = false;
		this.offset = 0;
	}

	end(): void {
		this.follow = true;
	}

	/**
	 * Shift+↑/↓: move the top to the next/previous handoff anchor (handoffJumpTarget).
	 * `offset` is the effective top even while following: layout() pins it to
	 * maxOffset, and anchors and maxOffset come from the same (latest) render.
	 * Returns false when there is nowhere to go (nothing changed, no redraw needed).
	 */
	jumpHandoff(anchors: readonly number[], dir: -1 | 1): boolean {
		const target = handoffJumpTarget(anchors, this.offset, dir, this.maxOffset);
		if (target === undefined) return false;
		if (target === "tail") this.follow = true;
		else {
			this.follow = false;
			this.offset = target;
		}
		return true;
	}

	/** The visible body lines, padded with blanks to exactly `viewport` rows. */
	window(body: readonly string[]): string[] {
		const lines = body.slice(this.offset, this.offset + this.viewport);
		while (lines.length < this.viewport) lines.push("");
		return lines;
	}

	/** The header's `context k` for the current layout (handoffViewContext). */
	contextIndex(anchors: readonly number[], bodyLength: number): number {
		return handoffViewContext(anchors, this.offset, this.viewport, bodyLength);
	}
}

/** ` (i/N)` of `current` among the children; empty for a lone or evicted child. */
export function watchPositionLabel(all: readonly ChildRecord[], current: ChildRecord): string {
	const idx = all.indexOf(current);
	return all.length > 1 && idx >= 0 ? ` (${idx + 1}/${all.length})` : "";
}

/**
 * The watch view's two header lines (untruncated): live status or final summary
 * plus `pos`, then the handoff line for context `k` (handoffHeaderLine).
 */
export function watchHeaderLines(record: ChildRecord, pos: string, k: number): [string, string] {
	const header = record.running
		? `▶ ${statusLine(record)}${pos}`
		: `■ ${record.kind}#${record.id} · ${record.description} · ${record.turns} turns · finished${pos}`;
	return [header, `  ${handoffHeaderLine(record.view.handoffCount, k, liveElapsedMs(record))}`];
}

/** The watch view's key hint (untruncated). */
export function watchHintLine(follow: boolean, handoffs: number, pos: string): string {
	// `paused` first: a narrow terminal clips the hint's tail, not the state.
	return `${follow ? "" : "paused · "}esc back · wheel/↑↓/pgup/pgdn scroll${handoffs > 0 ? " · shift+↑↓ handoff" : ""} · end follow · ${EXPAND_KEY} expand${
		pos ? ` · ←/→ agents · ${WATCH_KEY} next${pos}` : ""
	}`;
}

/**
 * Lines to scroll for an SGR mouse report: ±WHEEL_LINES for wheel up/down, 0 for
 * any other mouse event (swallowed), undefined when `data` is not a mouse report.
 */
export function sgrWheelDelta(data: string): number | undefined {
	const mouse = SGR_MOUSE.exec(data);
	if (!mouse) return undefined;
	const button = Number(mouse[1]);
	if (button === 64) return -WHEEL_LINES;
	if (button === 65) return WHEEL_LINES;
	return 0;
}
