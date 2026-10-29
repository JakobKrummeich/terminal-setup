// F2 watch: the full-screen overlay over all child sessions — a picker (one row per
// child) and a per-child transcript view (ChildView, lib/child-view.ts) with the
// child's own footer, rendered on the terminal's alternate screen. Reads the child
// registry (liveChildren) owned by lib/child-session.ts; child-session never calls
// back into this file. View mode's BTW_KEY swaps in the child's btw side chat
// (lib/btw-chat.ts) as a third mode. Which child F2 shows next: lib/child-watch-cursor.ts.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { liveChildren } from "./child-session.ts";
import type { ChildRecord } from "./child-types.ts";
import { nextChild, prevChild, setWatchCursor, watchCursorIndex } from "./child-watch-cursor.ts";
import { enterAltScreenWatch, enterWatchMouse, fullScreenOverlay } from "./alt-screen.ts";
import { BtwChat } from "./btw-chat.ts";
import { childBtw, childBtwSource } from "./btw-child.ts";
import { CONTEXT_CAP_STATUS_KEY, resolveTriggers } from "./env.ts";
import { formatCapStatus } from "./format.ts";
import { renderFooterLines } from "./footer.ts";
import { gitBranch } from "./git-branch.ts";
import {
	BTW_KEY,
	EXPAND_KEY,
	movePickerSelection,
	pickerRow,
	sgrWheelDelta,
	WATCH_KEY,
	WatchViewport,
	watchHeaderLines,
	watchHintLine,
	watchPositionLabel,
} from "./watch-viewport.ts";

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

export async function openChildView(ctx: ExtensionContext, initial: ChildRecord): Promise<void> {
	return watchOverlay(ctx, initial);
}

/** Dashboard of all children; enter/digits drill into a child view, esc from there returns here. */
export async function openChildPicker(ctx: ExtensionContext): Promise<void> {
	return watchOverlay(ctx, undefined);
}

/**
 * The F2 overlay. One overlay, three modes: "picker" (row per child), "view" (one
 * child's transcript) and "btw" (that child's side chat, BtwChat; esc → view). Mode
 * switching inside a single ui.custom keeps esc-from-view returning to a still-live
 * picker without re-opening the overlay. One instance per open overlay: `mode`,
 * `selected` and `record` are the state the modes share.
 */
class WatchOverlay {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly fromPicker: boolean;
	private mode: "picker" | "view" | "btw";
	/** The open side chat; set exactly while mode is "btw". */
	private btw: BtwChat | undefined;
	private focusState = false;
	private readonly registry: ExtensionContext["modelRegistry"];
	/** Picker row; kept while in view mode so esc returns to the child's row. */
	private selected: number;
	// Swappable: WATCH_KEY/←/→ inside the view cycle children without closing
	// and reopening the overlay. Undefined only while in picker mode.
	private record: ChildRecord | undefined;
	private readonly childFooter: (width: number, current: ChildRecord) => string[];
	private readonly altScreen: { exit(): void } | null;
	private readonly mouse: { exit(): void } | null;
	private readonly ticker: NodeJS.Timeout;
	private readonly scroll = new WatchViewport();

	constructor(ctx: ExtensionContext, initial: ChildRecord | undefined, tui: TUI, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.registry = ctx.modelRegistry;
		this.fromPicker = initial === undefined;
		this.mode = this.fromPicker ? "picker" : "view";
		// Open the picker on the last-watched child, not row 0 (fresh cursor → first row).
		this.selected = Math.max(0, watchCursorIndex());
		this.record = initial;
		this.record?.view.setRenderer(() => tui.requestRender());
		// Resolved once per view open: childFooterData runs in render() on every frame,
		// and gitBranch does sync fs calls per ancestor dir. Branch changes mid-view are rare
		// and the view is reopened often, so a per-open snapshot is fine.
		const branch = gitBranch(ctx.cwd);
		this.childFooter = (width, current) =>
			renderFooterLines(width, theme as never, childFooterData(ctx, current, branch));
		// Wheel reports for scrolling; null on fullscreen pi, which already has them.
		this.mouse = enterWatchMouse(tui);
		// Alt screen for the whole picker/view lifetime; null on fullscreen pi.
		this.altScreen = enterAltScreenWatch(tui);
		// Picker rows must track running children (turn count, current tool) even
		// when no view renderer is attached; a coarse tick beats subscribing to
		// every child session just for a redraw.
		this.ticker = setInterval(() => tui.requestRender(), 1000);
	}

