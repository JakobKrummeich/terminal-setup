// The F2 view's `⇄ handoff i/N` divider: the one line ChildView (lib/child-view.ts)
// puts in front of every context-cap swap marker. Split out of child-view.ts to
// keep that hot file under the 300-line gate; the divider has no other user.
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "./format.ts";
import type { SwapTrigger } from "./message-types.ts";

/** Human label of each swap trigger. Typed per SwapTrigger: a new trigger without a label is a compile error. */
const TRIGGER_LABELS: Record<SwapTrigger, string> = {
	soft: "soft cap",
	hard: "hard cap",
	"hard-no-file": "hard cap, no handoff file",
};

/** The swap-marker `details` fields the divider shows (lib/context-cap-swap.ts stageSwap). */
export interface HandoffDetails {
	tokensAtSwap?: unknown;
	trigger?: unknown;
}

/** Label of a swap marker's `trigger` detail. */
function triggerLabel(trigger: unknown): string | undefined {
	// details come from disk: an unknown string (older/newer writer) must yield undefined, not throw.
	return typeof trigger === "string" && Object.hasOwn(TRIGGER_LABELS, trigger)
		? TRIGGER_LABELS[trigger as SwapTrigger]
		: undefined;
}

/**
 * Divider text for handoff `index` of `total`, `─`-padded (or truncated) to `width`:
 * `── ⇄ handoff 2/3 · at 162k tokens · soft cap ─────…`. Parts whose detail is
 * missing are omitted.
 */
export function handoffDividerText(
	index: number,
	total: number,
	details: HandoffDetails | undefined,
	width: number,
): string {
	const parts = [`\u21c4 handoff ${index}/${total}`];
	if (typeof details?.tokensAtSwap === "number") parts.push(`at ${formatTokenCount(details.tokensAtSwap)} tokens`);
	const trigger = triggerLabel(details?.trigger);
	if (trigger) parts.push(trigger);
	const label = `\u2500\u2500 ${parts.join(" \u00b7 ")} `;
	const fill = width - visibleWidth(label);
	return fill >= 0 ? label + "\u2500".repeat(fill) : truncateToWidth(label, width, "");
}

/**
 * One-line divider in front of a context-cap swap marker's block. `index`
 * (1-based) is fixed at creation; the total is read at render time because a
 * live run keeps adding handoffs. ChildView.render records its line as an anchor.
 */
export class HandoffDivider implements Component {
	private readonly index: number;
	private readonly total: () => number;
	private readonly details: HandoffDetails | undefined;
	constructor(index: number, total: () => number, details: HandoffDetails | undefined) {
		this.index = index;
		this.total = total;
		this.details = details;
	}
	render(width: number): string[] {
		return [getMarkdownTheme().heading(handoffDividerText(this.index, this.total(), this.details, width))];
	}
	invalidate() {}
}
