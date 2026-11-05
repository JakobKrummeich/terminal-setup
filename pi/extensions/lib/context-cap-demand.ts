/**
 * context-cap, delivering demands: every handoff demand and reminder — cap and
 * /handoff alike — is a custom-message entry (customType HANDOFF_DEMAND_TYPE)
 * committed through a boundary result with `continue: true`, the same atomic
 * path the swap marker takes (lib/context-cap-swap.ts). Never through pi's
 * steer/followUp queues, which caused three defects:
 *  - ESC hands every queued message back to the user's editor
 *    (interactive-mode restoreQueuedMessagesToEditor), cap warnings included;
 *  - a steer queued at message_end drains only AFTER turn_end, so when that
 *    turn_end committed a swap, the warning landed in the fresh window and still
 *    triggered an LLM call;
 *  - a /handoff prompt cleared from the queue left the command waiting forever.
 * pi commits boundary entries before it drains its queues, and a queued user
 * message still takes precedence over the context-only continuation — then the
 * demand is already in context in front of it.
 *
 * The one exception is starting a run from idle (/handoff typed while nothing
 * runs): `sendMessage` with `triggerTurn` starts the run directly; nothing is
 * queued when idle.
 */

import type {
	BoundaryResult,
	CustomMessageEntryDraft,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import type { CycleOrigin } from "./context-cap-decide.ts";
import { demandMessage, reminderMessage } from "./context-cap-messages.ts";
import { type CapSession, stampCaps, updateStatus } from "./context-cap-session.ts";
import { HANDOFF_DEMAND_TYPE } from "./message-types.ts";

/** Persisted on the demand entry: which row of the prompt matrix it is. */
export interface DemandDetails {
	origin: CycleOrigin;
	kind: "demand" | "reminder";
	/** Reminder number (1…MAX_RETRIES); absent on demands. */
	attempt?: number;
}

function demandDraft(content: string, details: DemandDetails): CustomMessageEntryDraft {
	return { type: "custom_message", customType: HANDOFF_DEMAND_TYPE, content, display: true, details };
}

/** The current cycle's demand as a custom message (origin decides the wording). */
export function cycleDemand(s: CapSession, ctx: ExtensionContext): CustomMessageEntryDraft {
	const origin = s.cycle.origin ?? "manual";
	const text = demandMessage(origin, s.cycle.tokensAtTrigger, stampCaps(s, ctx));
	return demandDraft(text, { origin, kind: "demand" });
}

/** Commit the pending demand at this boundary; from now on the tool records the document. */
export function commitDemand(
	s: CapSession,
	ctx: ExtensionContext,
	event: { entries: SessionBoundaryDraft[] },
): BoundaryResult {
	const entry = cycleDemand(s, ctx);
	s.cycle.phase = "demanded";
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
	return { entries: [...event.entries, entry], continue: true };
}

/** Commit reminder `attempt` of the current cycle at this boundary. */
export function commitReminder(s: CapSession, event: { entries: SessionBoundaryDraft[] }, attempt: number): BoundaryResult {
	s.cycle.retries = attempt;
	const origin = s.cycle.origin ?? "manual";
	const entry = demandDraft(reminderMessage(origin, attempt), { origin, kind: "reminder", attempt });
	return { entries: [...event.entries, entry], continue: true };
}

/** Idle only: start a run whose first message is the current cycle's demand. */
export function startDemandRun(s: CapSession, ctx: ExtensionContext): void {
	const { customType, content, display, details } = cycleDemand(s, ctx);
	s.cycle.phase = "demanded";
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
	s.pi.sendMessage({ customType, content, display, details }, { triggerTurn: true });
}
