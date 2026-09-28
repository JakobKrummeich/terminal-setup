/**
 * context-cap state machine, pure half: the per-cycle state and the decisions
 * the `message_end` / `turn_end` handlers of context-cap.ts take on it.
 *
 * Every function here maps (state, observed input) → an action tag; the
 * handlers in context-cap.ts gather the input, call one decide function and run
 * the action's side effects (notify, status, steer/followUp, staging/committing
 * the swap marker, the hard-cap backstop) in a `switch (action.kind)`. Keeping
 * the decisions here makes every branch table-testable without a pi session
 * (test/context-cap-decisions.test.ts); the WHY behind each branch lives next
 * to the branch below. The mechanism as a whole is described in the header of
 * context-cap.ts.
 *
 * Must stay free of pi imports and of module-level mutable state (AGENTS.md:
 * lib files are re-imported per extension): types, constants and pure functions.
 */

import type { HandoffSchema, ResolvedTriggers, TriggerSource } from "./env.ts";
import type { SwapTrigger } from "./message-types.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Follow-up reminders sent after a steer/prompt the agent did not act on. */
export const MAX_RETRIES = 2;

/**
 * idle      — no cycle demanded (a hard-cap backstop may still have armed a path; see CycleState)
 * steered   — soft or one-jump hard steer sent mid-tool-use
 * prompted  — silent-stop followUp sent (crossing turn had no tool calls)
 * exhausted — reminders used up; only the hard-cap backstop is left
 */
export type Phase = "idle" | "steered" | "prompted" | "exhausted";

/** Who wrote the handoff document: the agent via the tool, or the writer LLM call. */
export type HandoffAuthor = "agent" | "machine";

/** Forensic metadata persisted on the swap-marker session entry (never sent to LLM). */
export interface SwapDetails {
	seq: number | null;
	trigger: SwapTrigger;
	tokensAtSwap: number;
	handoffPath: string | null;
	stale: boolean;
	/** null = no document at all (hard-no-file). Lets reconstruction tell the paths apart. */
	author: HandoffAuthor | null;
	/** A/B lever: handoff document schema the writer was asked for. */
	schema: HandoffSchema;
	/** A/B lever: configured recency-tail budget (CONTEXT_CAP_TAIL_TOKENS). */
	tailTokens: number;
	/** Estimated tokens of raw transcript kept in front of the handoff (0 = lever off). */
	tailKeptTokens: number;
	/** Model context window this cycle's caps were derived from; null = unknown. */
	contextWindow: number | null;
	/** Soft trigger actually in force when the cycle started. */
	softCap: number;
	/** Hard trigger actually in force when the cycle started. */
	hardCap: number;
	/** Where softCap/hardCap came from: explicit env, derived from the window, or the static default. */
	capSource: TriggerSource;
}

export interface StagedSwap {
	content: string;
	details: SwapDetails;
	swapCaps: ResolvedTriggers;
	/** Exact assistant object whose message_end prepared this marker. */
	sourceMessage: unknown;
}

/**
 * One handoff cycle. Lifecycle:
 *  - `idleCycle()` on session_start, after every committed swap, after a failed
 *    handoff-file read, and when the window shrank mid-cycle (reset-shrunk).
 *  - startCycle (context-cap.ts) arms it: seq/expectedPath/retries/
 *    tokensAtTrigger/handoffWritten/cycleCaps — the caller then sets `phase`.
 *    The hard-cap backstop can arm a cycle while `phase` stays "idle".
 *  - the `context_handoff` tool sets `handoffWritten`; turn_end then swaps.
 * The whole object is replaced on reset, never patched field by field — so no
 * field can survive a reset by accident.
 */
export interface CycleState {
	phase: Phase;
	/** Where this cycle's handoff goes (<agent dir>/context-cap/<sessionId>-<seq>.md); set ⇔ cycle armed. */
	expectedPath: string | undefined;
	seq: number;
	/** Reminders sent so far in this cycle (≤ MAX_RETRIES). */
	retries: number;
	/** Token reading that started the cycle (updated by the hard cap) — the marker's tokensAtSwap. */
	tokensAtTrigger: number;
	/** Set by the tool once the handoff file is on disk. Replaces existsSync polling. */
	handoffWritten: boolean;
	/** One-shot grace so the hard cap doesn't swap away the message carrying the tool call. */
	hardGraceUsed: boolean;
	/**
	 * The pair in force when the current cycle started — what the steer message
	 * quoted, and therefore what the marker/frontmatter must record. Deliberately
	 * NOT re-resolved at swap time: the forensic question is "what fired this".
	 */
	cycleCaps: ResolvedTriggers | null;
	/** Marker prepared during message_end and committed at the imminent turn_end boundary. */
	stagedSwap: StagedSwap | null;
}

export function idleCycle(): CycleState {
	return {
		phase: "idle",
		expectedPath: undefined,
		seq: 0,
		retries: 0,
		tokensAtTrigger: 0,
		handoffWritten: false,
		hardGraceUsed: false,
		cycleCaps: null,
		stagedSwap: null,
	};
}

