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

/** Soft context cap (tokens) — context-cap.ts's steer trigger; child-session.ts
 * shows it in the F2 watch footer. Resolved at import time. */
export const CONTEXT_CAP_SOFT_TRIGGER = envInt("CONTEXT_CAP_SOFT", 160_000);

/** Tool name registered by context-cap.ts; child-session.ts and explore.ts reference it. */
export const CONTEXT_CAP_TOOL_NAME = "context_handoff";

/** ctx.ui.setStatus key used by context-cap.ts; child-session.ts fakes it in the child footer. */
export const CONTEXT_CAP_STATUS_KEY = "context-cap";
