// btw side chat, pure half: what a side question is forked FROM (ForkSnapshot —
// the transcript as last sent to the model, plus every message finished since)
// and the exact message list one btw request sends (buildBtwMessages). The thread
// that streams it lives in lib/btw-thread.ts, the UI in lib/btw-chat.ts.
import {
	type AssistantMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	type Message,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/**
 * `AgentMessage`, without importing @earendil-works/pi-agent-core (not in the test
 * symlink farm) — same trick as lib/handoff-writer.ts.
 */
export type BtwAgentMessage = Parameters<typeof convertToLlm>[0][number];

/**
 * Hidden framing in front of every btw question (the UI shows only the question).
 * It tells the model why it suddenly cannot call tools and that a tool call
 * without a result is still running — not failed.
 */
export const BTW_PREAMBLE =
	"[btw — side question from the user, asked while your work continues in the background. This is a forked side chat: you cannot use tools here, answer in text only. Your main run never sees this exchange. A tool call shown without a result is still running.]";

/** Synthetic result for a tool call of the fork's last assistant message that has none yet. */
export const PENDING_RESULT_TEXT = "(still running — no result yet)";

/** Shown (and replayed) for an answer that consisted of tool calls only. */
export const TOOL_ONLY_TEXT = "(the model tried to call a tool — btw has no tools)";

/** The fork source: the transcript of one model request plus what finished after it. */
export interface BtwFork {
	messages: BtwAgentMessage[];
	/** ctx.getSystemPrompt() at request time; undefined when not captured (children). */
	systemPrompt?: string;
}

/** One finished btw exchange. */
export interface BtwTurn {
	question: string;
	answer: AssistantMessage;
}

/**
 * The live fork source of one session. onRequest() on every model request (the
 * context as sent), onMessageEnd() for every message finished after it — the
 * in-flight assistant message with its still-running tool call arrives here.
 * One instance per session (btw.ts closure / lib/btw-child.ts WeakMap), never
 * module state.
 */
export class ForkSnapshot {
	private request: BtwFork | undefined;
	private since: BtwAgentMessage[] = [];

	onRequest(messages: readonly BtwAgentMessage[], systemPrompt?: string): void {
		this.request = { messages: messages.slice(), systemPrompt };
		this.since = [];
	}

	onMessageEnd(message: BtwAgentMessage): void {
		this.since.push(message);
	}

	/** Undefined until the session's first model request. */
	fork(): BtwFork | undefined {
		if (!this.request) return undefined;
		return { messages: [...this.request.messages, ...this.since], systemPrompt: this.request.systemPrompt };
	}
}

/**
 * pi's forced-system-prompt projection (agent-session.js
 * `_installAgentForcedPromptProjection`), replicated: pi applies it AFTER the
 * `context_with_system` handlers the main-session snapshot observes, so the
 * captured messages still carry pi's built prompt. When a before_agent_start
 * handler forced a prompt (caveman-prompt.ts, the child contract in subagent.ts),
 * pi replaces the head with it — keeping the current tool declarations — and drops
 * every other system message. ctx.getSystemPrompt() captured at request time is
 * that forced prompt; without one it renders exactly getCurrentSystemPrompt(), so
 * "differs" means "forced". Not replicated: `_installHiddenDeclarationsProjection`
 * (prepareLoadout hooks) — nothing in this repo registers one.
 */
export function projectForcedPrompt(messages: readonly Message[], systemPrompt: string | undefined): Message[] {
	if (systemPrompt === undefined || systemPrompt === getCurrentSystemPrompt(messages)) return messages.slice();
	const current = getCurrentSystemMessage(messages);
	const head: Message = {
		role: "system",
		content: systemPrompt,
		...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
		timestamp: current?.timestamp ?? Date.now(),
	};
	return [head, ...messages.filter((message) => message.role !== "system")];
}

/**
 * Synthetic results for the tool calls of the LAST assistant message that have no
 * result yet — the calls still running in the real session. Without them pi-ai's
 * transformMessages inserts `No result provided` with isError: true, which reads
 * to the model as a failed call. Earlier orphans (a run killed mid-tool) are left
 * to that default: they are not running. Errored/aborted assistant messages are
 * skipped by transformMessages, so their calls get nothing here either.
 */
export function withPendingResults(messages: readonly Message[]): Message[] {
	const index = lastAssistantIndex(messages);
	const last = messages[index];
	if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
		return messages.slice();
	}
	const answered = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
	const pending = last.content.flatMap((block) =>
		block.type === "toolCall" && !answered.has(block.id) ? [pendingResult(block, last.timestamp)] : [],
	);
	return [...messages.slice(0, index + 1), ...pending, ...messages.slice(index + 1)];
}

/** Index of the last assistant message; -1 when there is none. */
function lastAssistantIndex(messages: readonly Message[]): number {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "assistant") index--;
	return index;
}

function pendingResult(call: { id: string; name: string }, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: PENDING_RESULT_TEXT }],
		isError: false,
		timestamp,
	} as ToolResultMessage;
}

/**
 * An answer as btw shows and replays it: tool calls stripped (btw declares the
 * tools but sends toolChoice "none"; a call slipping through can never run), and
 * TOOL_ONLY_TEXT when nothing else remains. Errored/aborted answers keep their
 * (possibly empty) content: AssistantMessageComponent shows their errorMessage.
 */
export function displayAnswer(answer: AssistantMessage): AssistantMessage {
	const content = answer.content.filter((block) => block.type !== "toolCall");
	if (content.length === answer.content.length) return answer;
	const kept = content.some((block) => block.type === "text" && block.text.trim() !== "");
	const failed = answer.stopReason === "error" || answer.stopReason === "aborted";
	return {
		...answer,
		content: kept || failed ? content : [...content, { type: "text", text: TOOL_ONLY_TEXT }],
		stopReason: answer.stopReason === "toolUse" ? "stop" : answer.stopReason,
	};
}

/** A btw question as the model sees it: BTW_PREAMBLE, blank line, question. */
export function btwUserMessage(question: string, timestamp = Date.now()): UserMessage {
	return { role: "user", content: [{ type: "text", text: `${BTW_PREAMBLE}\n\n${question}` }], timestamp };
}

/** Prior turns as context: errored ones excluded (question too — no orphan user turn). */
function replayTurns(turns: readonly BtwTurn[]): Message[] {
	return turns
		.filter((turn) => turn.answer.stopReason !== "error" && turn.answer.stopReason !== "aborted")
		.flatMap((turn) => [btwUserMessage(turn.question, turn.answer.timestamp), displayAnswer(turn.answer)]);
}

/**
 * The full message list of one btw request: [fork, as the model saw it] →
 * [prior btw turns] → [new question]. Re-built per question from the LIVE
 * snapshot, so a follow-up sees the session's progress since the last one.
 */
export function buildBtwMessages(fork: BtwFork, priorTurns: readonly BtwTurn[], question: string): Message[] {
	const transcript = projectForcedPrompt(convertToLlm(fork.messages), fork.systemPrompt);
	return [...withPendingResults(transcript), ...replayTurns(priorTurns), btwUserMessage(question)];
}
