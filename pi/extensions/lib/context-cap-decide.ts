/**
 * context-cap state machine, pure half: the per-cycle state and the decisions
 * the `message_end` / `turn_end` handlers of context-cap.ts and the /handoff
 * command (lib/context-cap-manual.ts) take on it.
 *
 * Every function here maps (state, observed input) → an action tag; the
 * handlers gather the input, call one decide function and run the action's side
 * effects (notify, status, demand/reminder boundary entries, staging/committing
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

/** Reminders sent after a demand the agent did not act on. */
export const MAX_RETRIES = 2;

/**
 * idle      — no handoff demanded (a hard-cap backstop may still have armed a path; see CycleState)
 * pending   — demand decided, its entry not committed yet (`demandAt` says where it will be);
 *             the tool refuses until then — a call in the very message that crossed the cap
 *             was made without the agent ever seeing a demand
 * demanded  — demand entry committed; the tool records the document
 * exhausted — reminders used up; only the hard-cap backstop (or a later tool call) is left
 */
export type Phase = "idle" | "pending" | "demanded" | "exhausted";

/**
 * What opened the cycle. Picks the demand/reminder wording (lib/context-cap-messages.ts).
 * "hard" = armed by the hard-cap backstop alone: no demand, no reminders.
 */
export type CycleOrigin = "manual" | "soft" | "silent" | "hard-jump" | "hard";

/**
 * How the cycle ends: `swap` (cap origins) commits the swap marker and the agent
 * continues in a scrubbed window; `new-session` (/handoff) hands the document to the
 * waiting command, which seeds a fresh session with it and leaves the user in charge.
 */
export type CycleEnding = "swap" | "new-session";

/**
 * Where a pending demand is committed as a boundary entry: the imminent turn_end
 * (cap crossings — the point pi drained steers at, so the soft-cap leeway is
 * unchanged) or agent_before_settle (/handoff typed mid-run: the run finishes first).
 */
export type DemandPoint = "turn_end" | "settle";

/** Who wrote the handoff document: the agent via the tool, or the writer LLM call. */
export type HandoffAuthor = "agent" | "machine";

/** This cycle's handoff document — the ONLY source for the successor text of both endings. */
export interface RecordedDoc {
	/** As written to the file (frontmatter stripped, trimmed). */
	body: string;
	author: HandoffAuthor;
}

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

/** Successor text prepared during message_end (hard-cap backstop), delivered at the imminent turn_end. */
export interface StagedSwap {
	/** Preamble + document (or the no-file note) — no "Continue your work." suffix. */
	summary: string;
	/** The swap ending appends "Continue your work." (documents only; the no-file note asks the user instead). */
	continueSuffix: boolean;
	details: SwapDetails;
	swapCaps: ResolvedTriggers;
	/** Exact assistant object whose message_end prepared this marker. */
	sourceMessage: unknown;
}

/**
 * One handoff cycle. Lifecycle:
 *  - `idleCycle()` on session_start, after every committed swap or new-session
 *    hand-over, after a failed handoff-file read, after a failed /handoff, and when
 *    the window shrank mid-cycle (reset-shrunk).
 *  - startCycle (lib/context-cap-session.ts) arms it: seq/expectedPath/retries/
 *    tokensAtTrigger/doc/cycleCaps — the caller then sets origin/phase/demandAt.
 *    The hard-cap backstop can arm a cycle while `phase` stays "idle".
 *  - a second trigger never opens a second cycle: /handoff switches `ending` to
 *    "new-session" (lib/context-cap-manual.ts); a cap crossing during a /handoff
 *    cycle at most moves its pending demand forward (`advance-demand`).
 *  - the `context_handoff` tool sets `doc`; turn_end then ends the cycle.
 * The whole object is replaced on reset, never patched field by field — so no
 * field can survive a reset by accident.
 */
export interface CycleState {
	phase: Phase;
	/** null while no cycle is armed. */
	origin: CycleOrigin | null;
	ending: CycleEnding;
	/** Meaningful while phase is "pending". */
	demandAt: DemandPoint;
	/** Where this cycle's handoff goes (<agent dir>/context-cap/<sessionId>-<seq>.md); set ⇔ cycle armed. */
	expectedPath: string | undefined;
	seq: number;
	/** Reminders sent so far in this cycle (≤ MAX_RETRIES). */
	retries: number;
	/** Token reading that started the cycle (updated by the hard cap) — the marker's tokensAtSwap. */
	tokensAtTrigger: number;
	/** Set by the tool (or the machine writer) once the handoff file is on disk. */
	doc: RecordedDoc | null;
	/** One-shot grace so the hard cap doesn't swap away the message carrying the tool call. */
	hardGraceUsed: boolean;
	/**
	 * The pair in force when the current cycle started — what the demand quoted,
	 * and therefore what the marker/frontmatter must record. Deliberately NOT
	 * re-resolved at swap time: the forensic question is "what fired this".
	 */
	cycleCaps: ResolvedTriggers | null;
	/** Successor text prepared during message_end and delivered at the imminent turn_end boundary. */
	stagedSwap: StagedSwap | null;
}

