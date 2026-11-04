/**
 * context-cap, the LLM view: what the model sees of the session's messages —
 * the `context` handler's pure half (context-cap.ts). Everything before the
 * latest swap marker is cut except the recency tail (CONTEXT_CAP_TAIL_TOKENS),
 * and handoff demands inside that tail are scrubbed.
 *
 * Pure and pi-free: no session, no env, no module-level state (AGENTS.md — lib
 * files are re-imported per extension). Table-tested in
 * test/context-cap-defaults.test.ts, test/context-cap-view.test.ts and
 * test/context-cap-decisions.test.ts.
 */

import { HANDOFF_DEMAND_TYPE, SWAP_MARKER_TYPE } from "./message-types.ts";

// ---------------------------------------------------------------------------
// Cap warnings (the scrub key)
// ---------------------------------------------------------------------------

// Every cap demand/reminder text starts with this prefix (lib/context-cap-messages.ts);
// /handoff texts don't. It also identifies the warnings of sessions written before
// demands became boundary entries: those were user messages, delivered through
// pi's steer/followUp queues.
export const WARNING_PREFIX = "[context-cap]";

/**
 * A handoff demand/reminder as it appears in the message array: a custom
 * message of customType HANDOFF_DEMAND_TYPE (cap and /handoff alike), or a
 * legacy cap warning — a user message whose text starts with WARNING_PREFIX.
 * Swap-marker content (HANDOFF_PREAMBLE…) and handoff bodies match neither.
 */
export function isCapWarning(message: unknown): boolean {
	const m = (message ?? {}) as { role?: string; customType?: string; content?: unknown };
	if (m.role === "custom") return m.customType === HANDOFF_DEMAND_TYPE;
	return m.role === "user" && isLegacyWarningText(m.content);
}

/** A pre-boundary-entry cap warning: the user message's first text part starts with WARNING_PREFIX. */
function isLegacyWarningText(content: unknown): boolean {
	if (typeof content === "string") return content.startsWith(WARNING_PREFIX);
	if (!Array.isArray(content)) return false;
	const first = (content.find((c) => (c as { type?: string })?.type === "text") ?? {}) as { text?: string };
	return typeof first.text === "string" && first.text.startsWith(WARNING_PREFIX);
}

// ---------------------------------------------------------------------------
// Recency tail (CONTEXT_CAP_TAIL_TOKENS)
// ---------------------------------------------------------------------------

/**
 * Token estimate: characters / 4, the usual BPE rule of thumb for English + code.
 * Deliberately local and allocation-light — this runs inside the synchronous
 * `context` handler before every LLM call, where loading a tokenizer would be
 * absurd. It is an APPROXIMATION: ±25% on prose, worse on dense JSON, and images
 * are counted as a flat guess. The lever it feeds is a budget, not a limit that
 * anything breaks on.
 */
const CHARS_PER_TOKEN = 4;
/** Role/id/envelope overhead the character count does not see. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Flat per-image guess (~1k tokens); exact size needs the provider's tiler. */
const IMAGE_CHARS = 4000;
/** Unserializable toolCall arguments: guess rather than throw. */
const UNSERIALIZABLE_ARGUMENT_CHARS = 200;

/** The fields of an AgentMessage the estimator/pairing walk care about. */
type TailMessage = {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	summary?: string;
	command?: string;
	output?: string;
};

/** One content part, as far as the estimator reads it. */
type ContentPart = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

/** Cheap size estimate for one message. Pure. */
export function estimateMessageTokens(message: unknown): number {
	const m = (message ?? {}) as TailMessage;
	let chars = contentChars(m.content);
	// bashExecution / branchSummary / compactionSummary carry their text outside `content`.
	for (const extra of [m.summary, m.command, m.output]) {
		if (typeof extra === "string") chars += extra.length;
	}
	return MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const raw of content) chars += partChars((raw ?? {}) as ContentPart);
	return chars;
}

function partChars(c: ContentPart): number {
	let chars = 0;
	if (typeof c.text === "string") chars += c.text.length;
	if (typeof c.thinking === "string") chars += c.thinking.length;
	if (c.type === "image") chars += IMAGE_CHARS;
	if (c.type === "toolCall") chars += toolCallChars(c);
	return chars;
}

function toolCallChars(c: ContentPart): number {
	const name = c.name?.length ?? 0;
	try {
		return name + JSON.stringify(c.arguments ?? "").length;
	} catch {
		return name + UNSERIALIZABLE_ARGUMENT_CHARS;
	}
}

export interface TailSelection {
	/** Index of the first kept message. Equals `markerIndex` when nothing is kept. */
	start: number;
	/** Estimated tokens of messages[start … markerIndex). 0 when nothing is kept. */
	tokens: number;
}