	dispose() {
		clearInterval(this.ticker);
		// Before the mouse reset so the terminal leaves the alt screen first; both
		// run before pi's next render (dispose is synchronous in the close path,
		// renders are scheduled), so the renderer never draws between them.
		this.altScreen?.exit();
		this.mouse?.exit();
		this.record?.view.setRenderer(() => {});
		this.btw?.dispose();
	}

	invalidate() {}

	get focused(): boolean {
		return this.focusState;
	}

	/** Focusable: forwarded to the btw chat's editor (hardware cursor). */
	set focused(value: boolean) {
		this.focusState = value;
		if (this.btw) this.btw.focused = value;
	}

	render(width: number): string[] {
		if (this.mode === "btw") return this.btw!.render(width);
		return this.mode === "picker" ? this.renderPicker(width) : this.renderView(width);
	}

	handleInput(data: string) {
		if (this.mode === "btw") this.btw!.handleInput(data);
		else if (this.mode === "picker") this.handlePickerInput(data);
		else this.handleViewInput(data);
	}

	// ── both modes ──

	private switchTo(next: ChildRecord) {
		if (next === this.record) return;
		this.record?.view.setRenderer(() => {});
		this.record = next;
		this.record.view.setRenderer(() => this.tui.requestRender());
		this.scroll.end(); // fresh child: jump to the tail and follow it
		this.tui.requestRender();
	}

	private enterView(target: ChildRecord) {
		// Keep the outer F2 shortcut cycling from wherever the picker jumped to.
		setWatchCursor(target.id);
		this.mode = "view";
		this.switchTo(target);
		this.tui.requestRender();
	}

	private leaveView() {
		// Esc from a picker-opened view goes back to the picker — unless eviction
		// shrank the list to ≤1 child, where a picker would be pointless.
		if (!this.fromPicker || liveChildren.size <= 1) {
			this.done();
			return;
		}
		const idx = [...liveChildren.values()].indexOf(this.record!);
		if (idx >= 0) this.selected = idx;
		this.record?.view.setRenderer(() => {});
		this.record = undefined;
		this.mode = "picker";
		this.tui.requestRender();
	}

	// ── picker mode ──

	private renderPicker(width: number): string[] {
		const all = [...liveChildren.values()];
		if (all.length === 0) return ["No agent sessions.", "", "esc close"];
		this.selected = Math.min(this.selected, all.length - 1); // eviction clamp
		const rows = all.map((r, i) =>
			i === this.selected
				? this.theme.fg("accent", truncateToWidth(`> ${pickerRow(r)}`, width))
				: truncateToWidth(`  ${pickerRow(r)}`, width),
		);
		const hint = "↑↓ select · enter open · 1-9 jump · esc close";
		return [`Agent sessions (${all.length})`, "", ...rows, "", hint].slice(0, this.tui.terminal.rows);
	}

	private movePicker(delta: number) {
		this.selected = movePickerSelection(this.selected, delta, liveChildren.size);
		this.tui.requestRender();
	}

	private openSelected() {
		const all = [...liveChildren.values()];
		const target = all[Math.min(this.selected, all.length - 1)];
		if (target) this.enterView(target);
	}

	private readonly pickerKeys: KeyTable = [
		["escape", () => this.done()],
		["up", () => this.movePicker(-1)],
		["down", () => this.movePicker(1)],
		// WATCH_KEY too: tapping F2 repeatedly still walks through the children.
		[WATCH_KEY, () => this.movePicker(1)],
		["enter", () => this.openSelected()],
	];

	private handlePickerInput(data: string) {
		if (dispatchKey(data, this.pickerKeys)) return;
		// 1-9: jump straight into that row's child.
		if (data.length === 1 && data >= "1" && data <= "9") {
			const target = [...liveChildren.values()][Number(data) - 1];
			if (target) this.enterView(target);
		}
	}

