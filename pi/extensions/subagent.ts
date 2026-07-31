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
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
const TOOL_NAME = "Agent";
const WATCH_KEY = (process.env.PI_SUBAGENT_WATCH_KEY ?? "f2") as KeyId;
interface ChildRecord {
	id: string;
	session: AgentSession;
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
function watchChild(
	record: ChildRecord,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
): { text(): string; stop(): void } {
	const parts: string[] = [];
	const pushStatus = () => onUpdate?.(textResult(statusLine(record), { id: record.id }));
	const unsub = record.session.subscribe((event: AgentSessionEvent) => {
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
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}
function renderTranscript(session: AgentSession, width: number): string[] {
	const markdownTheme = getMarkdownTheme();
	const lines: string[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			const text = messageText((message as { content?: unknown }).content);
			if (text.trim()) lines.push(...new UserMessageComponent(text, markdownTheme).render(width));
		} else if (message.role === "assistant") {
			lines.push(
				...new AssistantMessageComponent(message as AssistantMessage, false, markdownTheme).render(width),
			);
		} else if (message.role === "toolResult") {
			const tool = (message as { toolName?: string }).toolName ?? "tool";
			const first = messageText((message as { content?: unknown }).content).split("\n")[0] ?? "";
			lines.push(`  \u23ce ${tool}: ${first.slice(0, Math.max(0, width - tool.length - 6))}`);
		}
	}
	return lines;
}
async function openChildView(ctx: ExtensionContext, record: ChildRecord): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			const unsub = record.session.subscribe(() => tui.requestRender());
			return {
				dispose() {
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const header = record.running
						? `▶ ${statusLine(record)}`
						: `■ agent#${record.id} · ${record.description} · finished`;
					const footer = `Esc: back to main session · the agent keeps running`;
					const budget = Math.max(1, tui.terminal.rows - 4);
					const body = renderTranscript(record.session, width);
					return [header, "", ...body.slice(-budget), "", footer];
				},
				handleInput(data: string) {
					if (matchesKey(data, "escape")) done();
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
				record = { id, session, description: params.description, turns: 0, running: false };
				liveChildren.set(id, record);
			}
			record.running = true;
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
