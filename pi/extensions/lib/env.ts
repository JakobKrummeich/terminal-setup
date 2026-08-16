// Env-var config helpers shared across extension files.
//
// jiti caveat (see AGENTS.md): each top-level extension gets its own module copy
// of this file, so only pure values/functions belong here — no shared state.

/** Parse a positive-integer env var, falling back on unset/garbage values. */
export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Like envInt, but distinguishes "explicitly set" from "defaulted": returns null
 * when the var is unset OR garbage. Needed by resolveTriggers below, where an
 * explicit value must win over the dynamic computation and a defaulted one must
 * not. envInt cannot express that (its callers want a number, always), so this is
 * a second function rather than a signature change.
 */
export function envIntOrNull(name: string): number | null {
	const raw = process.env[name];
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a boolean env var. Unset/garbage falls back. Read at CALL time by
 * callers that want a switch to be flippable without editing code (and
 * togglable per test); constants above are resolved at import time instead.
 */
export function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["0", "false", "off", "no"].includes(raw)) return false;
	if (["1", "true", "on", "yes"].includes(raw)) return true;
	return fallback;
}

/**
 * Parse an enum env var (case-insensitive). Unset/unknown values fall back.
 * Resolved by callers at import time, like the constants below.
 */
export function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
	const raw = process.env[name]?.trim().toLowerCase() ?? "";
	return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Soft context cap (tokens) — the CEILING on context-cap.ts's steer trigger, and
 * the static fallback when the model's context window is unknown. child-session.ts
 * shows it in the F2 watch footer. Resolved at import time; the trigger actually in
 * force is resolveTriggers() below, which is model-aware and resolved per check. */
export const CONTEXT_CAP_SOFT_TRIGGER = envInt("CONTEXT_CAP_SOFT", 260_000);

/**
 * Hard context cap (tokens) — the CEILING on context-cap.ts's backstop (where it
 * spends one LLM call writing the handoff itself), and the static fallback when the
 * context window is unknown. Held at 1.25× the soft cap: the gap is the room the
 * agent has to finish its unit of work and write a handoff after the soft steer,
 * and the backstop still leaves most of a ~1M window for that last call.
 */
export const CONTEXT_CAP_HARD_TRIGGER = envInt("CONTEXT_CAP_HARD", 325_000);

// ---------------------------------------------------------------------------
// Model-aware trigger resolution
// ---------------------------------------------------------------------------

/**
 * Tokens pi keeps in reserve above its OWN auto-compaction threshold: it compacts
 * at `contextWindow - reserveTokens` (pi-coding-agent compaction.js, default
 * reserveTokens 16384). Our caps must sit below that or pi compacts first and the
 * whole extension is dead weight — which is exactly what a fixed 325k hard cap did
 * on any model with a 200k window.
 */
export const CONTEXT_CAP_RESERVE_TOKENS = 16_384;

/** Where the values in force came from. See resolveTriggers for the precedence. */
export type TriggerSource = "env" | "dynamic" | "fallback";

export interface ResolvedTriggers {
	/** Soft (steer) trigger in tokens. POSITIVE_INFINITY when `disabled`. */
	soft: number;
	/** Hard (backstop) trigger in tokens. POSITIVE_INFINITY when `disabled`. */
	hard: number;
	/** "env" only when BOTH came straight from env; "fallback" when either used the static default. */
	source: TriggerSource;
	/** The context window the pair was derived from; null when it was unknown. */
	contextWindow: number | null;
	/** Window too small to place a cap below pi's compaction: do not fire at all. */
	disabled: boolean;
	/** Soft was >= hard (only reachable via an explicit env soft) and got pulled to hard-1. */
	clamped: boolean;
}

/**
 * Hard sits at 90% of the ceiling, soft at 80% of hard. Integer multiplication
 * first: `0.9 * n` in binary floats can land a hair either side of the true value
 * and flip the floor by one token.
 */
function hardOfCeiling(ceiling: number): number {
	return Math.min(CONTEXT_CAP_HARD_TRIGGER, Math.floor((ceiling * 9) / 10));
}
function softOfHard(hard: number): number {
	return Math.min(CONTEXT_CAP_SOFT_TRIGGER, Math.floor((hard * 8) / 10));
}