	// ── view mode ──

	private renderView(width: number): string[] {
		const current = this.record!;
		const pos = watchPositionLabel([...liveChildren.values()], current);
		const footerLines = this.childFooter(width, current);
		// Two header lines + blank + hint around the body.
		const viewportRows = Math.max(1, this.tui.terminal.rows - 4 - footerLines.length);
		const body = current.view.render(width);
		this.scroll.layout(body.length, viewportRows);
		// After the offset settles: line 2's `context k/N+1` depends on the viewport.
		const k = this.scroll.contextIndex(current.view.handoffAnchors, body.length);
		const [header, header2] = watchHeaderLines(current, pos, k);
		const hint = watchHintLine(this.scroll.follow, current.view.handoffCount, pos);
		return [
			truncateToWidth(header, width),
			truncateToWidth(header2, width),
			...this.scroll.window(body),
			"",
			truncateToWidth(hint, width),
			...footerLines,
		].slice(0, this.tui.terminal.rows);
	}

	private scrollBy(delta: number) {
		this.scroll.scrollBy(delta);
		this.tui.requestRender();
	}

	private scrollHome() {
		this.scroll.home();
		this.tui.requestRender();
	}

	private scrollEnd() {
		this.scroll.end();
		this.tui.requestRender();
	}

	private jumpHandoff(dir: -1 | 1) {
		if (this.scroll.jumpHandoff(this.record!.view.handoffAnchors, dir)) this.tui.requestRender();
	}

	private showPrevChild() {
		const prev = prevChild(this.record!.id);
		if (prev) this.switchTo(prev);
	}

	private showNextChild() {
		const next = nextChild(this.record!.id);
		if (next) this.switchTo(next);
	}

	// Order matters: escape first; shift+↑/↓ before plain ↑/↓; the configurable
	// EXPAND_KEY and WATCH_KEY after the fixed keys (see KeyTable), so a configured
	// key that collides with a fixed one keeps the fixed key's action.
	private readonly viewKeys: KeyTable = [
		["escape", () => this.leaveView()],
		["shift+up", () => this.jumpHandoff(-1)],
		["shift+down", () => this.jumpHandoff(1)],
		["up", () => this.scrollBy(-1)],
		["down", () => this.scrollBy(1)],
		["pageUp", () => this.scrollBy(-(this.scroll.viewport - 1))],
		["pageDown", () => this.scrollBy(this.scroll.viewport - 1)],
		["home", () => this.scrollHome()],
		["end", () => this.scrollEnd()],
		[EXPAND_KEY, () => this.record!.view.toggleExpanded()],
		["left", () => this.showPrevChild()],
		["right", () => this.showNextChild()],
		[WATCH_KEY, () => this.showNextChild()],
		[BTW_KEY, () => this.openBtw()],
	];

	// ── btw mode ──

	private openBtw() {
		const record = this.record!;
		const entry = childBtw(record.session);
		if (!entry) return;
		const source = childBtwSource(this.registry, record, entry.snapshot);
		// terminalModes false: this overlay already holds the alt screen + wheel reporting.
		const chat = new BtwChat(this.tui, this.theme, source, () => this.closeBtw(), {
			terminalModes: false,
		});
		chat.focused = this.focusState;
		this.btw = chat;
		this.mode = "btw";
		this.tui.requestRender();
	}

	private closeBtw() {
		this.btw?.dispose();
		this.btw = undefined;
		this.mode = "view";
		this.tui.requestRender();
	}

	private handleViewInput(data: string) {
		// Mouse reports first and always consumed: a click (non-wheel button) is
		// swallowed rather than parsed as keys.
		const wheel = sgrWheelDelta(data);
		if (wheel === undefined) dispatchKey(data, this.viewKeys);
		else if (wheel !== 0) this.scrollBy(wheel);
	}
}

async function watchOverlay(ctx: ExtensionContext, initial: ChildRecord | undefined): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WatchOverlay(ctx, initial, tui, theme, done), {
		overlay: true,
		overlayOptions: fullScreenOverlay,
	});
}
