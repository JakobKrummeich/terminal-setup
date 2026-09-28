// ChildView: the F2 watch view's transcript of one child session (live events +
// replay of a reopened child's saved branch), with a handoff divider in front of
// every context-cap swap marker.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Spacer,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatTokenCount } from "./format.ts";
import { messageText } from "./message-text.ts";
import { SWAP_MARKER_TYPE, type SwapTrigger } from "./message-types.ts";

/** Human label of each swap trigger. Typed per SwapTrigger: a new trigger without a label is a compile error. */
const TRIGGER_LABELS: Record<SwapTrigger, string> = {
	soft: "soft cap",
	hard: "hard cap",
	"hard-no-file": "hard cap, no handoff file",
};

/** The swap-marker `details` fields the divider shows (context-cap.ts stageSwap). */
interface HandoffDetails {
	tokensAtSwap?: unknown;
	trigger?: unknown;
}

/**
 * Divider text for handoff `index` of `total`, `─`-padded (or truncated) to `width`:
 * `── ⇄ handoff 2/3 · at 162k tokens · soft cap ─────…`. Parts whose detail is
 * missing are omitted.
 */
export function handoffDividerText(
	index: number,
	total: number,
	details: HandoffDetails | undefined,
	width: number,
): string {
	const parts = [`\u21c4 handoff ${index}/${total}`];
	if (typeof details?.tokensAtSwap === "number") parts.push(`at ${formatTokenCount(details.tokensAtSwap)} tokens`);
	// details come from disk: an unknown string (older/newer writer) must yield undefined, not throw.
	const trigger =
		typeof details?.trigger === "string" && Object.hasOwn(TRIGGER_LABELS, details.trigger)
			? TRIGGER_LABELS[details.trigger as SwapTrigger]
			: undefined;
	if (trigger) parts.push(trigger);
	const label = `\u2500\u2500 ${parts.join(" \u00b7 ")} `;
	const fill = width - visibleWidth(label);
	return fill >= 0 ? label + "\u2500".repeat(fill) : truncateToWidth(label, width, "");
}

/**
 * One-line divider in front of a context-cap swap marker's block. `index`
 * (1-based) is fixed at creation; the total is read at render time because a
 * live run keeps adding handoffs. ChildView.render records its line as an anchor.
 */
class HandoffDivider implements Component {
	constructor(
		private readonly index: number,
		private readonly total: () => number,
		private readonly details: HandoffDetails | undefined,
	) {}
	render(width: number): string[] {
		return [getMarkdownTheme().heading(handoffDividerText(this.index, this.total(), this.details, width))];
	}
	invalidate() {}
}

/** A user/custom message as ChildView's block renderer sees it (live event or replayed entry). */
interface MessageBlock {
	role: string;
	content?: unknown;
	display?: boolean;
	customType?: string;
	details?: unknown;
}

/** A `custom_message` session entry as a message block (replay and entry_appended). */
function customEntryBlock(entry: Omit<MessageBlock, "role">): MessageBlock {
	return {
		role: "custom",
		content: entry.content,
		display: entry.display,
		customType: entry.customType,
		details: entry.details,
	};
}

