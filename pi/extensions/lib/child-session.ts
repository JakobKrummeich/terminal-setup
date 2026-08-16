// Shared plumbing for child-session tools (Agent, Explore).
//
// Not an extension: pi's loader only scans top-level *.ts in the extensions dir
// (core/package-manager.js collectAutoExtensionEntries), so files under lib/ are
// never loaded as extensions and need no default export.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AssistantMessageComponent,
	createAgentSession,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { renderFooterLines } from "../custom-footer.ts";
import { appendEvent, type RunStatus } from "./agent-runs.ts";
import { cancelPendingWork } from "./pending-work.ts";
import { waitForSessionQuiet } from "./session-quiet.ts";
import {
	CONTEXT_CAP_STATUS_KEY,
	CONTEXT_CAP_TOOL_NAME,
	resolveTriggers,
} from "./env.ts";

export const AGENT_TOOL = "Agent";
export const EXPLORE_TOOL = "Explore";
const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
const EXPAND_KEY = (process.env.PI_SUBAGENT_EXPAND_KEY ?? "ctrl+o") as KeyId;
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";
const SGR_MOUSE = /^\u001b\[<(\d+);\d+;\d+([Mm])$/;
const WHEEL_LINES = 3;

export { WATCH_KEY, EXPAND_KEY };

/** A model as handed out by ExtensionContext.modelRegistry. */
export type ChildModel = NonNullable<ExtensionContext["model"]>;

/** Thinking level as the session runtime knows it (re-derived: the canonical type lives in pi-agent-core). */
export type ChildThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export interface ChildRecord {
	id: string;
	kind: string;
	/** The child's session uuid (sessionManager.getSessionId()) — `sid` in agent-runs.jsonl. */
	sid: string;
	/**
	 * The main session's sid for this spawn tree — `root` in agent-runs.jsonl.
	 * A child spawned by another child inherits the spawner's rootSid; falls back
	 * to the child's own sid when the spawner is unknown (bare test contexts).
	 */
	rootSid: string;
	session: AgentSession;
	view: ChildView;
	description: string;
	turns: number;
	elapsedMs: number;
	currentTool?: string;
	/** Reasons the child is between runs but not finished (timer, context handoff). */
	waitingFor?: string;
	running: boolean;
	/** Epoch ms of the last agent-runs.jsonl progress row (write throttle). */
	lastProgressAt?: number;
}

export interface RunMeta {
	id: string;
	kind: string;
	turns: number;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	resets: number;
	costUsd: number;
	durationMs: number;
}

/** Counting semaphore for one group of children (see busyGroup() below). */
interface BusyGroup {
	/** Children currently holding a slot (running or still winding down). */
	active: number;
	/** Max concurrent children; refreshed on every runChildTool call. */
	limit: number;
	/** Sessions still winding down after their tool call returned; each keeps its slot. */
	settling: Set<AgentSession>;
}

// State lives on globalThis, NOT in module scope: pi's extension loader creates a
// fresh jiti instance with `moduleCache: false` per extension file, so subagent.ts
// and explore.ts each import their own *copy* of this module (same reasoning as
// lib/pending-work.ts). Module-level state would split into per-copy islands:
// explorers would be invisible to the F2 watch (registered via subagent.ts's copy),
// session_shutdown would clear only agent children, and inChildSession() would be
// false inside an explorer child.
interface SharedState {
	/**
	 * All children of this pi session: running/settling entries plus at most
	 * MAX_FINISHED_CHILDREN finished ones. Older finished children are evicted
	 * when a fresh child spawns (memory cap: each record holds a full AgentSession
	 * plus a rendered ChildView) and can no longer be resumed — callers then get
	 * the "No live … session" error.
	 */
	liveChildren: Map<string, ChildRecord>;
	busyGroups: Map<string, BusyGroup>;
	childSessionStore: AsyncLocalStorage<ChildSessionInfo>;
	/** F2 watch cursor: id of the last watched child, advanced per watchTarget() call. */
	watchCursor: string | undefined;
}
// Versioned key: whenever SharedState's shape changes, bump it. jiti re-imports this
// module on every session bind (moduleCache: false), so in a long-lived pi process an
// old code copy may still hold the previous shape under the previous symbol — old and
// new copies must never share a mis-shaped state object.
const STATE_KEY = Symbol.for("terminal-setup.child-session.v5");
const globals = globalThis as unknown as Record<symbol, SharedState | undefined>;
const state: SharedState = (globals[STATE_KEY] ??= {
	liveChildren: new Map(),
	busyGroups: new Map(),
	childSessionStore: new AsyncLocalStorage<ChildSessionInfo>(),
	watchCursor: undefined,
});

/** Session teardown: drop child records and busy-latch counters (see subagent.ts). */
export function resetChildState(): void {
	state.liveChildren.clear();
	state.busyGroups.clear();
	state.watchCursor = undefined;
}

export const liveChildren = state.liveChildren;
const childSessionStore = state.childSessionStore;

/** What a child session is, seen from inside its own extension loading/binding. */
export interface ChildSessionInfo {
	/** RunChildOptions.kind, e.g. "agent" or "explorer". */
	kind: string;
	/** RunChildOptions.contract — undefined when the child gets no delegate contract. */
	contract: string | undefined;
}

export const inChildSession = () => childSessionStore.getStore() !== undefined;
/**
 * The ChildSessionInfo of the child currently being created, or undefined outside
 * a child. Only meaningful while createChildSession's ALS scope is active — i.e.
 * during extension load/bind of the child — so extensions must capture what they
 * need at bind time (the store is gone when later events fire).
 */
export const childSessionInfo = (): ChildSessionInfo | undefined => childSessionStore.getStore();
const runInChildSession = <T>(info: ChildSessionInfo, fn: () => Promise<T>) =>
	childSessionStore.run(info, fn);

/** Text of a session message's content — string (custom messages) or text blocks. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

export class ChildView {
	private readonly container = new Container();
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private readonly tools: ToolExecutionComponent[] = [];
	private streaming: AssistantMessageComponent | undefined;
	private expanded = false;
	/** Prompts shown eagerly via addUserMessage; their message_start event is skipped (no double render). */
	private pendingManualPrompts = 0;
	private requestRender: () => void = () => {};
	private readonly ui: TUI;
	constructor(
		private readonly session: AgentSession,
		private readonly cwd: string,
	) {
		this.ui = { requestRender: () => this.requestRender() } as unknown as TUI;
	}
	setRenderer(fn: () => void) {
		this.requestRender = fn;
	}
	toggleExpanded() {
		this.expanded = !this.expanded;
		for (const tool of this.tools) tool.setExpanded(this.expanded);
		this.requestRender();
	}
	render(width: number): string[] {
		return this.container.render(width);
	}
	addUserMessage(text: string) {
		this.pendingManualPrompts++;
		this.container.addChild(new Spacer(1));
		this.container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
		this.requestRender();
	}
	/**
	 * Injected mid-run messages — context-cap steers/reminders (role "user") and
	 * swap markers (role "custom", e.g. customType "context-cap-swap") — otherwise
	 * the F2 view shows a handoff tool call with no visible cause and no visible
	 * post-swap injection. The child's own prompt() delivery re-emits the prompt
	 * already shown by addUserMessage; pendingManualPrompts swallows exactly those.
	 */
	private addInjectedMessage(message: { role: string; content?: unknown; display?: boolean }) {
		if (message.role === "user" && this.pendingManualPrompts > 0) {
			this.pendingManualPrompts--;
			return;
		}
		if (message.role === "custom" && message.display === false) return;
		const text = messageText(message.content);
		if (!text.trim()) return;
		this.container.addChild(new Spacer(1));
		this.container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
	}
	private syncToolCalls(message: AssistantMessage) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
			if (block?.type !== "toolCall" || !block.id) continue;
			const existing = this.pendingTools.get(block.id);
			if (existing) {
				existing.updateArgs(block.arguments);
				continue;
			}
			const name = block.name ?? "tool";
			const component = new ToolExecutionComponent(
				name,
				block.id,
				block.arguments,
				{ showImages: false },
				this.session.getToolDefinition(name),
				this.ui,
				this.cwd,
			);
			component.setExpanded(this.expanded);
			this.pendingTools.set(block.id, component);
			this.tools.push(component);
			this.container.addChild(component);
		}
	}
	handle(event: AgentSessionEvent) {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "user" || event.message.role === "custom") {
					this.addInjectedMessage(event.message as { role: string; content?: unknown; display?: boolean });
					break;
				}
				if (event.message.role !== "assistant") break;
				this.streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
				this.container.addChild(this.streaming);
				this.streaming.updateContent(event.message as AssistantMessage);
				break;
			}
			case "message_update":
			case "message_end": {
				if (event.message.role !== "assistant") break;
				const message = event.message as AssistantMessage;
				this.streaming?.updateContent(message);
				this.syncToolCalls(message);
				if (event.type === "message_end") {
					for (const tool of this.pendingTools.values()) tool.setArgsComplete();
					this.streaming = undefined;
				}
				break;
			}
			case "tool_execution_start":
				this.pendingTools.get(event.toolCallId)?.markExecutionStarted();
				break;
			case "tool_execution_update":
				this.pendingTools
					.get(event.toolCallId)
					?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			case "tool_execution_end":
				this.pendingTools
					.get(event.toolCallId)
					?.updateResult({ ...event.result, isError: event.isError });
				this.pendingTools.delete(event.toolCallId);
				break;
		}
		this.requestRender();
	}
}