/** The cap values a decision reads — `ResolvedTriggers`, minimally. */
export type CapsView = Pick<ResolvedTriggers, "soft" | "hard" | "disabled">;

/**
 * Network-errored / user-aborted messages and turns are synthesized by pi's
 * failure path, never agent decisions — both handlers skip them.
 */
function isFailedStop(reason: string | undefined): boolean {
	return reason === "error" || reason === "aborted";
}

// ---------------------------------------------------------------------------
// message_end
// ---------------------------------------------------------------------------

export interface MessageEndInput {
	/** The assistant message's stopReason ("toolUse" ⇒ another turn is guaranteed). */
	stopReason: string | undefined;
	/** Provider usage of this message, else ctx.getContextUsage(); null/undefined = unknown. */
	tokens: number | null | undefined;
	caps: CapsView;
}

export type MessageEndAction =
	| { kind: "skip"; reason: "failed-stop" | "no-usage" | "cap-disabled" }
	| { kind: "reset-shrunk"; tokens: number }
	| { kind: "steer-hard-jump"; tokens: number }
	| { kind: "hard-grace" }
	| { kind: "hard-cap"; tokens: number }
	| { kind: "steer-soft"; tokens: number }
	| { kind: "none" };

type CycleView = Readonly<Pick<CycleState, "phase" | "expectedPath" | "handoffWritten" | "hardGraceUsed">>;

/** What an assistant message_end does to the cycle. */
export function decideMessageEnd(state: CycleView, input: MessageEndInput): MessageEndAction {
	const { tokens, caps } = input;
	// Errored/aborted messages carry no fresh usage (getContextUsage backward-scans
	// past them to the previous real reading). Acting on that stale reading
	// double-fires decisions already taken for it — observed live: an errored
	// message during an emergency cycle bypassed the grace gate (stopReason ≠
	// "toolUse") and wiped via the no-file backstop while the handoff was still
	// perfectly reachable. Skip; pi retries or settles, and the next real message
	// re-evaluates.
	if (isFailedStop(input.stopReason)) return { kind: "skip", reason: "failed-stop" };
	if (tokens == null) return { kind: "skip", reason: "no-usage" }; // never trigger blind
	if (caps.disabled) return { kind: "skip", reason: "cap-disabled" }; // warned once by the resolver

	// Fresh-window guard: mid-cycle but the context shrank far below the soft
	// trigger — a swap/compaction raced a network error, or the steer was
	// dropped (ESC clears extension-queued messages silently) and work resumed
	// fresh. The demand this cycle rides on no longer applies; without the
	// reset, turn-end verification keeps demanding a handoff from a window
	// that is nowhere near the cap. Terminal: resolveTriggers guarantees
	// soft < hard for an enabled cap, so tokens < soft/2 reaches neither cap below.
	if (state.phase !== "idle" && tokens < caps.soft / 2) return { kind: "reset-shrunk", tokens };

	if (tokens >= caps.hard) return decideHardCrossing(state, input.stopReason, tokens);
	return decideSoftCrossing(state, input.stopReason, tokens, caps);
}

function decideHardCrossing(state: CycleView, stopReason: string | undefined, tokens: number): MessageEndAction {
	// One-jump crossing: no cycle in flight (the soft steer never fired — the
	// PREVIOUS message was below the soft cap) and this message ends in tool
	// calls, so another turn is guaranteed. Wiping now would discard a context
	// that never saw a warning (observed live 2026-08-11: explorer grep of a
	// .js.map jumped 36k → 377k). Steer an immediate handoff instead; the
	// grace below protects the message carrying the tool call, and an agent
	// that ignores this steer still meets the backstop one grace turn later.
	if (state.phase === "idle" && stopReason === "toolUse") return { kind: "steer-hard-jump", tokens };
	// Grace turn: a handoff cycle is in flight and this message ends in tool
	// calls — message_end fires BEFORE tools execute, so swapping now would
	// scrub away the handoff write itself (observed live). Let the tools run
	// once; turn_end or the next message_end re-checks. One-shot per cycle so
	// an agent that ignores the handoff can't defer the hard cap forever.
	if (graceApplies(state, stopReason)) return { kind: "hard-grace" };
	return { kind: "hard-cap", tokens };
}

function graceApplies(state: CycleView, stopReason: string | undefined): boolean {
	const demanded = state.phase === "steered" || state.phase === "prompted";
	return demanded && stopReason === "toolUse" && !!state.expectedPath && !state.handoffWritten && !state.hardGraceUsed;
}

function decideSoftCrossing(
	state: CycleView,
	stopReason: string | undefined,
	tokens: number,
	caps: CapsView,
): MessageEndAction {
	// Soft steer: only when another turn is guaranteed (mid-tool-use), so the
	// warning is seen while there is still budget to act on it. A crossing
	// message without tool calls is turn_end's silent-stop case.
	if (tokens >= caps.soft && state.phase === "idle" && stopReason === "toolUse") {
		return { kind: "steer-soft", tokens };
	}
	return { kind: "none" };
}

