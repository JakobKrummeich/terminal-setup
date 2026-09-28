/**
 * Token-count formatting shared by the main footer (context-cap.ts) and the F2
 * watch (child footer, picker rows, handoff dividers) — one format everywhere.
 * Pi-free on purpose: pure string functions, importable from any extension or test.
 */

/**
 * `950`, `162k`, `1.0M`. Non-finite → `off`: a disabled cap is +Infinity
 * (lib/env.ts ResolvedTriggers). The M threshold is 999_500, not 1_000_000, so a
 * count that would round up to `1000k` is shown as `1.0M` instead.
 */
export function formatTokenCount(count: number): string {
	if (!Number.isFinite(count)) return "off";
	if (count >= 999_500) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}k`;
	return String(count);
}

/**
 * The context-cap footer status: `<tokens>/<soft cap><suffix>`, `?` for unknown
 * usage. Written by context-cap.ts for the main session and rebuilt by
 * lib/child-watch.ts for a watched child (whose context-cap phase is not visible
 * from the parent, so the child footer never carries a suffix).
 */
export function formatCapStatus(tokens: number | null | undefined, softCap: number, suffix = ""): string {
	const used = tokens == null ? "?" : formatTokenCount(tokens);
	return `${used}/${formatTokenCount(softCap)}${suffix}`;
}