/**
 * How much raw transcript directly before the swap marker may be kept.
 *
 * Pairing safety is the whole point: a tool result whose toolCall was cut, or an
 * assistant toolCall whose result was cut, is a provider error — strictly worse
 * than keeping nothing. So a cut is only allowed at a message that references
 * nothing earlier (anything that is not `assistant` and not `toolResult`; those
 * all convert to a standalone user message), and only when the walk from there
 * to the marker contains no orphan result and no dangling call.
 *
 * Walks backwards from the marker, accumulating the estimate, and returns the
 * EARLIEST safe boundary that still fits the budget. If none fits — budget too
 * small, a tool call whose result lands after the marker, no boundary at all —
 * it returns `start = markerIndex`, i.e. keep nothing: today's behaviour.
 *
 * Pure. O(n) over the messages it inspects.
 */
export function selectContextTail(
	messages: readonly unknown[],
	markerIndex: number,
	budgetTokens: number,
): TailSelection {
	const nothing: TailSelection = { start: markerIndex, tokens: 0 };
	if (!(budgetTokens > 0) || markerIndex <= 0) return nothing;

	const walk: PairingWalk = { unmatchedResults: new Set<string>(), danglingCalls: 0 };
	let tokens = 0;
	let best = nothing;
	for (let i = markerIndex - 1; i >= 0; i--) {
		tokens += estimateMessageTokens(messages[i]);
		if (tokens > budgetTokens) break; // every earlier start is larger still
		if (stepPairing(walk, messages[i])) best = { start: i, tokens };
		// A call whose result is after the marker can never come back: no cut
		// below this message is safe either, so the walk is done.
		if (walk.danglingCalls > 0) break;
	}
	return best;
}

/** Tool-call pairing state of selectContextTail's backwards walk. */
interface PairingWalk {
	/** Results already walked past whose toolCall has not been seen yet (calls precede results). */
	unmatchedResults: Set<string>;
	/** toolCalls walked past whose result lies beyond the marker. */
	danglingCalls: number;
}

/** Account one message (walking backwards); true = a safe cut lands right before it. */
function stepPairing(walk: PairingWalk, message: unknown): boolean {
	const m = (message ?? {}) as TailMessage;
	if (m.role === "toolResult") {
		if (typeof m.toolCallId === "string") walk.unmatchedResults.add(m.toolCallId);
		return false;
	}
	if (m.role === "assistant") {
		pairToolCalls(walk, m.content);
		return false;
	}
	// References nothing earlier: a safe cut when everything after it is paired.
	return walk.unmatchedResults.size === 0 && walk.danglingCalls === 0;
}

function pairToolCalls(walk: PairingWalk, content: unknown): void {
	for (const raw of Array.isArray(content) ? content : []) {
		const c = (raw ?? {}) as { type?: string; id?: string };
		if (c.type !== "toolCall" || typeof c.id !== "string") continue;
		if (!walk.unmatchedResults.delete(c.id)) walk.danglingCalls++;
	}
}

// ---------------------------------------------------------------------------
// LLM view
// ---------------------------------------------------------------------------

/** Index of the latest swap marker in `messages`, -1 when there is none. */
function lastSwapMarkerIndex(messages: readonly unknown[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role: string; customType?: string };
		if (m.role === "custom" && m.customType === SWAP_MARKER_TYPE) return i;
	}
	return -1;
}

/**
 * What the model sees of the session's messages: everything before the latest
 * swap marker cut except the recency tail, and the demands of swapped-away
 * cycles scrubbed from that tail (the rules are on the `context` handler in
 * context-cap.ts). `changed` = the result differs from `original` (the handler
 * then returns a replacement array). Pure.
 *
 * Without a marker the view is never changed: demands are boundary entries that
 * can never arrive late, so a window's own demands always stand, and an
 * unchanged view keeps pi's in-conversation system messages where they are.
 */
export function llmView<T>(original: readonly T[], tailTokens: number): { messages: readonly T[]; changed: boolean } {
	const markerIndex = lastSwapMarkerIndex(original);
	if (markerIndex < 0) return { messages: original, changed: false };
	// One pass: scrub demands behind the marker (only reachable via the tail
	// lever), and note where the marker lands in the scrubbed array.
	const kept: T[] = [];
	let marker = -1;
	original.forEach((m, i) => {
		if (i === markerIndex) marker = kept.length;
		if (i >= markerIndex || !isCapWarning(m)) kept.push(m);
	});
	// Recency tail: keep whole turns in front of the marker when the lever is
	// on. tailTokens = 0 ⇒ start === marker ⇒ the pre-lever slice.
	// The marker (and any post-swap turns) stay last: the handoff is the last
	// thing the model reads. Deterministic in the prefix, so later calls in the
	// same window cut at the same place and the prompt prefix stays cacheable.
	const start = selectContextTail(kept, marker, tailTokens).start;
	const messages = start > 0 ? kept.slice(start) : kept;
	return { messages, changed: start > 0 || kept.length !== original.length };
}
