// btw side chat thread: the finished turns of one session's side chat plus the one
// answer in flight, streamed by a direct LLM call — never through the session's
// agent, so the real session is never touched (no steer, no follow-up, nothing
// appended or persisted). Messages: lib/btw-context.ts; UI: lib/btw-chat.ts.
import type { Api, AssistantMessage, Model, ModelThinkingLevel, ThinkingBudgets, Transport } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type BtwFork, type BtwTurn, buildBtwMessages } from "./btw-context.ts";

/** No model request yet in the forked session: nothing to fork from. */
export const NOTHING_TO_FORK = "btw: nothing to fork yet — needs at least one model request in this session";

/** Everything one btw request needs, built per question from the forked session. */
export interface BtwRequest {
	/**
	 * ctx.modelRegistry (auth at request time). NOT the agent's streamFunction:
	 * that one starts pi's cache warmer for requests carrying the session's id.
	 */
	registry: Pick<ModelRegistry, "streamSimple">;
	/** The forked session's model and thinking level. */
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	/** The forked session's id: OpenAI's prompt_cache_key → a cache hit on the fork prefix. */
	sessionId: string;
	/** The forked session's `images.blockImages` setting (buildBtwMessages). */
	blockImages: boolean;
	/** The forked session's `thinkingBudgets` / `transport` settings, passed as the session passes them. */
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	fork: BtwFork;
}

/**
 * The forked session as the side chat sees it: a display label (`main session`,
 * `agent#3`), its model id for the header, and the request for one question —
 * built at ask time, so it always forks the live snapshot.
 */
export interface BtwSource {
	label: string;
	modelId(): string | undefined;
	/** Throws with a user-facing message when no request can be built. */
	request(): BtwRequest;
}

/** A BtwRequest from possibly-missing parts: NOTHING_TO_FORK / no model become errors. */
export function btwRequest(parts: Omit<BtwRequest, "model" | "fork"> & {
	model: Model<Api> | undefined;
	fork: BtwFork | undefined;
}): BtwRequest {
	const { model, fork } = parts;
	if (!fork) throw new Error(NOTHING_TO_FORK);
	if (!model) throw new Error("btw: the forked session has no model selected");
	return { ...parts, model, fork };
}

/** The answer being streamed; `partial` is undefined until the first stream event. */
export interface BtwInFlight {
	question: string;
	partial: AssistantMessage | undefined;
}

interface Flight extends BtwInFlight {
	controller: AbortController;
}

/** An answer standing in for a request that could not even start (no model, no fork, …). */
function failedAnswer(error: unknown): AssistantMessage {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return {
		role: "assistant",
		content: [],
		api: "btw" as Api,
		provider: "btw",
		model: "btw",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * One side-chat thread (main session, or one child). In memory only. One request
 * at a time: ask() while answering is ignored. abort() drops the in-flight turn
 * for good — it never becomes a turn, even if the provider still answers.
 */
export class BtwThread {
	readonly turns: BtwTurn[] = [];
	private flight: Flight | undefined;
	private readonly listeners = new Set<() => void>();

	get inFlight(): BtwInFlight | undefined {
		return this.flight;
	}

	get answering(): boolean {
		return this.flight !== undefined;
	}

	/** Called after every change (question sent, stream event, answer, abort). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Send `question`; `request` is built only now so the fork is the live snapshot.
	 * A throwing `request` (nothing to fork, no model) becomes an errored turn.
	 */
	async ask(question: string, request: () => BtwRequest): Promise<void> {
		if (this.flight) return;
		const flight: Flight = { question, partial: undefined, controller: new AbortController() };
		this.flight = flight;
		this.emit();
		const answer = await this.stream(flight, request);
		if (this.flight !== flight) return; // aborted meanwhile: dropped
		this.flight = undefined;
		if (answer.stopReason !== "aborted") this.turns.push({ question, answer });
		this.emit();
	}

	abort(): void {
		const flight = this.flight;
		if (!flight) return;
		this.flight = undefined;
		flight.controller.abort();
		this.emit();
	}

	private async stream(flight: Flight, request: () => BtwRequest): Promise<AssistantMessage> {
		try {
			const req = request();
			const messages = buildBtwMessages(req.fork, this.turns, flight.question, req.blockImages);
			// Same request shape as the session's own (tools declared, NO toolChoice), so
			// the fork prefix hits the prompt cache. WHY not drop the tools: Anthropic's
			// cache prefix is tools → system → messages (full miss), and it rejects a
			// history holding tool_use blocks with no tools declared. WHY not toolChoice
			// "none": a changed tool_choice invalidates Anthropic's cached messages, and
			// a model asked to run something then writes fake tool-call markup as TEXT,
			// which never ends its turn (seen live: an endless "calling" loop). With the
			// default, a call ends the turn normally; btw never executes it
			// (displayAnswer, lib/btw-context.ts) and the preamble says tools are off.
			const stream = req.registry.streamSimple(
				req.model,
				{ messages },
				{
					reasoning: req.thinkingLevel === "off" ? undefined : req.thinkingLevel,
					sessionId: req.sessionId,
					...(req.thinkingBudgets && { thinkingBudgets: req.thinkingBudgets }),
					...(req.transport && { transport: req.transport }),
					signal: flight.controller.signal,
				},
			);
			for await (const event of stream) {
				if (this.flight !== flight || !("partial" in event)) continue;
				flight.partial = event.partial;
				this.emit();
			}
			return await stream.result();
		} catch (error) {
			return failedAnswer(error);
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
