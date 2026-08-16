/**
 * handoff-writer — draft a context handoff with ONE standalone LLM call.
 *
 * Used by context-cap.ts on the two degraded paths where no agent-written
 * handoff exists: its own hard cap (325k of a ~1M window — plenty of room for
 * one more call) and pi's own compaction threshold (contextWindow -
 * reserveTokens, i.e. near death). Same document shape both times: the section
 * lists below are the single source of truth, interpolated into the agent-facing
 * `context_handoff` tool instructions AND into this writer's prompt, so a
 * machine-written handoff is shaped exactly like an agent-written one. Which of
 * them is live is the CONTEXT_CAP_SCHEMA lever, resolved once in lib/env.ts.
 *
 * Contract of `draftHandoff`: bounded (own AbortController + timeout +
 * maxTokens), and it NEVER throws — every failure (no model, provider error,
 * rejected promise, abort, timeout, empty text) returns null and the caller
 * keeps its pre-existing fallback. Failing here must never be worse than not
 * calling it at all: the caller is about to wipe the user's context.
 *
 * Feeding the messages: history is flattened to text with pi's own
 * `serializeConversation()` and embedded in a single synthetic user message —
 * the path pi's compaction uses. A raw sliced message array would risk provider
 * errors from unpaired toolCall/toolResult pairs; serialized text cannot.
 *
 * STATELESS BY CONTRACT (AGENTS.md jiti rule): pi loads every extension file
 * with its own jiti instance, so a lib/ file imported by two extensions exists
 * twice and module-level state would silently split. This file holds constants
 * and pure functions only — no mutable module state, no caches. The caller owns
 * every cache (context-cap.ts caches the LLM-visible message array itself).
 */

import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CONTEXT_CAP_SCHEMA, type HandoffSchema } from "./env.ts";

/**
 * `AgentMessage`, without importing @earendil-works/pi-agent-core: that package
 * is not in the test symlink farm (test/run.sh) and not in tsconfig paths.
 */
export type HandoffMessage = Parameters<typeof convertToLlm>[0][number];

/** The only part of `ctx.modelRegistry` this writer needs (keeps stubs cheap in tests). */
export type HandoffCompleter = Pick<ModelRegistry, "complete">;

/** Wall-clock bound for the whole call. The agent loop is stalled while it runs. */
export const HANDOFF_TIMEOUT_MS = 120_000;
/** A handoff is ~30 (v1) to ~60 (v2) lines; the headroom absorbs reasoning tokens. */
export const HANDOFF_MAX_TOKENS = 8192;
/** Hard bound on the serialized conversation (tail kept — recent work matters most). */
export const HANDOFF_MAX_CONVERSATION_CHARS = 400_000;

/**
 * The handoff document shape — ONE source of truth per schema, shared by the
 * agent-facing tool instructions in context-cap.ts (CONTENT_SPEC and the tool's
 * `markdown` parameter description) and by this writer's prompt. WHICH schema is
 * live is decided in lib/env.ts (CONTEXT_CAP_SCHEMA) and nowhere else.
 *
 * v1 — the original shape. It is the A/B control: keep it byte-for-byte.
 */
export const HANDOFF_SECTIONS_V1 = `1. "## Current Task" — FIRST section: what you are working on right now and the overall goal. The next session sees ONLY this text; nobody will restate the task.
2. A brief summary of this session and current status
3. Key file paths that were worked on
4. Information you found surprising or where you struggled
5. What the next session needs to know to continue`;

/**
 * v2 — path-heavy operational shape. The "Files" section is the point: a
 * successor that is told which paths matter stops rediscovering them by grep.
 */
export const HANDOFF_SECTIONS_V2 = `1. "## Current Task" — FIRST section: what you are working on right now and the goal it serves. The next session sees ONLY this document; nobody will restate the task.
2. "## Status" — what is done, what is in progress, what is left. Separate verified from unverified and mark every unverified claim as unverified (say what would verify it).
3. "## Files" — EVERY path you touched or read this session that still matters, one per line, formatted \`path — state\` where state is one of: edited / created / read-only reference / needs work. Real paths only, no globs, no bare directory names. Be exhaustive rather than tidy: what you leave out, your successor re-discovers by grep.
4. "## Repo State" — branch, what is committed vs uncommitted (name the paths), the last commit subject, and anything staged or stashed. Your successor's first instinct is \`git status\` / \`git log\`; answer it here instead of making it look.
5. "## Next Step" — the exact next action as a runnable command or a precise edit (which file, what change), plus the commands that are known to work here (test/build/lint invocations with their real arguments).
6. "## Dead Ends" — what you tried that did not work, so your successor does not retry it.
7. "## Surprises / Open Questions" — what was not as expected, and what you could not settle.`;

/** Line budget quoted to whoever writes the document, per schema. */
const HANDOFF_LINE_BUDGET: Record<HandoffSchema, number> = { v1: 30, v2: 60 };

/** Section list for a schema. Defaults to the live lever (lib/env.ts). */
export function handoffSections(schema: HandoffSchema = CONTEXT_CAP_SCHEMA): string {
	return schema === "v1" ? HANDOFF_SECTIONS_V1 : HANDOFF_SECTIONS_V2;
}

/** Line budget for a schema. Defaults to the live lever (lib/env.ts). */
export function handoffLineBudget(schema: HandoffSchema = CONTEXT_CAP_SCHEMA): number {
	return HANDOFF_LINE_BUDGET[schema];
}