function watchChild(
	record: ChildRecord,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
): { text(): string; pushStatus(): void; stop(): void } {
	const parts: string[] = [];
	const pushStatus = () => onUpdate?.(textResult(statusLine(record), { id: record.id }));
	const unsub = record.session.subscribe((event: AgentSessionEvent) => {
		record.view.handle(event);
		switch (event.type) {
			case "turn_end":
				record.currentTool = undefined;
				// Before turns++: the progress row's `turn` is the turn that just ended.
				writeProgressEvent(record);
				record.turns++;
				pushStatus();
				break;
			case "tool_execution_start":
				record.currentTool = event.toolName;
				writeProgressEvent(record);
				pushStatus();
				break;
			case "tool_execution_end":
				record.currentTool = undefined;
				pushStatus();
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const content = (event.message as { content?: unknown }).content;
					if (Array.isArray(content)) {
						for (const block of content as Array<{ type?: string; text?: string }>) {
							if (block?.type === "text" && block.text?.trim()) parts.push(block.text);
						}
					}
				}
				break;
		}
	});
	pushStatus();
	return {
		pushStatus,
		text: () => {
			for (let i = parts.length - 1; i >= 0; i--) {
				const part = parts[i]?.trim();
				if (part) return part;
			}
			return "";
		},
		stop: unsub,
	};
}

