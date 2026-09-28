// F2 watch: the full-screen overlay over all child sessions — a picker (one row per
// child) and a per-child transcript view (ChildView, lib/child-view.ts) with the
// child's own footer, rendered on the terminal's alternate screen. Reads the child
// registry (liveChildren) owned by lib/child-session.ts; child-session never calls
// back into this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type ChildRecord, collectMeta, liveChildren, metaLine, statusLine } from "./child-session.ts";
import { enterAltScreenWatch } from "./alt-screen.ts";
import { CONTEXT_CAP_STATUS_KEY, resolveTriggers } from "./env.ts";
import { formatCapStatus } from "./format.ts";
import { renderFooterLines } from "./footer.ts";
import { sharedState } from "./shared-state.ts";
import {
	EXPAND_KEY,
	sgrWheelDelta,
	WATCH_KEY,
	WatchViewport,
	watchHeaderLines,
	watchHintLine,
	watchPositionLabel,
} from "./watch-viewport.ts";

const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";

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
		} catch {
			// .git is a directory (or missing), not a worktree pointer file: keep gitDir; the HEAD read decides.
		}
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
 * The F2 overlay. One overlay, two modes: "picker" (row per child) and "view" (one
 * child's transcript). Mode switching inside a single ui.custom keeps esc-from-view
 * returning to a still-live picker without re-opening the overlay. One instance per
 * open overlay: `mode`, `selected` and `record` are the state both modes share.
 */
class WatchOverlay {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly fromPicker: boolean;
	private mode: "picker" | "view";
	/** Picker row; kept while in view mode so esc returns to the child's row. */
	private selected: number;
	// Swappable: WATCH_KEY/←/→ inside the view cycle children without closing
	// and reopening the overlay. Undefined only while in picker mode.
	private record: ChildRecord | undefined;
	private readonly childFooter: (width: number, current: ChildRecord) => string[];
	private readonly altScreen: { exit(): void } | null;
	private readonly ticker: NodeJS.Timeout;
	private readonly scroll = new WatchViewport();

	constructor(ctx: ExtensionContext, initial: ChildRecord | undefined, tui: TUI, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.fromPicker = initial === undefined;
		this.mode = this.fromPicker ? "picker" : "view";
		// Open the picker on the last-watched child, not row 0 (fresh cursor → first row).
		this.selected = Math.max(
			0,
			[...liveChildren.values()].findIndex((r) => r.id === state.watchCursor),
		);
		this.record = initial;
		this.record?.view.setRenderer(() => tui.requestRender());
		// Resolved once per view open: childFooterData runs in render() on every frame,
		// and gitBranch does up to 2 sync file reads. Branch changes mid-view are rare
		// and the view is reopened often, so a per-open snapshot is fine.
		const branch = gitBranch(ctx.cwd);
		this.childFooter = (width, current) =>
			renderFooterLines(width, theme as never, childFooterData(ctx, current, branch));
		process.stdout.write(MOUSE_ON);
		// Alt screen for the whole picker/view lifetime; null on alt-screen pi.
		this.altScreen = enterAltScreenWatch(tui);
		// Picker rows must track running children (turn count, current tool) even
		// when no view renderer is attached; a coarse tick beats subscribing to
		// every child session just for a redraw.
		this.ticker = setInterval(() => tui.requestRender(), 1000);
	}

	dispose() {
		clearInterval(this.ticker);
		// Before MOUSE_OFF so the terminal leaves the alt screen first; both
		// run before pi's next render (dispose is synchronous in the close path,
		// renders are scheduled), so the renderer never draws between them.
		this.altScreen?.exit();
		process.stdout.write(MOUSE_OFF);
		this.record?.view.setRenderer(() => {});
	}

	invalidate() {}

	render(width: number): string[] {
		return this.mode === "picker" ? this.renderPicker(width) : this.renderView(width);
	}

	handleInput(data: string) {
		if (this.mode === "picker") this.handlePickerInput(data);
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
		state.watchCursor = target.id;
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
	];

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
		overlayOptions: () => ({
			anchor: "top-left",
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		}),
	});
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
	// `all` is non-empty (checked above), so every index taken modulo its length exists.
	const target = last >= 0 ? all[(last + 1) % all.length]! : (all.find((r) => r.running) ?? all.at(-1)!);
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
	// Non-empty (checked above) + modulo length: the index always exists.
	const target = all[(all.findIndex((r) => r.id === currentId) + 1) % all.length]!;
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