export function idleCycle(): CycleState {
	return {
		phase: "idle",
		origin: null,
		ending: "swap",
		demandAt: "turn_end",
		expectedPath: undefined,
		seq: 0,
		retries: 0,
		tokensAtTrigger: 0,
		doc: null,
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

/**
 * The context reading for an assistant message_end: this message's provider
 * usage, else `fallback` (ctx.getContextUsage()). Pi persists the assistant
 * after message_end listeners, so the fallback can still describe the previous
 * reading — fresh usage wins when it exists. Failed stops never carry fresh
 * usage: an ESC-aborted (or errored) message is synthesized with zeroed usage,
 * and trusting it flashed the footer to 0 until the next request. Pi's own
 * getContextUsage() skips those messages too, so use the fallback for them.
 */
export function messageEndTokens(
	stopReason: string | undefined,
	messageTokens: unknown,
	fallback: number | null | undefined,
): number | null | undefined {
	if (isFailedStop(stopReason)) return fallback;
	return typeof messageTokens === "number" && Number.isFinite(messageTokens) ? messageTokens : fallback;
}

// ---------------------------------------------------------------------------
// message_end
// ---------------------------------------------------------------------------

export interface MessageEndInput {
	/** The assistant message's stopReason ("toolUse" ⇒ another turn is guaranteed). */
	stopReason: string | undefined;
	/** This message's context reading (messageEndTokens); null/undefined = unknown. */
	tokens: number | null | undefined;
	caps: CapsView;
}

export type MessageEndAction =
	| { kind: "skip"; reason: "failed-stop" | "no-usage" | "cap-disabled" }
	| { kind: "reset-shrunk"; tokens: number }
	/** Open a cap cycle; its demand entry is committed at this turn's turn_end. */
	| { kind: "demand"; origin: "soft" | "hard-jump"; tokens: number }
	/** A /handoff demand waiting for the run to settle is committed at this turn's turn_end instead. */
	| { kind: "advance-demand"; tokens: number }
	| { kind: "hard-grace" }
	| { kind: "hard-cap"; tokens: number }
	| { kind: "none" };

type CycleView = Readonly<
	Pick<CycleState, "phase" | "origin" | "demandAt" | "expectedPath" | "doc" | "hardGraceUsed">
>;

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
	if (shrunkMidCycle(state, tokens, caps)) return { kind: "reset-shrunk", tokens };
	if (tokens >= caps.hard) return decideHardCrossing(state, input.stopReason, tokens);
	return decideSoftCrossing(state, input.stopReason, tokens, caps);
}

/**
 * Fresh-window guard: mid-cycle but the context shrank far below the soft
 * trigger — a swap/compaction raced a network error, and work resumed fresh.
 * The cap demand this cycle rides on no longer applies; without the reset,
 * turn-end verification keeps demanding a handoff from a window that is nowhere
 * near the cap. Terminal: resolveTriggers guarantees soft < hard for an enabled
 * cap, so tokens < soft/2 reaches neither cap below. A /handoff cycle is exempt:
 * the user asks for it at any size.
 */
function shrunkMidCycle(state: CycleView, tokens: number, caps: CapsView): boolean {
	return state.phase !== "idle" && state.origin !== "manual" && tokens < caps.soft / 2;
}

function decideHardCrossing(state: CycleView, stopReason: string | undefined, tokens: number): MessageEndAction {
	// One-jump crossing: no demand in flight (the soft demand never fired — the
	// PREVIOUS message was below the soft cap) and this message ends in tool
	// calls, so another turn is guaranteed. Wiping now would discard a context
	// that never saw a warning (observed live 2026-08-11: explorer grep of a
	// .js.map jumped 36k → 377k). Demand an immediate handoff instead; the
	// grace below protects the message carrying the tool call, and an agent
	// that ignores the demand still meets the backstop one grace turn later.
	const demand = stopReason === "toolUse" ? demandOnCrossing(state, "hard-jump", tokens) : undefined;
	if (demand) return demand;
	// Grace turn: a demand is out and this message ends in tool calls —
	// message_end fires BEFORE tools execute, so swapping now would scrub away
	// the handoff write itself (observed live). Let the tools run once; turn_end
	// or the next message_end re-checks. One-shot per cycle so an agent that
	// ignores the handoff can't defer the hard cap forever.
	if (graceApplies(state, stopReason)) return { kind: "hard-grace" };
	return { kind: "hard-cap", tokens };
}

/**
 * A cap crossing that would demand a handoff: opens a cap cycle when none is
 * armed. A /handoff demand still waiting for the run to settle is the same
 * demand — it moves forward to this turn instead of a second one being sent
 * (waiting for the settle could otherwise run the window into the hard cap).
 */
function demandOnCrossing(
	state: CycleView,
	origin: "soft" | "hard-jump",
	tokens: number,
): MessageEndAction | undefined {
	if (state.phase === "idle") return { kind: "demand", origin, tokens };
	if (state.phase === "pending" && state.demandAt === "settle") return { kind: "advance-demand", tokens };
	return undefined;
}

function graceApplies(state: CycleView, stopReason: string | undefined): boolean {
	return state.phase === "demanded" && stopReason === "toolUse" && !!state.expectedPath && !state.doc && !state.hardGraceUsed;
}

function decideSoftCrossing(
	state: CycleView,
	stopReason: string | undefined,
	tokens: number,
	caps: CapsView,
): MessageEndAction {
	// Soft demand: only when another turn is guaranteed (mid-tool-use), so the
	// demand is seen while there is still budget to act on it. A crossing
	// message without tool calls is turn_end's silent-stop case.
	if (tokens >= caps.soft && stopReason === "toolUse") return demandOnCrossing(state, "soft", tokens) ?? { kind: "none" };
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
	| { kind: "commit-demand" }
	| { kind: "collect"; path: string }
	| { kind: "keep-waiting" }
	| { kind: "remind"; attempt: number }
	| { kind: "exhaust" }
	| { kind: "silent-stop"; tokens: number }
	| { kind: "none" };

/** Second half of turn_end (no staged swap, turn not failed): demand delivery, verification, then silent stop. */
export function decideTurnEnd(
	state: Readonly<Pick<CycleState, "phase" | "demandAt" | "expectedPath" | "doc" | "retries">>,
	input: TurnEndInput,
): TurnEndAction {
	// A demand decided at this turn's message_end goes out now — the boundary
	// where pi drained steers, so the soft-cap leeway is what it always was.
	if (state.phase === "pending") return state.demandAt === "turn_end" ? { kind: "commit-demand" } : { kind: "none" };
	// Verification: end the cycle as soon as the document is recorded. Runs
	// even when the cap is disabled — a handoff already demanded must be collected.
	if (state.phase !== "idle" && state.expectedPath) {
		return decideVerification({ ...state, expectedPath: state.expectedPath }, input.hasToolCalls);
	}
	return state.phase === "idle" ? decideSilentStop(input) : { kind: "none" };
}

/**
 * Silent-stop fallback (no cycle armed): crossed soft cap but the crossing turn
 * ended without tool calls, so message_end never demanded — the agent saw no warning.
 */
function decideSilentStop({ tokens, caps, hasToolCalls }: TurnEndInput): TurnEndAction {
	return !hasToolCalls && crossedSoftCap(tokens, caps) ? { kind: "silent-stop", tokens } : { kind: "none" };
}

function crossedSoftCap(tokens: number | null | undefined, caps: CapsView): tokens is number {
	return !caps.disabled && tokens != null && tokens >= caps.soft;
}

function decideVerification(
	state: Readonly<Pick<CycleState, "phase" | "doc" | "retries">> & { expectedPath: string },
	hasToolCalls: boolean,
): TurnEndAction {
	if (state.doc) return { kind: "collect", path: state.expectedPath };
	if (state.phase === "exhausted" || hasToolCalls) return { kind: "keep-waiting" }; // still working / already gave up
	if (state.retries < MAX_RETRIES) return { kind: "remind", attempt: state.retries + 1 };
	return { kind: "exhaust" };
}

// ---------------------------------------------------------------------------
// /handoff
// ---------------------------------------------------------------------------

export type ManualAction =
	/** The document is already recorded and nothing runs: hand it over now. */
	| { kind: "finish" }
	/** A run is in flight with a demand out (or a document on its way to turn_end): only the ending changes. */
	| { kind: "join" }
	/** Nothing runs: start a run with the /handoff demand. `open` = arm a fresh cycle first. */
	| { kind: "demand-now"; open: boolean }
	/** A run is in flight and no live demand is out: demand once it settles. */
	| { kind: "demand-at-settle"; open: boolean };

/**
 * What /handoff does to the cycle (one cycle, never two demands in one run). The
 * ending always becomes "new-session". Nothing is ever queued: while idle the
 * demand starts a run directly; mid-run it waits for agent_before_settle.
 * An exhausted cycle, or an armed one left behind by an aborted run, has no live
 * demand any more, so it gets the /handoff demand — otherwise nothing would ever
 * produce the document the command waits for.
 */
export function decideManual(
	state: Readonly<Pick<CycleState, "phase" | "doc" | "stagedSwap">>,
	idle: boolean,
): ManualAction {
	if (state.doc || state.stagedSwap) return idle ? { kind: "finish" } : { kind: "join" };
	const open = state.phase === "idle";
	if (idle) return { kind: "demand-now", open };
	if (open || state.phase === "exhausted") return { kind: "demand-at-settle", open };
	return { kind: "join" };
}
