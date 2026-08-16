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

/** Soft context cap (tokens) — context-cap.ts's steer trigger; child-session.ts
 * shows it in the F2 watch footer. Resolved at import time. */
export const CONTEXT_CAP_SOFT_TRIGGER = envInt("CONTEXT_CAP_SOFT", 260_000);

/**
 * Hard context cap (tokens) — context-cap.ts's backstop, where it spends one LLM
 * call writing the handoff itself. Held at 1.25× the soft cap: the gap is the room
 * the agent has to finish its unit of work and write a handoff after the soft
 * steer, and the backstop still leaves most of a ~1M window for that last call.
 */
export const CONTEXT_CAP_HARD_TRIGGER = envInt("CONTEXT_CAP_HARD", 325_000);

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