/**
 * Resolve the soft/hard triggers for one check, given the model's context window.
 *
 *   ceiling = contextWindow - CONTEXT_CAP_RESERVE_TOKENS   (pi's own compact point)
 *   hard    = min(CONTEXT_CAP_HARD_TRIGGER, floor(0.90 * ceiling))
 *   soft    = min(CONTEXT_CAP_SOFT_TRIGGER, floor(0.80 * hard))
 *
 * PURE and cheap — call it per check, never cache it: the model (and with it the
 * window) can change mid-session and pi exposes no model-switch event.
 *
 * Precedence, per value independently:
 *  - an explicit env var (CONTEXT_CAP_SOFT / CONTEXT_CAP_HARD) wins outright, no
 *    dynamic computation for that value — including when only one of the two is set;
 *  - otherwise it is derived as above. Note soft derives from the RESOLVED hard, so
 *    an env-only hard still yields a proportional soft;
 *  - if the window is unknown, hard falls back to the static 325k, which makes soft
 *    fall out as the static 260k — the pre-model-awareness behaviour.
 *
 * Sanity: soft >= hard would mean the steer never gets a turn before the backstop,
 * so soft is clamped to hard-1 and `clamped` is set (the caller logs it).
 * Degenerate windows (ceiling <= 0, or a hard that lands at/below 1) cannot carry a
 * cap at all: `disabled` is set and both triggers are +Infinity, so a caller that
 * forgets to check `disabled` still cannot fire.
 */
export function resolveTriggers(contextWindow: number | null | undefined): ResolvedTriggers {
	const envSoft = envIntOrNull("CONTEXT_CAP_SOFT");
	const envHard = envIntOrNull("CONTEXT_CAP_HARD");
	const window =
		contextWindow != null && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : null;
	const off: ResolvedTriggers = {
		soft: Number.POSITIVE_INFINITY,
		hard: Number.POSITIVE_INFINITY,
		source: envSoft != null && envHard != null ? "env" : window != null ? "dynamic" : "fallback",
		contextWindow: window,
		disabled: true,
		clamped: false,
	};

	let hard: number;
	let hardSource: TriggerSource;
	if (envHard != null) {
		hard = envHard;
		hardSource = "env";
	} else if (window != null) {
		const ceiling = window - CONTEXT_CAP_RESERVE_TOKENS;
		if (ceiling <= 0) return off; // window smaller than pi's reserve
		hard = hardOfCeiling(ceiling);
		hardSource = "dynamic";
	} else {
		hard = CONTEXT_CAP_HARD_TRIGGER;
		hardSource = "fallback";
	}
	if (hard <= 1) return off; // no room to place a soft trigger underneath

	let soft = envSoft ?? softOfHard(hard);
	const softSource: TriggerSource = envSoft != null ? "env" : hardSource === "env" ? "dynamic" : hardSource;
	let clamped = false;
	if (soft >= hard) {
		soft = hard - 1;
		clamped = true;
	}
	if (soft <= 0) return off;

	const source: TriggerSource =
		softSource === "env" && hardSource === "env"
			? "env"
			: softSource === "fallback" || hardSource === "fallback"
				? "fallback"
				: "dynamic";
	return { soft, hard, source, contextWindow: window, disabled: false, clamped };
}

/**
 * Handoff document schema — A/B lever, CONTEXT_CAP_SCHEMA:
 *  v1 — the original five-section shape (~30 lines). Frozen: it is the control.
 *  v2 — path-heavy operational shape (~60 lines) whose "Files" section names
 *       every path that still matters. Forensics over 72 real swaps found
 *       successors re-reading files the handoff never mentioned (path recall
 *       0.17; a "key file paths" section present in only 19/72 documents).
 *
 * SELECTED HERE AND NOWHERE ELSE. lib/handoff-writer.ts owns the section text;
 * every consumer (the `context_handoff` tool spec, the agent-facing instruction
 * text, the machine writer's prompt) resolves it from this one constant, so the
 * three can never drift apart.
 */
export type HandoffSchema = "v1" | "v2";
export const HANDOFF_SCHEMAS: readonly HandoffSchema[] = ["v1", "v2"];
export const CONTEXT_CAP_SCHEMA: HandoffSchema = envEnum("CONTEXT_CAP_SCHEMA", HANDOFF_SCHEMAS, "v2");

/**
 * Recency tail — A/B lever, CONTEXT_CAP_TAIL_TOKENS: estimated tokens of raw
 * transcript kept in front of the swapped-in handoff. 0 (default) = the
 * pre-lever behaviour, i.e. the successor sees the handoff and nothing else.
 */
export const CONTEXT_CAP_TAIL_TOKENS = envInt("CONTEXT_CAP_TAIL_TOKENS", 0);

/** Tool name registered by context-cap.ts; child-session.ts and explore.ts reference it. */
export const CONTEXT_CAP_TOOL_NAME = "context_handoff";

/** ctx.ui.setStatus key used by context-cap.ts; child-session.ts fakes it in the child footer. */
export const CONTEXT_CAP_STATUS_KEY = "context-cap";
