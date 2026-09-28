// F2 watch: the full-screen overlay over all child sessions — a picker (one row per
// child) and a per-child transcript view (ChildView, lib/child-view.ts) with the
// child's own footer, rendered on the terminal's alternate screen. Reads the child
// registry (liveChildren) owned by lib/child-session.ts; child-session never calls
// back into this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ChildRecord,
	collectMeta,
	formatDuration,
	liveChildren,
	metaLine,
	statusLine,
} from "./child-session.ts";
import { CONTEXT_CAP_STATUS_KEY, resolveTriggers } from "./env.ts";
import { formatCapStatus } from "./format.ts";
import { renderFooterLines } from "./footer.ts";
import { sharedState } from "./shared-state.ts";

const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
const EXPAND_KEY = (process.env.PI_SUBAGENT_EXPAND_KEY ?? "ctrl+o") as KeyId;
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";
const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const SGR_MOUSE = /^\u001b\[<(\d+);\d+;\d+([Mm])$/;
const WHEEL_LINES = 3;

export { WATCH_KEY, EXPAND_KEY };

// On globalThis like child-session's state (see lib/shared-state.ts): the cursor must
// survive the module re-import pi does on every session bind (jiti, moduleCache: false).
interface WatchState {
	/** F2 watch cursor: id of the last watched child, advanced per watchTarget() call. */
	watchCursor: string | undefined;
}
// Bump N whenever WatchState's shape changes (see sharedState()).
const STATE_KEY = Symbol.for("terminal-setup.child-watch.v1");
const state = sharedState<WatchState>(STATE_KEY, () => ({ watchCursor: undefined }));

/**
 * Session teardown for the watch: forget the cursor. subagent.ts calls it next to
 * resetChildState() (which drops the children the cursor points into).
 */
export function resetWatchCursor(): void {
	state.watchCursor = undefined;
}

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
 * instance per open overlay (created in watchOverlay) — never module state.
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

/**
 * An ordered key table: the first entry whose key matches wins. Order is the
 * contract — WATCH_KEY / EXPAND_KEY are env-configurable, so their position
 * decides which action a colliding key gets.
 */
type KeyTable = ReadonlyArray<readonly [KeyId, () => void]>;

/** Run the first matching action; false when no key in the table matched. */
function dispatchKey(data: string, table: KeyTable): boolean {
	const hit = table.find(([key]) => matchesKey(data, key));
	hit?.[1]();
	return hit !== undefined;
}

function gitBranch(cwd: string): string | null {
	try {
		let gitDir = join(cwd, ".git");
		try {
			const pointer = readFileSync(gitDir, "utf8").match(/^gitdir: (.+)$/m);
			if (pointer?.[1]) gitDir = pointer[1].trim();
		} catch {}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		return match?.[1] ?? head.slice(0, 7);
	} catch {
		return null;
	}
}

function childFooterData(ctx: ExtensionContext, record: ChildRecord, branch: string | null) {
	const session = record.session;
	const usage = session.getContextUsage();
	// The child has its own model, so resolve ITS soft cap rather than showing the
	// static ceiling — a small-window child swaps far below 260k (see lib/env.ts).
	// A disabled cap is +Infinity, which formatCapStatus renders as "off".
	const caps = resolveTriggers(usage?.contextWindow);
	return {
		cost: session.getSessionStats().cost,
		usingSubscription: session.model ? ctx.modelRegistry.isUsingOAuth(session.model) : false,
		cwd: ctx.cwd,
		branch,
		sessionName: session.sessionName,
		modelId: session.model?.id,
		reasoning: session.model?.reasoning === true,
		thinkingLevel: session.thinkingLevel,
		statuses: new Map([[CONTEXT_CAP_STATUS_KEY, formatCapStatus(usage?.tokens, caps.soft)]]),
	};
}

/**
 * One picker row (marker + live status / final meta), with `⇄N` right after the
 * leading `kind#id` when the child had handoffs — early in the row, so narrow
 * terminals clip the tail first. Selection styling is added by the caller.
 */
export function pickerRow(record: ChildRecord): string {
	const line = record.running
		? statusLine(record)
		: `${metaLine(collectMeta(record))} · ${record.description}`;
	const handoffs = record.view.handoffCount;
	// statusLine and metaLine both start with `${kind}#${id}`.
	const label = `${record.kind}#${record.id}`;
	const tagged =
		handoffs > 0 && line.startsWith(label)
			? `${label} \u21c4${handoffs}${line.slice(label.length)}`
			: line;
	return `${record.running ? "▶" : "■"} ${tagged}`;
}

/**
 * Wrapping selection move for the picker. Clamps a stale index first: eviction
 * can shrink the list while the picker is open, leaving `index` past the end.
 */
export function movePickerSelection(index: number, delta: number, count: number): number {
	if (count <= 0) return 0;
	const clamped = Math.min(Math.max(index, 0), count - 1);
	return (((clamped + delta) % count) + count) % count;
}

export async function openChildView(ctx: ExtensionContext, initial: ChildRecord): Promise<void> {
	return watchOverlay(ctx, initial);
}

/** Dashboard of all children; enter/digits drill into a child view, esc from there returns here. */
export async function openChildPicker(ctx: ExtensionContext): Promise<void> {
	return watchOverlay(ctx, undefined);
}

/**
 * The slice of TuiMainScreen the watch view needs to move rendering onto the
 * terminal's alternate screen. Internal pi-tui API (same coupling class as
 * markdown-no-padding's paddingX patch) — feature-detected, so a pi update that
 * renames it degrades to the old main-screen overlay instead of breaking F2.
 * Re-verify after `pi update`.
 */
interface AltScreenCapableTui {
	/** "regular" on TuiMainScreen; TuiAltScreen reports "fullscreen". */
	mode?: string;
	captureRenderState?(): unknown;
	restoreRenderState?(state: unknown): void;
	requestRender(): void;
}

/**
 * Render the watch view on the terminal's ALTERNATE screen (vim/less style).
 *
 * Why: the overlay is composited into the same frame buffer whose rows the
 * renderer scrolls into terminal scrollback. Whenever base content moves while
 * the full-screen view is up (parent streaming under it, resize-triggered
 * redraws, emulator timing), overlay rows can be committed verbatim into the
 * parent transcript's scrollback — seen live as "agent#… · turn N · running
 * read" headers mingled into history. The alternate screen has no scrollback
 * and is dropped wholesale on exit, so the entire hazard class disappears.
 *
 * Mechanics: save the renderer's differential state, switch to the alt screen,
 * reset the state so the next frame is a full paint (of the overlay-composited
 * frame) onto the blank alt screen. On exit, switch back — the terminal
 * restores the exact pre-F2 main screen — and hand the renderer its saved
 * state so it resumes diffing against what is actually on screen.
 *
 * Returns null (no-op) when pi already runs its whole TUI on the alt screen
 * (tuiMode "alt-screen") or the internal API is missing — the plain overlay
 * behavior is kept there.
 */
export function enterAltScreenWatch(tui: unknown): { exit(): void } | null {
	const t = tui as AltScreenCapableTui;
	if (
		t.mode !== "regular" ||
		typeof t.captureRenderState !== "function" ||
		typeof t.restoreRenderState !== "function"
	)
		return null;
	const saved = t.captureRenderState();
	process.stdout.write(ALT_SCREEN_ON);
	// Blank state, seeded from the captured shape so unknown future fields keep
	// sane values. previousWidth/Height 0 (not resetRenderState's -1) steers the
	// next frame into the "first render" branch — a plain full paint from the
	// alt screen's home position with NO \x1b[2J/\x1b[3J, so nothing that could
	// touch main-screen state or history is ever emitted while entering.
	t.restoreRenderState({
		...(typeof saved === "object" && saved !== null ? saved : {}),
		previousLines: [],
		previousWidth: 0,
		previousHeight: 0,
		cursorRow: 0,
		hardwareCursorRow: 0,
		maxLinesRendered: 0,
		previousViewportTop: 0,
	});
	let exited = false;
	return {
		exit() {
			// Idempotent: dispose is the normal caller, but a defensive second call
			// must not flip the terminal to the alt screen's blank state again.
			if (exited) return;
			exited = true;
			process.stdout.write(ALT_SCREEN_OFF);
			t.restoreRenderState?.(saved);
			t.requestRender();
		},
	};
}

async function watchOverlay(ctx: ExtensionContext, initial: ChildRecord | undefined): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			// One overlay, two modes: "picker" (row per child) and "view" (one child's
			// transcript). Mode switching inside a single ui.custom keeps esc-from-view
			// returning to a still-live picker without re-opening the overlay.
			const fromPicker = initial === undefined;
			let mode: "picker" | "view" = fromPicker ? "picker" : "view";
			// Open the picker on the last-watched child, not row 0 (fresh cursor → first row).
			let selected = Math.max(
				0,
				[...liveChildren.values()].findIndex((r) => r.id === state.watchCursor),
			);
			// Swappable: WATCH_KEY/←/→ inside the view cycle children without closing
			// and reopening the overlay. Undefined only while in picker mode.
			let record: ChildRecord | undefined = initial;
			record?.view.setRenderer(() => tui.requestRender());
			// Resolved once per view open: childFooterData runs in render() on every frame,
			// and gitBranch does up to 2 sync file reads. Branch changes mid-view are rare
			// and the view is reopened often, so a per-open snapshot is fine.
			const branch = gitBranch(ctx.cwd);
			const childFooter = (width: number, current: ChildRecord) =>
				renderFooterLines(width, theme as never, childFooterData(ctx, current, branch));
			process.stdout.write(MOUSE_ON);
			// Alt screen for the whole picker/view lifetime; null on alt-screen pi.
			const altScreen = enterAltScreenWatch(tui);
			// Picker rows must track running children (turn count, current tool) even
			// when no view renderer is attached; a coarse tick beats subscribing to
			// every child session just for a redraw.
			const ticker = setInterval(() => tui.requestRender(), 1000);
			const scroll = new WatchViewport();
			const scrollBy = (delta: number) => {
				scroll.scrollBy(delta);
				tui.requestRender();
			};
			const switchTo = (next: ChildRecord) => {
				if (next === record) return;
				record?.view.setRenderer(() => {});
				record = next;
				record.view.setRenderer(() => tui.requestRender());
				scroll.end(); // fresh child: jump to the tail and follow it
				tui.requestRender();
			};
			const enterView = (target: ChildRecord) => {
				// Keep the outer F2 shortcut cycling from wherever the picker jumped to.
				state.watchCursor = target.id;
				mode = "view";
				switchTo(target);
				tui.requestRender();
			};
			const leaveView = () => {
				// Esc from a picker-opened view goes back to the picker — unless eviction
				// shrank the list to ≤1 child, where a picker would be pointless.
				if (!fromPicker || liveChildren.size <= 1) {
					done();
					return;
				}
				const idx = [...liveChildren.values()].indexOf(record!);
				if (idx >= 0) selected = idx;
				record?.view.setRenderer(() => {});
				record = undefined;
				mode = "picker";
				tui.requestRender();
			};
			const renderPicker = (width: number): string[] => {
				const all = [...liveChildren.values()];
				if (all.length === 0) return ["No agent sessions.", "", "esc close"];
				selected = Math.min(selected, all.length - 1); // eviction clamp
				const rows = all.map((r, i) =>
					i === selected
						? (theme as Theme).fg("accent", truncateToWidth(`> ${pickerRow(r)}`, width))
						: truncateToWidth(`  ${pickerRow(r)}`, width),
				);
				const hint = "↑↓ select · enter open · 1-9 jump · esc close";
				return [`Agent sessions (${all.length})`, "", ...rows, "", hint].slice(0, tui.terminal.rows);
			};
			const renderView = (width: number): string[] => {
				const current = record!;
				const pos = watchPositionLabel([...liveChildren.values()], current);
				const footerLines = childFooter(width, current);
				// Two header lines + blank + hint around the body.
				const viewportRows = Math.max(1, tui.terminal.rows - 4 - footerLines.length);
				const body = current.view.render(width);
				scroll.layout(body.length, viewportRows);
				// After the offset settles: line 2's `context k/N+1` depends on the viewport.
				const k = scroll.contextIndex(current.view.handoffAnchors, body.length);
				const [header, header2] = watchHeaderLines(current, pos, k);
				const hint = watchHintLine(scroll.follow, current.view.handoffCount, pos);
				return [
					truncateToWidth(header, width),
					truncateToWidth(header2, width),
					...scroll.window(body),
					"",
					truncateToWidth(hint, width),
					...footerLines,
				].slice(0, tui.terminal.rows);
			};
			const movePicker = (delta: number) => {
				selected = movePickerSelection(selected, delta, liveChildren.size);
				tui.requestRender();
			};
			const openSelected = () => {
				const all = [...liveChildren.values()];
				const target = all[Math.min(selected, all.length - 1)];
				if (target) enterView(target);
			};
			const pickerKeys: KeyTable = [
				["escape", () => done()],
				["up", () => movePicker(-1)],
				["down", () => movePicker(1)],
				// WATCH_KEY too: tapping F2 repeatedly still walks through the children.
				[WATCH_KEY, () => movePicker(1)],
				["enter", openSelected],
			];
			const handlePickerInput = (data: string) => {
				if (dispatchKey(data, pickerKeys)) return;
				// 1-9: jump straight into that row's child.
				if (data.length === 1 && data >= "1" && data <= "9") {
					const target = [...liveChildren.values()][Number(data) - 1];
					if (target) enterView(target);
				}
			};
			const jumpHandoff = (dir: -1 | 1) => {
				if (scroll.jumpHandoff(record!.view.handoffAnchors, dir)) tui.requestRender();
			};
			const scrollHome = () => {
				scroll.home();
				tui.requestRender();
			};
			const scrollEnd = () => {
				scroll.end();
				tui.requestRender();
			};
			const showPrevChild = () => {
				const prev = prevChild(record!.id);
				if (prev) switchTo(prev);
			};
			const showNextChild = () => {
				const next = nextChild(record!.id);
				if (next) switchTo(next);
			};
			// Order matters: escape first; shift+↑/↓ before plain ↑/↓; the configurable
			// EXPAND_KEY and WATCH_KEY after the fixed keys (see KeyTable), so a configured
			// key that collides with a fixed one keeps the fixed key's action.
			const viewKeys: KeyTable = [
				["escape", leaveView],
				["shift+up", () => jumpHandoff(-1)],
				["shift+down", () => jumpHandoff(1)],
				["up", () => scrollBy(-1)],
				["down", () => scrollBy(1)],
				["pageUp", () => scrollBy(-(scroll.viewport - 1))],
				["pageDown", () => scrollBy(scroll.viewport - 1)],
				["home", scrollHome],
				["end", scrollEnd],
				[EXPAND_KEY, () => record!.view.toggleExpanded()],
				["left", showPrevChild],
				["right", showNextChild],
				[WATCH_KEY, showNextChild],
			];
			const handleViewInput = (data: string) => {
				// Mouse reports first and always consumed: a click (non-wheel button) is
				// swallowed rather than parsed as keys.
				const wheel = sgrWheelDelta(data);
				if (wheel === undefined) dispatchKey(data, viewKeys);
				else if (wheel !== 0) scrollBy(wheel);
			};
			return {
				dispose() {
					clearInterval(ticker);
					// Before MOUSE_OFF so the terminal leaves the alt screen first; both
					// run before pi's next render (dispose is synchronous in the close path,
					// renders are scheduled), so the renderer never draws between them.
					altScreen?.exit();
					process.stdout.write(MOUSE_OFF);
					record?.view.setRenderer(() => {});
				},
				invalidate() {},
				render(width: number): string[] {
					return mode === "picker" ? renderPicker(width) : renderView(width);
				},
				handleInput(data: string) {
					if (mode === "picker") handlePickerInput(data);
					else handleViewInput(data);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: () => ({
				anchor: "top-left",
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			}),
		},
	);
}