/**
 * The hard-cap backstop's document when neither a fresh agent handoff nor a
 * machine-drafted one exists: `fallback` is the fresh path or, failing that, the
 * latest older file of this session (substituted ⇒ stale).
 */
export function hardFallbackSwap(
	fresh: string | undefined,
	fallback: string | undefined,
): { stale: boolean; trigger: SwapTrigger } {
	return { stale: !fresh && fallback !== undefined, trigger: fallback ? "hard" : "hard-no-file" };
}

// ---------------------------------------------------------------------------
// turn_end
// ---------------------------------------------------------------------------

export interface TurnGateInput {
	/** The turn's assistant message stopReason. */
	stopReason: string | undefined;
	/** turn_end `outcome`. */
	outcome: string | undefined;
	/** ctx.signal?.aborted */
	aborted: boolean;
	/** The turn's assistant message object (identity-compared with the staged swap's source). */
	message: unknown;
}

export type TurnGateAction =
	| { kind: "skip-failed" }
	| { kind: "discard-stale-staged" }
	| { kind: "commit-staged" }
	| { kind: "evaluate" };

/**
 * First half of turn_end, decided BEFORE usage/caps are read (reading them has
 * side effects: the resolver remembers the window and may notify): failed turns
 * and staged swaps. Every action but "evaluate" ends the handler.
 */
export function decideTurnGate(state: Readonly<Pick<CycleState, "stagedSwap">>, input: TurnGateInput): TurnGateAction {
	// Errored/aborted turns never reached the agent (the message is synthetic,
	// toolResults always []). Treating them as refusals burned reminder retries
	// during network flakes — two blips flipped the cycle to "exhausted" with
	// the agent never having seen one reminder — and queuing a reminder into an
	// aborted run un-aborted it via pi's queued-message rescue (continue()).
	// Skip; the cycle stays armed and the next real turn re-evaluates. A hard swap
	// may already be staged from this turn's message_end: drop only that draft —
	// the armed cycle and any written handoff remain usable.
	if (isFailedStop(input.stopReason) || isFailedStop(input.outcome) || input.aborted) return { kind: "skip-failed" };
	if (!state.stagedSwap) return { kind: "evaluate" };
	// Hard-cap paths run in message_end, before tools execute. Commit only for
	// their own turn: a delayed boundary must never apply another assistant's
	// destructive marker. The active cycle stays armed after a stale discard.
	if (state.stagedSwap.sourceMessage !== input.message) return { kind: "discard-stale-staged" };
	return { kind: "commit-staged" };
}

export interface TurnEndInput {
	/** ctx.getContextUsage()?.tokens */
	tokens: number | null | undefined;
	/** The turn executed tool calls (toolResults non-empty). */
	hasToolCalls: boolean;
	caps: CapsView;
}

export type TurnEndAction =
	| { kind: "swap-soft"; path: string }
	| { kind: "keep-waiting" }
	| { kind: "remind"; attempt: number }
	| { kind: "exhaust" }
	| { kind: "silent-stop"; tokens: number }
	| { kind: "none" };

/** Second half of turn_end (no staged swap, turn not failed): verification, then silent stop. */
export function decideTurnEnd(
	state: Readonly<Pick<CycleState, "phase" | "expectedPath" | "handoffWritten" | "retries">>,
	input: TurnEndInput,
): TurnEndAction {
	// Verification (both steer and silent-stop paths): swap as soon as the file
	// exists. Runs even when the cap is disabled — a handoff already demanded
	// must be collected.
	if (state.phase !== "idle" && state.expectedPath) {
		return decideVerification({ ...state, expectedPath: state.expectedPath }, input.hasToolCalls);
	}
	// Silent-stop fallback: crossed soft cap but the crossing turn ended without
	// tool calls, so the steer gate never fired — the agent saw no warning.
	const { tokens, caps } = input;
	if (state.phase === "idle" && !input.hasToolCalls && crossedSoftCap(tokens, caps)) {
		return { kind: "silent-stop", tokens };
	}
	return { kind: "none" };
}

function crossedSoftCap(tokens: number | null | undefined, caps: CapsView): tokens is number {
	return !caps.disabled && tokens != null && tokens >= caps.soft;
}

function decideVerification(
	state: Readonly<Pick<CycleState, "phase" | "handoffWritten" | "retries">> & { expectedPath: string },
	hasToolCalls: boolean,
): TurnEndAction {
	if (state.handoffWritten) return { kind: "swap-soft", path: state.expectedPath };
	if (state.phase === "exhausted" || hasToolCalls) return { kind: "keep-waiting" }; // still working / already gave up
	if (state.retries < MAX_RETRIES) return { kind: "remind", attempt: state.retries + 1 };
	return { kind: "exhaust" };
}