export const HANDOFF_SYSTEM_PROMPT = `You are a coding agent whose context window is full. You are not continuing the work: your only job right now is to write the handoff document your successor session starts from.

The next session sees this document and nothing else — no conversation history, no tool output, no user message restating the task. Anything you leave out is lost, and anything you invent cannot be checked. Be concrete: real file paths, real commands, real state, and mark what is unverified as unverified.

Output the document only — plain markdown, no YAML frontmatter, no code fence around the whole document, no preamble, no sign-off, no questions. Do not answer the last message of the conversation and do not call tools.`;

export interface HandoffDraft {
	/** Handoff markdown, trimmed and non-empty. */
	text: string;
	/** Usage of the drafting call, for session totals (pi stores it on the compaction entry). */
	usage?: Usage;
}

export interface DraftHandoffOptions {
	/** Usually `ctx.modelRegistry`. Undefined ⇒ null. */
	modelRegistry: HandoffCompleter | undefined;
	/** Usually `ctx.model`. Undefined (no model selected) ⇒ null. */
	model: Model<any> | undefined;
	/** History to hand off, oldest first. Unpaired tool calls are fine — this is serialized to text, never replayed. */
	messages: readonly HandoffMessage[];
	/** Caller's abort signal (run abort / compaction abort). Aborting ⇒ null. */
	signal?: AbortSignal;
	timeoutMs?: number;
	maxTokens?: number;
	/** Appended to the instructions, e.g. pi-compaction's keep-recent semantics. */
	extraInstructions?: string;
	/** Document shape to ask for. Defaults to the live lever (CONTEXT_CAP_SCHEMA). */
	schema?: HandoffSchema;
	/** Summary of context that preceded `messages` (pi's `preparation.previousSummary`). */
	previousSummary?: string;
}

/** Serialize history to text, keeping the tail if it is oversized. Pure. */
export function serializeForHandoff(
	messages: readonly HandoffMessage[],
	maxChars: number = HANDOFF_MAX_CONVERSATION_CHARS,
): string {
	let text: string;
	try {
		text = serializeConversation(convertToLlm([...messages]));
	} catch {
		return "";
	}
	if (text.length <= maxChars) return text;
	return `[... earlier conversation truncated ...]\n${text.slice(text.length - maxChars)}`;
}

/** The user-message body sent to the writer model. Pure — exported for tests. */
export function handoffUserPrompt(
	conversation: string,
	options: { extraInstructions?: string; previousSummary?: string; schema?: HandoffSchema } = {},
): string {
	const extra = options.extraInstructions ? `\n${options.extraInstructions}\n` : "";
	const previous = options.previousSummary
		? `Context that preceded this conversation (an earlier summary — it is already condensed, do not treat it as verified detail):\n\n<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`
		: "";
	return `${previous}The conversation below is the session being handed off, serialized (roles in brackets, tool results truncated).

<conversation>
${conversation}
</conversation>

Write the handoff document now (plain markdown, NO YAML frontmatter, ~${handoffLineBudget(options.schema)} lines total):
${handoffSections(options.schema)}
${extra}
Output the document only.`;
}

/**
 * One standalone completion that returns handoff markdown, or null on ANY failure.
 *
 * Failure modes handled explicitly, because a thrown error here would wipe the
 * user's context with no summary at all:
 *  - no model / no registry / no messages          → null (no call made)
 *  - caller already aborted                        → null (no call made)
 *  - provider failure without a throw              → response.stopReason "error"
 *    (pi's failure path resolves rather than rejects) → null
 *  - rejected promise (network, auth, bad request)  → null
 *  - timeout / caller abort mid-call               → own AbortController → null
 *  - empty or whitespace-only completion            → null
 * A truncated completion (stopReason "length") is kept: a partial handoff still
 * beats "your context is gone, ask the user".
 */
export async function draftHandoff(options: DraftHandoffOptions): Promise<HandoffDraft | null> {
	const { modelRegistry, model, messages } = options;
	if (!modelRegistry || !model || messages.length === 0) return null;
	if (options.signal?.aborted) return null;

	const conversation = serializeForHandoff(messages);
	if (!conversation.trim()) return null;

	const controller = new AbortController();
	const abortFromCaller = () => controller.abort();
	options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? HANDOFF_TIMEOUT_MS);
	try {
		const response = await modelRegistry.complete(
			model,
			{
				systemPrompt: HANDOFF_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: handoffUserPrompt(conversation, {
									extraInstructions: options.extraInstructions,
									previousSummary: options.previousSummary,
									schema: options.schema,
								}),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: options.maxTokens ?? HANDOFF_MAX_TOKENS,
				signal: controller.signal,
				// Standalone one-off request: must neither reuse nor pollute the
				// session's prompt cache, and must not share its routing session id.
				// Same choice pi's own summarizer makes.
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);
		// pi's provider layer resolves with a synthesized message on failure instead
		// of rejecting, so stopReason is the real error channel here.
		if (!response || response.stopReason === "error" || response.stopReason === "aborted") return null;
		const text = contentText(response.content ?? []).trim();
		if (!text) return null;
		return { text, usage: response.usage };
	} catch {
		// Rejected promise: network, auth, malformed request, abort. Never rethrow.
		return null;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
