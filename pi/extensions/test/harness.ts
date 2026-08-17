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
	| { kind: "tool"; id: string; name: string; args: Record<string, unknown>; contextTokens?: number }
	| { kind: "text"; text: string; contextTokens?: number }
	| { kind: "error"; message?: string; aborted?: boolean };

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
	 * child session gets, since child-session.ts binds with no mode. Setting it
	 * re-emits session_start, so opt in only where the mode matters.
	 */
	mode?: ExtensionMode;
	/**
	 * Compaction settings override (default: disabled). Tests that exercise pi's
	 * own compaction need it enabled plus a tiny `keepRecentTokens`, otherwise
	 * prepareCompaction finds nothing to summarize in these small sessions.
	 */
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
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
	modelRuntime.setRuntimeApiKey("anthropic", "test-key-not-used");
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("test model not found");

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

	const startedAt = Date.now();
	const now = () => Date.now() - startedAt;

	let step = 0;
	const llmDelayMs = options.llmDelayMs ?? 50;
	session.agent.streamFunction = ((m: any) => {
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
				output.content = [
					{ type: "toolCall", id: scripted.id, name: scripted.name, arguments: scripted.args },
				];
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
		now,
		dispose: () => session.dispose(),
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
