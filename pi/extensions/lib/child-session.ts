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
import { cancelPendingWork } from "./pending-work.ts";
import { waitForSessionQuiet } from "./session-quiet.ts";
import { CONTEXT_CAP_SOFT_TRIGGER as SOFT_TRIGGER } from "./env.ts";

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
	session: AgentSession;
	view: ChildView;
	description: string;
	turns: number;
	elapsedMs: number;
	currentTool?: string;
	/** Reasons the child is between runs but not finished (timer, context handoff). */
	waitingFor?: string;
	running: boolean;
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
	childSessionFlag: AsyncLocalStorage<true>;
	/** F2 watch cursor: id of the last watched child, advanced per watchTarget() call. */
	watchCursor: string | undefined;
}
// Versioned key: whenever SharedState's shape changes, bump it. jiti re-imports this
// module on every session bind (moduleCache: false), so in a long-lived pi process an
// old code copy may still hold the previous shape under the previous symbol — old and
// new copies must never share a mis-shaped state object.
const STATE_KEY = Symbol.for("terminal-setup.child-session.v3");
const globals = globalThis as unknown as Record<symbol, SharedState | undefined>;
const state: SharedState = (globals[STATE_KEY] ??= {
	liveChildren: new Map(),
	busyGroups: new Map(),
	childSessionFlag: new AsyncLocalStorage<true>(),
	watchCursor: undefined,
});

/** Session teardown: drop child records and busy-latch counters (see subagent.ts). */
export function resetChildState(): void {
	state.liveChildren.clear();
	state.busyGroups.clear();
	state.watchCursor = undefined;
}

export const liveChildren = state.liveChildren;
const childSessionFlag = state.childSessionFlag;
export const inChildSession = () => childSessionFlag.getStore() === true;
const runInChildSession = <T>(fn: () => Promise<T>) => childSessionFlag.run(true, fn);

export class ChildView {
	private readonly container = new Container();
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private readonly tools: ToolExecutionComponent[] = [];
	private streaming: AssistantMessageComponent | undefined;
	private expanded = false;
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
		this.container.addChild(new Spacer(1));
		this.container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
		this.requestRender();
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
				record.turns++;
				record.currentTool = undefined;
				pushStatus();
				break;
			case "tool_execution_start":
				record.currentTool = event.toolName;
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
			if (block?.type === "toolCall" && block.name === "context_handoff") resets++;
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
	options: ChildSessionOptions,
): Promise<AgentSession> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
	const { session } = await runInChildSession(() =>
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
	await runInChildSession(() => session.bindExtensions({}));
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
	return {
		cost: session.getSessionStats().cost,
		usingSubscription: session.model ? ctx.modelRegistry.isUsingOAuth(session.model) : false,
		cwd: ctx.cwd,
		branch,
		sessionName: session.sessionName,
		modelId: session.model?.id,
		reasoning: session.model?.reasoning === true,
		thinkingLevel: session.thinkingLevel,
		statuses: new Map([["context-cap", `${tokens}/${formatTokenCount(SOFT_TRIGGER)}`]]),
	};
}

export async function openChildView(ctx: ExtensionContext, initial: ChildRecord): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			// Swappable: WATCH_KEY inside the view cycles to the next child without
			// closing and reopening the overlay.
			let record = initial;
			record.view.setRenderer(() => tui.requestRender());
			// Resolved once per view open: childFooterData runs in render() on every frame,
			// and gitBranch does up to 2 sync file reads. Branch changes mid-view are rare
			// and the view is reopened often, so a per-open snapshot is fine.
			const branch = gitBranch(ctx.cwd);
			const childFooter = (width: number) =>
				renderFooterLines(width, theme as never, childFooterData(ctx, record, branch));
			process.stdout.write(MOUSE_ON);
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
				record.view.setRenderer(() => {});
				record = next;
				record.view.setRenderer(() => tui.requestRender());
				follow = true; // fresh child: jump to the tail and follow it
				tui.requestRender();
			};
			return {
				dispose() {
					process.stdout.write(MOUSE_OFF);
					record.view.setRenderer(() => {});
				},
				invalidate() {},
				render(width: number): string[] {
					const all = [...liveChildren.values()];
					const idx = all.indexOf(record);
					const pos = all.length > 1 && idx >= 0 ? ` (${idx + 1}/${all.length})` : "";
					const header = record.running
						? `▶ ${statusLine(record)}${pos}`
						: `■ ${metaLine(collectMeta(record))} · ${record.description} · finished${pos}`;
					const hint = `esc back · wheel/↑↓/pgup/pgdn scroll · end follow · ${EXPAND_KEY} expand${
						pos ? ` · ${WATCH_KEY} next agent${pos}` : ""
					}${follow ? "" : " · paused"}`;
					const footerLines = childFooter(width);
					viewport = Math.max(1, tui.terminal.rows - 3 - footerLines.length);
					const body = record.view.render(width);
					const maxOffset = Math.max(0, body.length - viewport);
					if (follow) offset = maxOffset;
					else if (offset >= maxOffset) {
						offset = maxOffset;
						follow = true;
					}
					const window = body.slice(offset, offset + viewport);
					while (window.length < viewport) window.push("");
					return [header, ...window, "", hint, ...footerLines].slice(0, tui.terminal.rows);
				},
				handleInput(data: string) {
					const mouse = SGR_MOUSE.exec(data);
					if (mouse) {
						const button = Number(mouse[1]);
						if (button === 64) scrollBy(-WHEEL_LINES);
						else if (button === 65) scrollBy(WHEEL_LINES);
						return;
					}
					if (matchesKey(data, "escape")) done();
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
					} else if (matchesKey(data, EXPAND_KEY)) record.view.toggleExpanded();
					else if (matchesKey(data, WATCH_KEY)) {
						const next = nextChild(record.id);
						if (next) switchTo(next);
					}
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
	/** Prepended to a fresh child's first prompt (role and output contract), not to resumes. */
	promptPrefix?: string;
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
 * `session.prompt()` resolves when the model stops calling tools — but `timer`
 * restarts the session from the outside via the wake-up message. Extensions
 * announce such restarts as pending-work claims (lib/pending-work.ts); the child
 * is done only when it is idle with an empty queue and no claim left
 * (lib/session-quiet.ts). Claims are self-expiring, so a lost wake-up delays the
 * result instead of hanging it.
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
		record = {
			id,
			kind: options.kind,
			session,
			view: new ChildView(session, ctx.cwd),
			description: params.description ?? labelFromPrompt(params.prompt),
			turns: 0,
			elapsedMs: 0,
			running: false,
		};
		liveChildren.set(id, record);
	}
	onSession(record.session);
	record.running = true;
	// Resumes keep the contract from the first turn; re-sending it would just burn tokens.
	const prompt =
		options.promptPrefix && !resumeId
			? `${options.promptPrefix}\n\n${params.prompt}`
			: params.prompt;
	// The watch view shows only the task, not the boilerplate contract prefix.
	record.view.addUserMessage(params.prompt);
	const watcher = watchChild(record, onUpdate);
	const onAbort = () => void record.session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	try {
		await record.session.prompt(prompt);
		await waitForChildDone(record, signal, watcher.pushStatus);
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
	}
	const text = watcher.text();
	return textResult(
		`${text || `(${options.kind} produced no text output)`}\n\n---\n${options.kind} id: ${record.id} (pass as resume_id to continue this session)`,
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
