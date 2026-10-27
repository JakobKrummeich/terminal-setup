/**
 * Shared fakes for the btw tests (not a test file itself — run.sh only runs
 * *.test.ts): a model registry whose streamSimple records every call and hands
 * back a stream the test drives by hand, plus assistant-message builders.
 */
import { type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface FakeCall {
	model: any;
	context: { messages: any[] };
	options: any;
	stream: AssistantMessageEventStream;
}

export interface FakeRegistry {
	calls: FakeCall[];
	streamSimple(model: any, context: any, options?: any): AssistantMessageEventStream;
}

export function assistantMessage(
	content: AssistantMessage["content"] | string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1_000,
		...extra,
	} as AssistantMessage;
}

/**
 * Records calls; each stream stays open until finish()/fail(). An abort on the
 * request signal ends the stream with stopReason "aborted", like a provider does.
 */
export function fakeRegistry(): FakeRegistry {
	const calls: FakeCall[] = [];
	return {
		calls,
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			calls.push({ model, context, options, stream });
			options?.signal?.addEventListener("abort", () => {
				const aborted = assistantMessage([], "aborted", { errorMessage: "Request was aborted" });
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end();
			});
			return stream;
		},
	};
}

/** Stream a partial answer (one text_delta carrying `text` so far). */
export function streamPartial(call: FakeCall, text: string): void {
	call.stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistantMessage(text, "stop") });
}

export function finish(call: FakeCall, message: AssistantMessage): void {
	call.stream.push({ type: "done", reason: message.stopReason as "stop", message });
	call.stream.end();
}

export function fail(call: FakeCall, errorMessage: string): void {
	call.stream.push({ type: "error", reason: "error", error: assistantMessage([], "error", { errorMessage }) });
	call.stream.end();
}

/** Let queued stream events reach the thread's for-await loop. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