export class ChildView {
	private readonly container = new Container();
	/** Handoff dividers in transcript order (their count is the `N` of `i/N`). */
	private readonly dividers: HandoffDivider[] = [];
	/** Line index of each handoff divider in the latest render() output. */
	handoffAnchors: number[] = [];
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
	/** Number of context-cap swap markers rendered so far. */
	get handoffCount(): number {
		return this.dividers.length;
	}
	/** Same output as Container.render, plus the handoff anchor line indexes. */
	render(width: number): string[] {
		const lines: string[] = [];
		const anchors: number[] = [];
		for (const child of this.container.children) {
			if (child instanceof HandoffDivider) anchors.push(lines.length);
			for (const line of child.render(width)) lines.push(line);
		}
		this.handoffAnchors = anchors;
		return lines;
	}
	addUserMessage(text: string) {
		this.pendingManualPrompts++;
		this.addUserBlock(text);
		this.requestRender();
	}
	private addUserBlock(text: string, divider?: HandoffDivider) {
		this.container.addChild(new Spacer(1));
		if (divider) this.container.addChild(divider);
		this.container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
	}
	/**
	 * User/custom message block, as live delivery and replay render it (no prompt
	 * dedupe). A context-cap swap marker gets a handoff divider as its first line.
	 */
	private addMessageBlock(message: MessageBlock) {
		if (message.role === "custom" && message.display === false) return;
		const text = messageText(message.content);
		if (!text.trim()) return;
		let divider: HandoffDivider | undefined;
		if (message.role === "custom" && message.customType === SWAP_MARKER_TYPE) {
			const details = message.details;
			divider = new HandoffDivider(
				this.dividers.length + 1,
				() => this.dividers.length,
				typeof details === "object" && details !== null ? (details as HandoffDetails) : undefined,
			);
			this.dividers.push(divider);
		}
		this.addUserBlock(text, divider);
	}
	/**
	 * Render a reopened child's saved history (session.sessionManager.getBranch():
	 * the FULL branch, including messages from before a context-cap swap and the
	 * swap markers — not the trimmed LLM context). Mirrors pi's own
	 * renderSessionEntries (interactive-mode.js renderSessionItems). Must run before
	 * the new prompt's addUserMessage and before any live event: it leaves no
	 * pending tools behind and never touches pendingManualPrompts.
	 */
	replay(entries: readonly unknown[]) {
		for (const raw of entries) {
			const entry = raw as { type?: string; message?: unknown } & Omit<MessageBlock, "role">;
			if (entry.type === "custom_message") {
				this.addMessageBlock(customEntryBlock(entry));
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			const message = entry.message as { role: string; content?: unknown; toolCallId?: string };
			if (message.role === "user") {
				this.addMessageBlock(message);
			} else if (message.role === "assistant") {
				const assistant = message as unknown as AssistantMessage;
				this.container.addChild(new AssistantMessageComponent(assistant, false, getMarkdownTheme()));
				const before = new Set(this.pendingTools.keys());
				this.syncToolCalls(assistant);
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					// Same as pi: tool calls of a failed message never ran — show why.
					const text =
						assistant.stopReason === "aborted" ? "Operation aborted" : assistant.errorMessage || "Error";
					for (const [id, tool] of this.pendingTools) {
						if (before.has(id)) continue;
						tool.updateResult({ content: [{ type: "text", text }], isError: true });
						this.pendingTools.delete(id);
					}
				}
			} else if (message.role === "toolResult" && message.toolCallId) {
				const tool = this.pendingTools.get(message.toolCallId);
				if (!tool) continue;
				tool.updateResult(message as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0]);
				this.pendingTools.delete(message.toolCallId);
			}
		}
		for (const tool of this.tools) tool.setArgsComplete();
		// A call without a saved result was cut off (abort mid-tool, pi killed mid-run).
		// Nothing will ever complete it: no live events exist for past calls.
		for (const tool of this.pendingTools.values()) {
			tool.updateResult({ content: [{ type: "text", text: "(interrupted — no result recorded)" }], isError: true });
		}
		this.pendingTools.clear();
		this.requestRender();
	}
	/**
	 * Injected mid-run messages — context-cap steers/reminders (role "user") and
	 * swap markers (role "custom", e.g. customType SWAP_MARKER_TYPE) — otherwise
	 * the F2 view shows a handoff tool call with no visible cause and no visible
	 * post-swap injection. The child's own prompt() delivery re-emits the prompt
	 * already shown by addUserMessage; pendingManualPrompts swallows exactly those.
	 * Two transports reach here: message_start (queued/steered messages, e.g.
	 * context-cap steers and reminders, sendMessage deliveries) and entry_appended
	 * (boundary entries — context-cap commits its swap marker as a turn_end
	 * boundary entry, which pi persists WITHOUT any message_start). Each delivery
	 * emits exactly one of the two, so handling both never double-renders.
	 */
	private addInjectedMessage(message: MessageBlock) {
		if (message.role === "user" && this.pendingManualPrompts > 0) {
			this.pendingManualPrompts--;
			return;
		}
		this.addMessageBlock(message);
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
					this.addInjectedMessage(event.message as MessageBlock);
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
			case "entry_appended": {
				const entry = event.entry as { type: string } & Omit<MessageBlock, "role">;
				if (entry.type === "custom_message") this.addInjectedMessage(customEntryBlock(entry));
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