/**
 * Pick the child the F2 watch should open. Repeated presses cycle through ALL
 * children — running and finished — in spawn order, wrapping. When the cursor is
 * unset (or its child was evicted), start at the first running child if any, else
 * the most recent child.
 */
export function watchTarget(): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	// Id-based cursor: children starting or finishing between presses shift indices,
	// so an index cursor could skip an entry.
	const last = all.findIndex((r) => r.id === state.watchCursor);
	const target = last >= 0 ? all[(last + 1) % all.length] : (all.find((r) => r.running) ?? all.at(-1)!);
	state.watchCursor = target.id;
	return target;
}

/**
 * Child after `currentId` in spawn order (wrapping; first child if the id is
 * gone). Moves the F2 cursor so the outer shortcut stays in step with in-view
 * cycling.
 */
export function nextChild(currentId: string): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	const target = all[(all.findIndex((r) => r.id === currentId) + 1) % all.length];
	state.watchCursor = target.id;
	return target;
}

/**
 * Child before `currentId` in spawn order (wrapping; last child if the id is
 * gone). Moves the F2 cursor like nextChild so outer cycling stays in step.
 */
export function prevChild(currentId: string): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	const idx = all.findIndex((r) => r.id === currentId);
	const target = idx < 0 ? all.at(-1)! : all[(idx - 1 + all.length) % all.length]!;
	state.watchCursor = target.id;
	return target;
}
