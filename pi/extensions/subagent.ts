import { AsyncLocalStorage } from "node:async_hooks";
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
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, matchesKey, Spacer, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
const TOOL_NAME = "Agent";
const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
const EXPAND_KEY = (process.env.PI_SUBAGENT_EXPAND_KEY ?? "ctrl+o") as KeyId;
interface ChildRecord {
	id: string;
	session: AgentSession;
	view: ChildView;
	description: string;
	turns: number;
	currentTool?: string;
	running: boolean;
}
const liveChildren = new Map<string, ChildRecord>();
const childSessionFlag = new AsyncLocalStorage<true>();
const inChildSession = () => childSessionFlag.getStore() === true;
const runInChildSession = <T>(fn: () => Promise<T>) => childSessionFlag.run(true, fn);
const TOOL_DESCRIPTION = `Delegate a task to a fresh agent session that works autonomously and reports back.

The agent starts with no memory of this conversation, so the prompt must be self-contained.
It has the same tools, skills and project context you do, and runs in the same working directory.

Use this proactively, without being asked, for:
- Exploration: "where is X", "how does Y work", anything spanning several files.
- Implementation of a defined task, especially multi-file work or edit/test/fix loops.
- Verification and review of work that is already done.

Keep for yourself:
- Planning and spec work. Delegate the exploration that feeds a plan; write the plan yourself.
- Synthesis. Never delegate understanding — do not write "based on your findings, fix the bug".
  Digest the results and hand over concrete paths, lines and changes.
- Single known-file edits and targeted greps. Just do them.

The agent may come back with a clarifying question instead of a result. That is normal: answer
it yourself by calling this tool again with resume_id set to the id in the result, which
continues the same session with its context intact. You stand in for the user.`;
class ChildView {
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
	return { text: () => parts.join("\n\n").trim(), stop: unsub };
}
function statusLine(record: ChildRecord): string {
	const activity = record.currentTool ? `running ${record.currentTool}` : "thinking";
	return `agent#${record.id} · ${record.description} · turn ${record.turns + 1} · ${activity}`;
}
async function createChildSession(ctx: ExtensionContext): Promise<AgentSession> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
	const { session } = await runInChildSession(() =>
		createAgentSession({
			cwd,
			agentDir,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel,
			excludeTools: [TOOL_NAME],
			sessionManager,
			settingsManager,
			...(modelRuntime !== undefined && { modelRuntime }),
		} as Parameters<typeof createAgentSession>[0]),
	);
	await runInChildSession(() => session.bindExtensions({}));
	return session;
}
function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }] as TextContent[], details };
}
async function openChildView(ctx: ExtensionContext, record: ChildRecord): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			record.view.setRenderer(() => tui.requestRender());
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
					record.view.setRenderer(() => {});
				},
				invalidate() {},
				render(width: number): string[] {
					const header = record.running
						? `▶ ${statusLine(record)}`
						: `■ agent#${record.id} · ${record.description} · finished`;
					const footer = `esc back · ↑↓/pgup/pgdn scroll · end follow · ${EXPAND_KEY} expand${follow ? "" : " · paused"}`;
					viewport = Math.max(1, tui.terminal.rows - 2);
					const body = record.view.render(width);
					const maxOffset = Math.max(0, body.length - viewport);
					if (follow) offset = maxOffset;
					else if (offset >= maxOffset) {
						offset = maxOffset;
						follow = true;
					}
					const window = body.slice(offset, offset + viewport);
					while (window.length < viewport) window.push("");
					return [header, ...window, footer];
				},
				handleInput(data: string) {
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
		{ overlay: true, overlayOptions: () => ({ width: "100%", maxHeight: "100%" }) },
	);
}
function watchTarget(): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	return all.find((r) => r.running) ?? all.at(-1);
}
export default function (pi: ExtensionAPI) {
	const isChild = inChildSession();
	pi.registerTool({
		name: TOOL_NAME,
		label: "Agent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The self-contained brief for the agent — or, with resume_id, your answer to its question.",
			}),
			description: Type.String({
				description: "Short 3-5 word label for this task, shown in the UI.",
			}),
			resume_id: Type.Optional(
				Type.String({
					description:
						"Continue an existing agent session (id from a previous result) instead of starting a new one.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resumeId = params.resume_id;
			let record: ChildRecord;
			if (resumeId) {
				const existing = liveChildren.get(resumeId);
				if (!existing) {
					return textResult(
						`No live agent session with id "${resumeId}". It may have ended with the pi session. Start a fresh agent with a self-contained prompt.`,
						{ error: "unknown_resume_id" },
					);
				}
				record = existing;
				record.description = params.description;
			} else {
				const id = randomUUID().slice(0, 8);
				const session = await createChildSession(ctx);
				session.setSessionName(`agent#${id}`);
				record = {
					id,
					session,
					view: new ChildView(session, ctx.cwd),
					description: params.description,
					turns: 0,
					running: false,
				};
				liveChildren.set(id, record);
			}
			record.running = true;
			record.view.addUserMessage(params.prompt);
			const watcher = watchChild(record, onUpdate);
			const onAbort = () => void record.session.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await record.session.prompt(params.prompt);
			} finally {
				watcher.stop();
				record.running = false;
				record.currentTool = undefined;
				signal?.removeEventListener("abort", onAbort);
			}
			const text = watcher.text();
			return textResult(
				`${text || "(agent produced no text output)"}\n\n---\nagent id: ${record.id} (pass as resume_id to continue this session)`,
				{ id: record.id, aborted: signal?.aborted === true },
			);
		},
	});
	if (isChild) return;
	pi.registerShortcut(WATCH_KEY, {
		description: "Watch the running agent",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const record = watchTarget();
			if (!record) {
				ctx.ui.notify("No agent has run yet in this session.", "info");
				return;
			}
			await openChildView(ctx, record);
		},
	});
	pi.on("session_shutdown", () => {
		liveChildren.clear();
	});
}