export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}k`;
	return String(count);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function countResets(session: AgentSession): number {
	let resets = 0;
	for (const entry of session.sessionManager.getEntries() as Array<{ type?: string }>) {
		if (entry?.type === "compaction") resets++;
	}
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string }>) {
			if (block?.type === "toolCall" && block.name === CONTEXT_CAP_TOOL_NAME) resets++;
		}
	}
	return resets;
}

export function collectMeta(record: ChildRecord): RunMeta {
	const stats = record.session.getSessionStats();
	const usage = record.session.getContextUsage();
	return {
		id: record.id,
		kind: record.kind,
		turns: record.turns,
		contextTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? 0,
		contextPercent: usage?.percent ?? null,
		resets: countResets(record.session),
		costUsd: stats.cost,
		durationMs: record.elapsedMs,
	};
}

// --- agent-runs.jsonl writers (dashboard data layer — docs/agent-dashboard-spec.md).
// The index lives in the same dir as the session files; appendEvent no-ops for
// in-memory sessions (dir ""), which keeps harness-based tests off the disk.

/** Coarse heartbeat rate: at most one progress row per child per this interval. */
const PROGRESS_THROTTLE_MS = 2_000;

/** Written once per child, right after its record is registered. */
function writeSpawnEvent(record: ChildRecord, parentSid: string): void {
	const manager = record.session.sessionManager;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) return; // in-memory child: no transcript to index
	appendEvent(manager.getSessionDir(), {
		ts: Date.now(),
		event: "spawn",
		sid: record.sid,
		root: record.rootSid,
		parentSid,
		kind: record.kind,
		label: `${record.kind}#${record.id}`,
		sessionFile,
		description: record.description,
	});
}

