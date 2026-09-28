/**
 * context-cap, the LLM view: what the model sees of the session's messages —
 * the `context` handler's pure half (context-cap.ts). Stale cap warnings are
 * scrubbed (the rules are on that handler), then everything before the latest
 * swap marker is cut except the recency tail (CONTEXT_CAP_TAIL_TOKENS).
 *
 * Pure and pi-free: no session, no env, no module-level state (AGENTS.md — lib
 * files are re-imported per extension). Table-tested in
 * test/context-cap-defaults.test.ts, test/context-cap-view.test.ts and
 * test/context-cap-decisions.test.ts.
 */

import { SWAP_MARKER_TYPE } from "./message-types.ts";

// ---------------------------------------------------------------------------
// Cap warnings (the scrub key)
// ---------------------------------------------------------------------------

// pi's steering/followUp queues can deliver a cap message arbitrarily late — a
// network-errored run strands it until the next prompt, which may be a fresh
// post-swap window where the demand is nonsense.
// Every cap warning/reminder carries this prefix. It is the scrub key: the
// `context` handler removes messages carrying it from the LLM view once their
// demand no longer applies (see isCapWarning below), so no message in
// lib/context-cap-messages.ts needs a "if this looks stale, ignore it" clause —
// a stale one is never seen at all.
export const WARNING_PREFIX = "[context-cap]";

/**
 * A cap warning/reminder as it appears in the message array: a user message
 * whose text starts with WARNING_PREFIX. Only the four messages of
 * lib/context-cap-messages.ts match — swap-marker content (HANDOFF_PREAMBLE…)
 * and handoff bodies never carry the prefix.
 */
export function isCapWarning(message: unknown): boolean {
	const m = (message ?? {}) as { role?: string; content?: unknown };
	if (m.role !== "user") return false;
	if (typeof m.content === "string") return m.content.startsWith(WARNING_PREFIX);
	if (!Array.isArray(m.content)) return false;
	const first = (m.content.find((c) => (c as { type?: string })?.type === "text") ?? {}) as { text?: string };
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
 * What the model sees of the session's messages: stale cap warnings scrubbed
 * (the rules are on the `context` handler in context-cap.ts), then everything
 * before the latest swap marker cut except the recency tail. `changed` = the
 * result differs from `original` (the handler then returns a replacement array).
 * Pure.
 */
export function llmView<T>(
	original: readonly T[],
	cycleArmed: boolean,
	tailTokens: number,
): { messages: readonly T[]; changed: boolean } {
	const markerIndex = lastSwapMarkerIndex(original);
	// One pass: scrub, and note where the marker lands in the scrubbed array. The
	// marker survives the scrub by construction (custom role, never a cap warning).
	const kept: T[] = [];
	let marker = -1;
	original.forEach((m, i) => {
		if (i === markerIndex) marker = kept.length;
		if (!isCapWarning(m) || (cycleArmed && i > markerIndex)) kept.push(m);
	});
	// Recency tail: keep whole turns in front of the marker when the lever is
	// on. tailTokens = 0 ⇒ start === marker ⇒ the pre-lever slice.
	// The marker (and any post-swap turns) stay last: the handoff is the last
	// thing the model reads. Deterministic in the prefix, so later calls in the
	// same window cut at the same place and the prompt prefix stays cacheable.
	const start = marker >= 0 ? selectContextTail(kept, marker, tailTokens).start : 0;
	const messages = start > 0 ? kept.slice(start) : kept;
	return { messages, changed: start > 0 || kept.length !== original.length };
}
