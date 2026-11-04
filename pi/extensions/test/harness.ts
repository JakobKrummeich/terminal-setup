/**
 * Test harness: runs a real pi AgentSession with a scripted (fake) LLM.
 *
 * No network, no API key: `session.agent.streamFunction` is replaced with a
 * generator that returns pre-scripted assistant messages, so tool calls,
 * turn boundaries and queue behaviour are exercised by the real pi internals
 * (agent-loop, steering/follow-up queues) while staying deterministic.
 */

// No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests and
// hang the test process. Must be set before ModelRuntime.create runs.
process.env.PI_OFFLINE ??= "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** pi's ExtensionMode. Re-declared: the package root does not re-export the type. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** One scripted assistant response: a tool call, a final text answer, or a network failure. */
export type ScriptedStep =
	| {
			kind: "tool";
			id: string;
			name: string;
			args: Record<string, unknown>;
			contextTokens?: number;
			/** Further calls in the same assistant message (one tool batch). */
			more?: ToolCallSpec[];
	  }
	| { kind: "text"; text: string; contextTokens?: number }
	| { kind: "error"; message?: string; aborted?: boolean };

export interface ToolCallSpec {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/** A step that yields an assistant response — what stream drivers actually render. */
export type ResponseStep = Exclude<ScriptedStep, { kind: "error" }>;

export const toolStep = (
	id: string,
	name: string,
	args: Record<string, unknown>,
	contextTokens?: number,
): ScriptedStep => ({
	kind: "tool",
	id,
	name,
	args,
	contextTokens,
});

/** One assistant message calling several tools at once — pi runs them as one batch. */
export const batchStep = (calls: [ToolCallSpec, ...ToolCallSpec[]], contextTokens?: number): ScriptedStep => {
	const [first, ...more] = calls;
	return { kind: "tool", ...first, contextTokens, more };
};

export const textStep = (text: string, contextTokens?: number): ScriptedStep => ({
	kind: "text",
	text,
	contextTokens,
});

/**
 * Simulated network/stream failure: the LLM call throws instead of returning a
 * stream. Exercises pi's real failure path (handleRunFailure): a synthesized
 * assistant message with stopReason "error" plus message_end / turn_end /
 * agent_end, exactly as a dead API stream produces live.
 */
export const errorStep = (message?: string): ScriptedStep => ({ kind: "error", message });

/**
 * Simulated user abort mid-call: aborts the session, then the LLM call throws.
 * The abort signal is already set when handleRunFailure runs, so the synthesized
 * assistant message carries stopReason "aborted" (the ESC path's stopReason).
 */
export const abortedStep = (): ScriptedStep => ({ kind: "error", aborted: true });

export interface TestSessionOptions {
	/** Absolute paths of extensions under test. */
	extensionPaths: string[];
	/** Assistant responses, one per LLM call. Exhausted script ends the run. */
	script: ScriptedStep[];
	/** Tool names to enable (extension tools must be listed explicitly). */
	tools?: string[];
	/** Simulated LLM latency per call. */
	llmDelayMs?: number;
	/**
	 * Extension run mode reported as `ctx.mode` (timer.ts branches on it).
	 * Left unset, pi's ExtensionRunner default ("print") applies — the same value a
	 * child session gets, since child-create.ts binds with no mode. Setting it
	 * re-emits session_start, so opt in only where the mode matters.
	 */
	mode?: ExtensionMode;
	/**
	 * Compaction settings override (default: disabled). Tests that exercise pi's
	 * own compaction need it enabled plus a tiny `keepRecentTokens`, otherwise
	 * prepareCompaction finds nothing to summarize in these small sessions.
	 */
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
	/**
	 * Session model as `[provider, modelId]` from pi's catalog (default
	 * anthropic/claude-sonnet-4-5: no native mid-conversation tool changes).
	 */
	model?: [provider: string, modelId: string];
	/**
	 * Called with every LLM request exactly as the agent loop hands it to the
	 * provider (model + normalized context, system messages included) before the
	 * scripted response is produced. Payload tests feed it to pi-ai's real
	 * provider `stream` with an `onPayload` probe.
	 */
	onLlmCall?: (model: any, context: any, options: any) => void | Promise<void>;
	/**
	 * Bind interactive command actions (re-emits session_start): `waitForIdle`
	 * really waits, and `newSession` runs its `withSession` callback against a
	 * recorder instead of replacing the session — see `seeds`. Also records every
	 * `ctx.ui.notify` in `notices`. Without it, pi's defaults make both no-ops.
	 */
	commands?: boolean;
}

/** A message a command's `newSession({ withSession })` seeded the successor with. */
export interface SeededMessage {
	customType: string;
	content: unknown;
	display: boolean;
	triggerTurn: boolean | undefined;
}

export interface QueueSnapshot {
	atMs: number;
	steering: string[];
	followUp: string[];
}

export interface TestSession {
	session: any;
	/**
	 * The session's ModelRuntime. `ctx.modelRegistry.complete()` delegates to it,
	 * so patching `modelRuntime.complete` scripts standalone (non-agent-loop) LLM
	 * calls made by extensions.
	 */
	modelRuntime: any;
	/** Text of every user message actually delivered to the agent, in order. */
	deliveredUserMessages: { atMs: number; text: string }[];
	/** Every queue_update emitted by the session. */
	queueSnapshots: QueueSnapshot[];
	/** Timestamps of turn boundaries. */
	turnEnds: number[];
	/** newSession seeds (only with `commands: true`). */
	seeds: SeededMessage[];
	/** ctx.ui.notify calls (only with `commands: true`). */
	notices: { message: string; level: string | undefined }[];
	/** Milliseconds since the session was created. */
	now(): number;
	dispose(): void;
}

export async function createTestSession(options: TestSessionOptions): Promise<TestSession> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-test-"));
	const agentDir = path.join(dir, "agent");

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	const [provider, modelId] = options.model ?? ["anthropic", "claude-sonnet-4-5"];
	modelRuntime.setRuntimeApiKey(provider, "test-key-not-used");
	const model = getModel(provider as any, modelId as any);
	if (!model) throw new Error(`test model not found: ${provider}/${modelId}`);

	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		additionalExtensionPaths: options.extensionPaths,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	} as any);
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	if (loaded.errors.length > 0) {
		throw new Error(`extension load errors: ${JSON.stringify(loaded.errors)}`);
	}

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		tools: options.tools ?? [],
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false, ...options.compaction },
			retry: { enabled: false },
		} as any),
	});

	if (options.mode !== undefined) await session.bindExtensions({ mode: options.mode });
	const seeds: SeededMessage[] = [];
	const notices: { message: string; level: string | undefined }[] = [];
	if (options.commands) await bindCommands(session, seeds, notices);

	const startedAt = Date.now();
	const now = () => Date.now() - startedAt;

	let step = 0;
	const llmDelayMs = options.llmDelayMs ?? 50;
	session.agent.streamFunction = ((m: any, context: any, streamOptions: any) => {
		// Like a real provider: a request on an already-aborted signal never goes out.
		if (streamOptions?.signal?.aborted) throw new Error("Request was aborted");
		void options.onLlmCall?.(m, context, streamOptions);
		const peek = options.script[step];
		if (peek?.kind === "error") {
			// Throw synchronously from the stream function: pi awaits the call, so
			// this lands in runWithLifecycle's catch -> handleRunFailure.
			step++;
			// session.abort() sets the agent's abort signal synchronously (before its
			// internal awaits), so the failure below is classified as "aborted".
			if (peek.aborted) void session.abort();
			throw new Error(peek.message ?? "simulated network error");
		}
		const stream = createAssistantMessageEventStream();
		void (async () => {
			// "error" was consumed above at the same index, so the cast is safe.
			const scripted = (options.script[step++] ?? textStep("(script exhausted)")) as ResponseStep;
			const output: any = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					// Drives ctx.getContextUsage().tokens (context-cap triggers).
					totalTokens: scripted.contextTokens ?? 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(llmDelayMs);
			if (scripted.kind === "tool") {
				output.content = [scripted, ...(scripted.more ?? [])].map((c) => ({
					type: "toolCall",
					id: c.id,
					name: c.name,
					arguments: c.args,
				}));
				output.stopReason = "toolUse";
			} else {
				output.content = [{ type: "text", text: scripted.text }];
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		})();
		return stream;
	}) as any;

	const deliveredUserMessages: { atMs: number; text: string }[] = [];
	const queueSnapshots: QueueSnapshot[] = [];
	const turnEnds: number[] = [];

	session.subscribe((event: any) => {
		if (event.type === "message_start" && event.message.role === "user") {
			const text = (event.message.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			deliveredUserMessages.push({ atMs: now(), text });
		} else if (event.type === "queue_update") {
			queueSnapshots.push({ atMs: now(), steering: [...event.steering], followUp: [...event.followUp] });
		} else if (event.type === "turn_end") {
			turnEnds.push(now());
		}
	});

	return {
		session,
		modelRuntime,
		deliveredUserMessages,
		queueSnapshots,
		turnEnds,
		seeds,
		notices,
		now,
		dispose: () => session.dispose(),
	};
}

async function bindCommands(
	session: any,
	seeds: SeededMessage[],
	notices: { message: string; level: string | undefined }[],
): Promise<void> {
	const recorder = {
		sendMessage: async (message: any, opts?: { triggerTurn?: boolean }) => {
			seeds.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				triggerTurn: opts?.triggerTurn,
			});
		},
	};
	await session.bindExtensions({
		// Spread copies the runner's no-op UI (theme getter included) and overrides notify only.
		uiContext: {
			...session.extensionRunner.uiContext,
			notify: (message: string, level?: string) => void notices.push({ message, level }),
		},
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async (opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
				await opts?.withSession?.(recorder);
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
	});
}

/**
 * Text of every handoff demand/reminder committed to the session, in order —
 * context-cap delivers them as custom-message boundary entries (customType
 * "handoff-demand", lib/message-types.ts), so they never show up in
 * `deliveredUserMessages`.
 */
export function demandTexts(t: Pick<TestSession, "session">): string[] {
	return (t.session.messages as Array<{ role: string; customType?: string; content?: unknown }>)
		.filter((m) => m.role === "custom" && m.customType === "handoff-demand")
		.map((m) => String(m.content));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