/** Heartbeat on turn end / tool change — throttled, so the disk suffices for a live view. */
function writeProgressEvent(record: ChildRecord): void {
	const now = Date.now();
	if (now - (record.lastProgressAt ?? 0) < PROGRESS_THROTTLE_MS) return;
	record.lastProgressAt = now;
	appendEvent(record.session.sessionManager.getSessionDir(), {
		ts: now,
		event: "progress",
		sid: record.sid,
		turn: record.turns + 1,
		...(record.currentTool !== undefined && { tool: record.currentTool }),
	});
}

/** Written every time a run settles; numbers are cumulative (last row per sid wins). */
function writeFinishEvent(record: ChildRecord, status: RunStatus): void {
	const meta = collectMeta(record);
	appendEvent(record.session.sessionManager.getSessionDir(), {
		ts: Date.now(),
		event: "finish",
		sid: record.sid,
		status,
		turns: meta.turns,
		costUsd: meta.costUsd,
		contextTokens: meta.contextTokens,
		contextPercent: meta.contextPercent,
		resets: meta.resets,
		durationMs: meta.durationMs,
	});
}

/**
 * Root sid for a child about to be spawned by `spawnerSid`: when the spawner is
 * itself a live child (agent spawning explorers — its record is in the shared
 * liveChildren map), the tree root is the spawner's own root; otherwise the
 * spawner IS the main session and thus the root.
 */
function rootSidFor(spawnerSid: string): string {
	for (const record of liveChildren.values()) {
		if (record.sid === spawnerSid) return record.rootSid;
	}
	return spawnerSid;
}

export function metaLine(meta: RunMeta): string {
	const context =
		meta.contextTokens === null
			? "ctx ?"
			: `ctx ${formatTokenCount(meta.contextTokens)}/${formatTokenCount(meta.contextWindow)}${
					meta.contextPercent === null ? "" : ` (${Math.round(meta.contextPercent)}%)`
				}`;
	return [
		`${meta.kind}#${meta.id}`,
		`${meta.turns} turns`,
		context,
		`${meta.resets} resets`,
		`$${meta.costUsd.toFixed(3)}`,
		formatDuration(meta.durationMs),
	].join(" \u00b7 ");
}

function labelFromPrompt(prompt: string): string {
	const firstLine = prompt.split("\n").find((line) => line.trim()) ?? "agent task";
	const words = firstLine.trim().split(/\s+/).slice(0, 5).join(" ");
	return words.length > 48 ? `${words.slice(0, 47)}\u2026` : words;
}

function statusLine(record: ChildRecord): string {
	const activity = record.waitingFor
		? `waiting for ${record.waitingFor}`
		: record.currentTool
			? `running ${record.currentTool}`
			: "thinking";
	return `${record.kind}#${record.id} · ${record.description} · turn ${record.turns + 1} · ${activity}`;
}

export interface ChildSessionOptions {
	/** Model for the child. Defaults to the parent's model. */
	model?: ChildModel;
	/** Thinking level for the child. Defaults to the parent's level. */
	thinkingLevel?: ChildThinkingLevel;
	/** Allowlist of tool names — only these are enabled. Omit for the full default set. */
	tools?: string[];
	/** Tools the child must not have. */
	excludeTools: string[];
}

