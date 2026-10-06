/**
 * Compact call rows for this repo's tools: bold tool title plus one short,
 * muted summary line — the style of pi's own builtins (`ls <path>`).
 *
 * Why every tool here brings its own: without a `renderCall`, pi prints every
 * argument as `key=value`. For Explore/Agent that is the whole multi-line
 * prompt, for context_handoff the whole handoff — which then shows up twice in
 * the F2 view (call row + swap marker).
 *
 * Registered as a tool renderer resolver (`registerCompactCallRenderer`), not
 * as `renderCall` on the tool definition: a resolver also draws calls to tools
 * that are not registered — so explore.ts/subagent.ts register theirs before
 * their kill switch, and a resumed session still draws the old calls
 * compactly. The F2 view resolves through the child's resolvers the same way
 * (lib/child-view.ts).
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Longest summary shown on a call row, in characters (ellipsis included). */
export const CALL_SUMMARY_MAX = 60;

/** Whitespace-collapsed, single-line, truncated to `max` characters with `…`. */
export function oneLine(text: string, max = CALL_SUMMARY_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `<title> <summary>` as a Text; reuses the slot's previous component like pi's builtins. */
export function renderCompactCall(
	title: string,
	summary: string,
	theme: Pick<Theme, "fg" | "bold">,
	context: { lastComponent?: unknown },
): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const head = theme.fg("toolTitle", theme.bold(title));
	const line = oneLine(summary);
	component.setText(line ? `${head} ${theme.fg("muted", line)}` : head);
	return component;
}

/**
 * Draw calls to `toolName` as a compact row. Everything else comes from `next()`
 * (the remaining resolvers, then the registered tool — e.g. Explore's
 * renderResult), and a renderCall found there wins: this only fills in, so
 * another extension's tool that happens to share the name keeps its own row.
 */
export function registerCompactCallRenderer<Args>(
	pi: Pick<ExtensionAPI, "registerToolRenderer">,
	toolName: string,
	summary: (args: Args | undefined) => string,
): void {
	// A resolver sees calls by name only, so pi types their args `unknown`; every
	// summary here reads its fields defensively (args may be partial while streaming).
	const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) =>
		renderCompactCall(toolName, summary(args as Args | undefined), theme, context);
	pi.registerToolRenderer((name, next) => {
		if (name !== toolName) return next();
		const base = next();
		return { ...base, renderCall: base?.renderCall ?? renderCall };
	});
}

/** Arguments of a child-session tool call (Explore/Agent), possibly still streaming. */
export interface ChildCallArgs {
	prompt?: unknown;
	description?: unknown;
	resume_id?: unknown;
}

/**
 * Summary for Explore/Agent: the description label, else the prompt's start;
 * `↻ <id>` marks a resume. Args may be partial while the call streams.
 */
export function childCallSummary(args: ChildCallArgs | undefined): string {
	const label = str(args?.description) || str(args?.prompt);
	const resume = str(args?.resume_id);
	return resume ? `↻ ${resume}${label ? ` · ${label}` : ""}` : label;
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
