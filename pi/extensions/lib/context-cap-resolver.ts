/**
 * context-cap trigger resolution, per session: the pure lib/env.ts
 * `resolveTriggers` plus the two things one session has to remember — the last
 * context window it actually saw (pi reports none before the first LLM call, and
 * a stale-but-real window beats the static fallback) and which warnings were
 * already shown, so a degenerate window does not notify on every single message.
 *
 * A factory, not module state: jiti hands each extension file its own module copy
 * (AGENTS.md), and tests want one resolver per case (test/context-cap-triggers.test.ts,
 * test/context-cap-resolver.test.ts).
 */

import { contextCapReserveTokens, resolveTriggers, type ResolvedTriggers } from "./env.ts";

/** What a cap check needs from ctx — `ctx.getContextUsage()`'s shape, minimally. */
export type UsageLike = { contextWindow?: number | null } | null | undefined;
export type Notify = (message: string, level: "info" | "warning" | "error") => void;
export type CapResolver = (usage: UsageLike, notify?: Notify) => ResolvedTriggers;

/** The once-per-session warnings, in the order they are checked (and shown). */
type CapWarning = "disabled" | "clamped" | "fallback";

export function createCapResolver(): CapResolver {
	let lastKnownWindow: number | null = null;
	const warned = new Set<CapWarning>();
	return (usage, notify) => {
		const live = liveWindow(usage);
		if (live != null) lastKnownWindow = live;
		const caps = resolveTriggers(live ?? lastKnownWindow);
		warnOnce(warned, caps, notify);
		return caps;
	};
}

/** The window pi reports right now; null when it reports none (or garbage). */
function liveWindow(usage: UsageLike): number | null {
	const observed = usage?.contextWindow;
	return typeof observed === "number" && Number.isFinite(observed) && observed > 0 ? observed : null;
}

/**
 * Show each applicable warning the first time it applies. A warning counts as
 * shown even without a `notify` (the flag is set regardless). Message text is
 * built lazily: the disabled one reads pi's settings file.
 */
function warnOnce(warned: Set<CapWarning>, caps: ResolvedTriggers, notify: Notify | undefined): void {
	const applies: Record<CapWarning, boolean> = {
		disabled: caps.disabled,
		clamped: caps.clamped,
		fallback: caps.source === "fallback",
	};
	for (const warning of ["disabled", "clamped", "fallback"] as const) {
		if (!applies[warning] || warned.has(warning)) continue;
		warned.add(warning);
		notify?.(warningText(warning, caps), warning === "fallback" ? "info" : "warning");
	}
}

function warningText(warning: CapWarning, caps: ResolvedTriggers): string {
	switch (warning) {
		case "disabled":
			return `context-cap: context window ${caps.contextWindow ?? "unknown"} cannot hold a cap below pi's own compaction (reserve ${contextCapReserveTokens()}) — cap disabled`;
		case "clamped":
			return `context-cap: soft cap ≥ hard cap — soft clamped to ${caps.soft} (hard ${caps.hard})`;
		case "fallback":
			return `context-cap: context window unknown — using static caps ${caps.soft}/${caps.hard}`;
	}
}