async function createChildSession(
	ctx: ExtensionContext,
	options: RunChildOptions,
): Promise<AgentSession> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
	// The ALS payload lets extensions loading inside the child know they are in a
	// child and which contract it carries (subagent.ts appends it to the system
	// prompt via before_agent_start — see the comment there).
	const info: ChildSessionInfo = { kind: options.kind, contract: options.contract };
	const { session, extensionsResult } = await runInChildSession(info, () =>
		createAgentSession({
			cwd,
			agentDir,
			model: options.model ?? ctx.model,
			thinkingLevel: options.thinkingLevel ?? ctx.thinkingLevel,
			...(options.tools && { tools: options.tools }),
			excludeTools: options.excludeTools,
			sessionManager,
			settingsManager,
			...(modelRuntime !== undefined && { modelRuntime }),
		} as Parameters<typeof createAgentSession>[0]),
	);
	// Extension load errors must not stay silent: a child missing e.g. context-cap
	// or the contract injection (subagent.ts) runs with different semantics than the
	// parent and nobody would know. The child still runs — same policy as pi's own
	// startup, which reports load errors and continues.
	for (const { path: extPath, error } of extensionsResult?.errors ?? []) {
		ctx.ui.notify(`${options.kind} child: extension failed to load: ${extPath}: ${error}`, "warning");
	}
	await runInChildSession(info, () => session.bindExtensions({}));
	return session;
}

export function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text }] as TextContent[],
		details,
		...(isError && { isError: true }),
	};
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
	const tokens = usage?.tokens == null ? "?" : formatTokenCount(usage.tokens);
	// The child has its own model, so resolve ITS soft cap rather than showing the
	// static ceiling — a small-window child swaps far below 260k (see lib/env.ts).
	const caps = resolveTriggers(usage?.contextWindow);
	const soft = caps.disabled || !Number.isFinite(caps.soft) ? "off" : formatTokenCount(caps.soft);
	return {
		cost: session.getSessionStats().cost,
		usingSubscription: session.model ? ctx.modelRegistry.isUsingOAuth(session.model) : false,
		cwd: ctx.cwd,
		branch,
		sessionName: session.sessionName,
		modelId: session.model?.id,
		reasoning: session.model?.reasoning === true,
		thinkingLevel: session.thinkingLevel,
		statuses: new Map([[CONTEXT_CAP_STATUS_KEY, `${tokens}/${soft}`]]),
	};
}

