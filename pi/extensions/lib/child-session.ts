// Shared plumbing for child-session tools (Agent, Explorer).
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
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { renderFooterLines } from "../custom-footer.ts";

export const AGENT_TOOL = "Agent";
export const EXPLORER_TOOL = "Explorer";
const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
const EXPAND_KEY = (process.env.PI_SUBAGENT_EXPAND_KEY ?? "ctrl+o") as KeyId;
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";
const SGR_MOUSE = /^\u001b\[<(\d+);\d+;\d+([Mm])$/;
const WHEEL_LINES = 3;
const SOFT_TRIGGER = Number(process.env.CONTEXT_CAP_SOFT ?? 160_000);

export { WATCH_KEY, EXPAND_KEY };

/** A model as handed out by ExtensionContext.modelRegistry. */
export type ChildModel = NonNullable<ExtensionContext["model"]>;

export interface ChildRecord {
	id: string;
	kind: string;
	session: AgentSession;
	view: ChildView;
	description: string;
	turns: number;
	elapsedMs: number;
	currentTool?: string;
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

export const liveChildren = new Map<string, ChildRecord>();
const childSessionFlag = new AsyncLocalStorage<true>();
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
): { text(): string; stop(): void } {
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
	const activity = record.currentTool ? `running ${record.currentTool}` : "thinking";
	return `${record.kind}#${record.id} · ${record.description} · turn ${record.turns + 1} · ${activity}`;
}

export interface ChildSessionOptions {
	/** Model for the child. Defaults to the parent's model. */
	model?: ChildModel;
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
			thinkingLevel: ctx.thinkingLevel,
			excludeTools: options.excludeTools,
			sessionManager,
			settingsManager,
			...(modelRuntime !== undefined && { modelRuntime }),
		} as Parameters<typeof createAgentSession>[0]),
	);
	await runInChildSession(() => session.bindExtensions({}));
	return session;
}

export function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }] as TextContent[], details };
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

function childFooterData(ctx: ExtensionContext, record: ChildRecord) {
	const session = record.session;
	const usage = session.getContextUsage();
	const tokens = usage?.tokens == null ? "?" : formatTokenCount(usage.tokens);
	return {
		cost: session.getSessionStats().cost,
		usingSubscription: session.model ? ctx.modelRegistry.isUsingOAuth(session.model) : false,
		cwd: ctx.cwd,
		branch: gitBranch(ctx.cwd),
		sessionName: session.sessionName,
		modelId: session.model?.id,
		reasoning: session.model?.reasoning === true,
		thinkingLevel: session.thinkingLevel,
		statuses: new Map([["context-cap", `${tokens}/${formatTokenCount(SOFT_TRIGGER)}`]]),
	};
}

export async function openChildView(ctx: ExtensionContext, record: ChildRecord): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			record.view.setRenderer(() => tui.requestRender());
			const childFooter = (width: number) =>
				renderFooterLines(width, theme as never, childFooterData(ctx, record));
			process.stdout.write(MOUSE_ON);
			let offset = 0;
			let follow = true;
			let viewport = 1;
			const scrollBy = (delta: number) => {
				follow = false;
				offset = Math.max(0, offset + delta);
				tui.requestRender();
			};
			return {
				dispose() {
					process.stdout.write(MOUSE_OFF);
					record.view.setRenderer(() => {});
				},
				invalidate() {},
				render(width: number): string[] {
					const header = record.running
						? `▶ ${statusLine(record)}`
						: `■ ${metaLine(collectMeta(record))} · ${record.description} · finished`;
					const hint = `esc back · wheel/↑↓/pgup/pgdn scroll · end follow · ${EXPAND_KEY} expand${
						follow ? "" : " · paused"
					}`;
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

export function watchTarget(): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	return all.find((r) => r.running) ?? all.at(-1);
}

export interface ChildToolParams {
	prompt: string;
	description?: string;
	resume_id?: string;
}

export interface RunChildOptions extends ChildSessionOptions {
	/** Shown in ids, status and meta lines: "agent" / "explorer". */
	kind: string;
	/** Prepended to every prompt sent to the child (role and output contract). */
	promptPrefix?: string;
}

/** Shared execute() body for child-session tools. */
export async function runChildTool(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
	ctx: ExtensionContext,
) {
	const resumeId = params.resume_id;
	let record: ChildRecord;
	if (resumeId) {
		const existing = liveChildren.get(resumeId);
		if (!existing || existing.kind !== options.kind) {
			return textResult(
				`No live ${options.kind} session with id "${resumeId}". It may have ended with the pi session. Start a fresh ${options.kind} with a self-contained prompt.`,
				{ error: "unknown_resume_id" },
			);
		}
		record = existing;
		if (params.description) record.description = params.description;
	} else {
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
	record.running = true;
	const prompt = options.promptPrefix ? `${options.promptPrefix}\n\n${params.prompt}` : params.prompt;
	record.view.addUserMessage(prompt);
	const watcher = watchChild(record, onUpdate);
	const onAbort = () => void record.session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	try {
		await record.session.prompt(prompt);
	} finally {
		record.elapsedMs += Date.now() - startedAt;
		watcher.stop();
		record.running = false;
		record.currentTool = undefined;
		signal?.removeEventListener("abort", onAbort);
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
	theme: { fg: (key: string, text: string) => string },
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
