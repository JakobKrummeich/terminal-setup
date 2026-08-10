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

/** Soft context cap (tokens) — context-cap.ts's steer trigger; child-session.ts
 * shows it in the F2 watch footer. Resolved at import time. */
export const CONTEXT_CAP_SOFT_TRIGGER = envInt("CONTEXT_CAP_SOFT", 160_000);

/** Tool name registered by context-cap.ts; child-session.ts and explore.ts reference it. */
export const CONTEXT_CAP_TOOL_NAME = "context_handoff";

/** ctx.ui.setStatus key used by context-cap.ts; child-session.ts fakes it in the child footer. */
export const CONTEXT_CAP_STATUS_KEY = "context-cap";