/** One picker row (marker + live status / final meta). Selection styling is added by the caller. */
function pickerRow(record: ChildRecord): string {
	return record.running
		? `▶ ${statusLine(record)}`
		: `■ ${metaLine(collectMeta(record))} · ${record.description}`;
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
			// Picker rows must track running children (turn count, current tool) even
			// when no view renderer is attached; a coarse tick beats subscribing to
			// every child session just for a redraw.
			const ticker = setInterval(() => tui.requestRender(), 1000);
			let offset = 0;
			let follow = true;
			let viewport = 1;
			const scrollBy = (delta: number) => {
				follow = false;
				offset = Math.max(0, offset + delta);
				tui.requestRender();
			};
			const switchTo = (next: ChildRecord) => {
				if (next === record) return;
				record?.view.setRenderer(() => {});
				record = next;
				record.view.setRenderer(() => tui.requestRender());
				follow = true; // fresh child: jump to the tail and follow it
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
			const renderPicker = (): string[] => {
				const all = [...liveChildren.values()];
				if (all.length === 0) return ["No agent sessions.", "", "esc close"];
				selected = Math.min(selected, all.length - 1); // eviction clamp
				const rows = all.map((r, i) =>
					i === selected
						? (theme as Theme).fg("accent", `> ${pickerRow(r)}`)
						: `  ${pickerRow(r)}`,
				);
				const hint = "↑↓ select · enter open · 1-9 jump · esc close";
				return [`Agent sessions (${all.length})`, "", ...rows, "", hint].slice(0, tui.terminal.rows);
			};
			const renderView = (width: number): string[] => {
				const current = record!;
				const all = [...liveChildren.values()];
				const idx = all.indexOf(current);
				const pos = all.length > 1 && idx >= 0 ? ` (${idx + 1}/${all.length})` : "";
				const header = current.running
					? `▶ ${statusLine(current)}${pos}`
					: `■ ${metaLine(collectMeta(current))} · ${current.description} · finished${pos}`;
				const hint = `esc back · wheel/↑↓/pgup/pgdn scroll · end follow · ${EXPAND_KEY} expand${
					pos ? ` · ←/→ agents · ${WATCH_KEY} next${pos}` : ""
				}${follow ? "" : " · paused"}`;
				const footerLines = childFooter(width, current);
				viewport = Math.max(1, tui.terminal.rows - 3 - footerLines.length);
				const body = current.view.render(width);
				const maxOffset = Math.max(0, body.length - viewport);
				if (follow) offset = maxOffset;
				else if (offset >= maxOffset) {
					offset = maxOffset;
					follow = true;
				}
				const window = body.slice(offset, offset + viewport);
				while (window.length < viewport) window.push("");
				return [header, ...window, "", hint, ...footerLines].slice(0, tui.terminal.rows);
			};
			const handlePickerInput = (data: string) => {
				const all = [...liveChildren.values()];
				if (matchesKey(data, "escape")) done();
				else if (matchesKey(data, "up")) {
					selected = movePickerSelection(selected, -1, all.length);
					tui.requestRender();
				} else if (matchesKey(data, "down") || matchesKey(data, WATCH_KEY)) {
					// WATCH_KEY too: tapping F2 repeatedly still walks through the children.
					selected = movePickerSelection(selected, 1, all.length);
					tui.requestRender();
				} else if (matchesKey(data, "enter")) {
					const target = all[Math.min(selected, all.length - 1)];
					if (target) enterView(target);
				} else if (data.length === 1 && data >= "1" && data <= "9") {
					const target = all[Number(data) - 1];
					if (target) enterView(target);
				}
			};
			const handleViewInput = (data: string) => {
				const current = record!;
				const mouse = SGR_MOUSE.exec(data);
				if (mouse) {
					const button = Number(mouse[1]);
					if (button === 64) scrollBy(-WHEEL_LINES);
					else if (button === 65) scrollBy(WHEEL_LINES);
					return;
				}
				if (matchesKey(data, "escape")) leaveView();
				else if (matchesKey(data, "up")) scrollBy(-1);
				else if (matchesKey(data, "down")) scrollBy(1);
				else if (matchesKey(data, "pageUp")) scrollBy(-(viewport - 1));
				else if (matchesKey(data, "pageDown")) scrollBy(viewport - 1);
				else if (matchesKey(data, "home")) {
					follow = false;
					offset = 0;
					tui.requestRender();
				} else if (matchesKey(data, "end")) {
					follow = true;
					tui.requestRender();
				} else if (matchesKey(data, EXPAND_KEY)) current.view.toggleExpanded();
				else if (matchesKey(data, "left")) {
					const prev = prevChild(current.id);
					if (prev) switchTo(prev);
				} else if (matchesKey(data, "right") || matchesKey(data, WATCH_KEY)) {
					const next = nextChild(current.id);
					if (next) switchTo(next);
				}
			};
			return {
				dispose() {
					clearInterval(ticker);
					process.stdout.write(MOUSE_OFF);
					record?.view.setRenderer(() => {});
				},
				invalidate() {},
				render(width: number): string[] {
					return mode === "picker" ? renderPicker() : renderView(width);
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

/** Finished children kept for resume; oldest beyond this are evicted on spawn. */
const MAX_FINISHED_CHILDREN = 8;

/**
 * Evict the oldest finished children beyond MAX_FINISHED_CHILDREN. Running or
 * settling children (not idle yet) are never evicted. Map iteration order is
 * insertion order, so the first finished entries are the oldest.
 */
function evictFinishedChildren(): void {
	let finished = 0;
	for (const record of state.liveChildren.values()) {
		if (!record.running && record.session.isIdle) finished++;
	}
	for (const [id, record] of state.liveChildren) {
		if (finished <= MAX_FINISHED_CHILDREN) break;
		if (record.running || !record.session.isIdle) continue;
		state.liveChildren.delete(id);
		finished--;
		try {
			record.session.dispose();
		} catch {}
	}
}

export interface ChildToolParams {
	prompt: string;
	description?: string;
	resume_id?: string;
}

export interface RunChildOptions extends ChildSessionOptions {
	/** Shown in ids, status and meta lines, e.g. "agent". */
	kind: string;
	/** Semaphore group, e.g. "agent" or "explorer". At most `concurrency` children per group. */
	busyGroup: string;
	/** Max concurrent children in the group. Default 1 (strict serialization). */
	concurrency?: number;
	/** Full rejection text when the group is at its limit. Default: the serialized-calls message. */
	busyMessage?: string;
	/**
	 * Appended to the child's system prompt every turn (survives context-cap swaps);
	 * the delegate role and output contract. Injection happens in subagent.ts's
	 * before_agent_start handler — the prompt itself is never touched.
	 */
	contract?: string;
}

// Counting semaphore per busy group. Agents stay at limit 1: parallel agents would
// share one worktree (they overwrite each other's edits) and one terminal. Explorers
// are readonly, so their group allows N concurrent children (PI_EXPLORER_PARALLEL,
// resolved by explore.ts). The slot is taken synchronously before the first await, so
// two tool calls in the same assistant message cannot both slip past a full semaphore.
// Explorers get their own group also because a subagent's Explore call runs inside a
// still-running Agent tool call, and a single shared latch would reject it as busy.
function busyGroup(name: string): BusyGroup {
	let group = state.busyGroups.get(name);
	if (!group) {
		group = { active: 0, limit: 1, settling: new Set() };
		state.busyGroups.set(name, group);
	}
	return group;
}

/**
 * Wait until the child is really done, not merely between runs.
 *
 * `session.prompt()` resolves when the model stops calling tools — but an extension
 * may restart the session from the outside (the classic case: a `timer` wake-up
 * message). Extensions announce such restarts as pending-work claims
 * (lib/pending-work.ts); the child is done only when it is idle with an empty queue
 * and no claim left (lib/session-quiet.ts). Claims are self-expiring, so a lost
 * wake-up delays the result instead of hanging it.
 *
 * Note the child's own mode: `bindExtensions({})` below leaves pi's default "print",
 * so `timer` takes its blocking branch inside a child and claims nothing — its wait
 * simply keeps the child's run active. The claim path stays the contract for any
 * out-of-band restart (and for a top-level TUI session's timer).
 */
async function waitForChildDone(
	record: ChildRecord,
	signal: AbortSignal | undefined,
	pushStatus: () => void,
): Promise<void> {
	const sessionId = record.session.sessionManager.getSessionId();
	await waitForSessionQuiet(record.session, sessionId, signal, (reasons) => {
		record.waitingFor = reasons.length > 0 ? reasons.join(", ") : undefined;
		pushStatus();
	});
}

/**
 * Cap on how long a settling child may keep its semaphore slot. Same rationale
 * as pending-work claims being self-expiring: if waitForIdle() never resolves
 * (hung child), the slot would otherwise be stranded for the rest of the pi
 * session — at limit 1 (Agent group) the tool would be permanently busy.
 */
const SETTLE_TIMEOUT_MS = 60_000;

/** Shared execute() body for child-session tools. */
export async function runChildTool(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
	ctx: ExtensionContext,
) {
	const group = busyGroup(options.busyGroup);
	group.limit = Math.max(1, Math.floor(options.concurrency ?? 1));
	if (group.active >= group.limit) {
		return textResult(
			options.busyMessage ??
				`Another ${options.kind} is already running. ${options.kind} calls are serialized — wait for the running one's result, then call again.`,
			{ error: "child_busy" },
			true,
		);
	}
	group.active++;
	// This call's own child session, captured for the wind-down below. Local per call —
	// a shared slot on the group would cross-wire concurrent explorers.
	let childSession: AgentSession | undefined;
	try {
		return await runChildToolInSlot(params, options, signal, onUpdate, ctx, (session) => {
			childSession = session;
		});
	} finally {
		// Semaphore wind-down: if the child is still draining (abort in flight), its
		// slot stays occupied until it is actually idle — a new child must not overlap
		// it. Released in the background; the result returns now.
		const session = childSession;
		if (session && !session.isIdle) {
			group.settling.add(session);
			// Idempotent: fires from waitForIdle OR the self-expiry timeout, whichever
			// comes first — never both (the slot must be released exactly once).
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				clearTimeout(timeout);
				group.settling.delete(session);
				group.active--;
			};
			const timeout = setTimeout(release, SETTLE_TIMEOUT_MS);
			timeout.unref?.(); // must not keep the process alive
			session.waitForIdle().then(release, release);
		} else {
			group.active--;
		}
	}
}

async function runChildToolInSlot(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
	ctx: ExtensionContext,
	onSession: (session: AgentSession) => void,
) {
	const resumeId = params.resume_id;
	let record: ChildRecord;
	if (resumeId) {
		const existing = liveChildren.get(resumeId);
		if (!existing || existing.kind !== options.kind) {
			return textResult(
				`No live ${options.kind} session with id "${resumeId}". It may have ended with the pi session. Start a fresh ${options.kind} with a self-contained prompt.`,
				{ error: "unknown_resume_id" },
				true,
			);
		}
		record = existing;
		// With explorers running in parallel, two calls can pass the semaphore and
		// resume the same child at once — session.prompt() on a busy session throws,
		// and the loser's wind-down would mark the winner's record as not running and
		// cancel its pending work. Also covers a session still draining after an abort.
		if (record.running || !record.session.isIdle) {
			return textResult(
				`${options.kind} "${resumeId}" is still running. Wait for its result, then resume it.`,
				{ error: "child_running" },
				true,
			);
		}
		if (params.description) record.description = params.description;
	} else {
		evictFinishedChildren();
		const id = randomUUID().slice(0, 8);
		const session = await createChildSession(ctx, options);
		session.setSessionName(`${options.kind}#${id}`);
		// Spawner = the session whose tool call runs right now: the main session, or
		// an agent child when its own Explore call lands here (ctx is then the child's
		// ExtensionContext). Optional chain: unit tests pass bare fake contexts.
		const spawnerSid = ctx.sessionManager?.getSessionId();
		const sid = session.sessionManager.getSessionId();
		record = {
			id,
			kind: options.kind,
			sid,
			rootSid: spawnerSid ? rootSidFor(spawnerSid) : sid,
			session,
			view: new ChildView(session, ctx.cwd),
			description: params.description ?? labelFromPrompt(params.prompt),
			turns: 0,
			elapsedMs: 0,
			running: false,
		};
		liveChildren.set(id, record);
		if (spawnerSid) writeSpawnEvent(record, spawnerSid);
	}
	onSession(record.session);
	record.running = true;
	// The child gets the task verbatim: the delegate contract rides the system
	// prompt (options.contract, injected per turn by subagent.ts), not the prompt.
	record.view.addUserMessage(params.prompt);
	const watcher = watchChild(record, onUpdate);
	const onAbort = () => void record.session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	let failed = false;
	try {
		await record.session.prompt(params.prompt);
		await waitForChildDone(record, signal, watcher.pushStatus);
	} catch (error) {
		failed = true; // finish row must say "error", not "done"
		throw error;
	} finally {
		record.elapsedMs += Date.now() - startedAt;
		watcher.stop();
		record.running = false;
		record.currentTool = undefined;
		record.waitingFor = undefined;
		signal?.removeEventListener("abort", onAbort);
		// The tool call is over: nothing may keep working unsupervised in the shared
		// worktree. No-op on a clean finish (no claims left); on abort or claim
		// self-expiry this disarms the child's timer via the claim's cancel callback.
		cancelPendingWork(record.session.sessionManager.getSessionId());
		// After elapsedMs is final: the finish row carries this run's cumulative numbers.
		writeFinishEvent(record, signal?.aborted ? "cancelled" : failed ? "error" : "done");
	}
	const text = watcher.text();
	return textResult(
		`${text || `(${options.kind} produced no text output)`}\n\n---\n${options.kind} id: ${record.id} (pass as resume_id to continue)`,
		{ ...collectMeta(record), aborted: signal?.aborted === true },
	);
}

/** Shared renderResult() for child-session tools. */
export function renderChildResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
	theme: Pick<Theme, "fg">,
	context: { lastComponent?: unknown },
) {
	const text = (result.content ?? [])
		.filter((block: { type?: string }) => block?.type === "text")
		.map((block: { text?: string }) => block.text ?? "")
		.join("\n");
	const meta = result.details as RunMeta | undefined;
	const summary = meta?.kind ? theme.fg("toolTitle", metaLine(meta)) : "";
	const body = theme.fg("toolOutput", text);
	const component = (context.lastComponent as Text) ?? new Text("", 0, 0);
	component.setText([summary, body].filter(Boolean).join("\n"));
	return component;
}
