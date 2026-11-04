/**
 * context-cap, the /handoff command: one more trigger of the SAME cycle the caps
 * use (lib/context-cap-decide.ts decideManual), ending in a new session instead
 * of a swap. The command arms or joins the cycle, waits until the cycle hands it
 * the document (lib/context-cap-swap.ts handOver) or fails, then seeds a fresh
 * session with it — triggerTurn false: the user stays in the driver's seat, so no
 * "Continue your work." either.
 *
 * Never two machines, never two demands: a /handoff during a cap cycle only flips
 * its ending; a cap crossing during a /handoff cycle at most moves the pending
 * demand forward. The document always comes from the `context_handoff` tool call
 * (or the hard-cap machine writer), never from the newest assistant reply — the
 * old reply harvest seeded post-swap chatter or a summary-of-a-summary when the
 * two machines raced.
 *
 * Delivery: idle → the demand starts a run directly; mid-run → the demand is
 * committed at agent_before_settle once the run finished its work; during a
 * compaction or branch summary (busy, but no run) → it starts a run once pi is idle.
 * Nothing goes through pi's steer/followUp queues (lib/context-cap-demand.ts
 * says why), so ESC restores nothing to the editor and can never strand the
 * command: agent_settled fails any waiter its run did not satisfy.
 */

import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { decideManual } from "./context-cap-decide.ts";
import { commitDemand, startDemandRun } from "./context-cap-demand.ts";
import {
	type CapSession,
	capsFrom,
	type ManualResult,
	resetCycle,
	settleManual,
	startCycle,
	updateStatus,
} from "./context-cap-session.ts";
import { docSummary, handOver, NO_CYCLE_DOC } from "./context-cap-swap.ts";
import { HANDOFF_SUMMARY_TYPE } from "./message-types.ts";

export async function runHandoffCommand(s: CapSession, ctx: ExtensionCommandContext): Promise<void> {
	if (s.manual) {
		ctx.ui.notify("/handoff already in progress", "warning");
		return;
	}
	const result = await new Promise<ManualResult>((resolve) => {
		s.manual = { resolve };
		startManual(s, ctx);
	});
	if (!result.ok) {
		if (result.reason) ctx.ui.notify(`/handoff: no handoff recorded — ${result.reason}`, "error");
		return;
	}
	// The hand-over happens at a turn_end; let that run finish before replacing the session.
	await ctx.waitForIdle();
	await ctx.newSession({
		withSession: (next) =>
			next.sendMessage({ customType: HANDOFF_SUMMARY_TYPE, content: result.seed, display: true }, { triggerTurn: false }),
	});
}

function startManual(s: CapSession, ctx: ExtensionCommandContext): void {
	const action = decideManual(s.cycle, ctx.isIdle());
	s.cycle.ending = "new-session";
	switch (action.kind) {
		case "finish":
			finishNow(s, ctx);
			return;
		case "join":
			ctx.ui.notify("/handoff: a handoff is already requested — a new session starts from it", "info");
			return;
		case "demand-now":
			armManual(s, ctx, action.open);
			startDemandRun(s, ctx);
			return;
		case "demand-at-settle":
			armManual(s, ctx, action.open);
			parkAtSettle(s, ctx);
			return;
	}
}

/**
 * Busy: the demand waits for the run's agent_before_settle. A compaction or
 * branch summary is busy without a run, so nothing settles it — the demand then
 * starts once pi is idle. After a run the settle handlers already took it over.
 */
function parkAtSettle(s: CapSession, ctx: ExtensionCommandContext): void {
	s.cycle.phase = "pending";
	s.cycle.demandAt = "settle";
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
	ctx.ui.notify("/handoff: handoff requested once the agent finishes", "info");
	const waiter = s.manual;
	void ctx.waitForIdle().then(() => {
		if (s.manual === waiter && waitingAtSettle(s) && ctx.isIdle()) startDemandRun(s, ctx);
	});
}

function waitingAtSettle(s: CapSession): boolean {
	return s.cycle.phase === "pending" && s.cycle.demandAt === "settle";
}

/** The document is already there and nothing runs: hand it over at once. */
function finishNow(s: CapSession, ctx: ExtensionContext): void {
	const { doc } = s.cycle;
	if (doc) handOver(s, ctx, docSummary(doc));
	else failManual(s, ctx, NO_CYCLE_DOC);
}

/** The /handoff demand replaces whatever demand the cycle had (none, or an exhausted/abandoned one). */
function armManual(s: CapSession, ctx: ExtensionContext, open: boolean): void {
	if (open) {
		const usage = ctx.getContextUsage();
		startCycle(s, ctx, usage?.tokens ?? 0, capsFrom(s, ctx, usage));
	}
	s.cycle.origin = "manual";
	s.cycle.retries = 0;
}

/** agent_before_settle: the run finished its work — commit a /handoff demand that waited for it. */
export function onBeforeSettle(
	s: CapSession,
	ctx: ExtensionContext,
	event: AgentBeforeSettleEvent,
): BoundaryResult | undefined {
	if (!waitingAtSettle(s) || event.outcome === "aborted") return undefined;
	return commitDemand(s, ctx, event);
}

/**
 * agent_settled: a run that leaves a /handoff waiting either never got to deliver
 * its demand (start it now) or ended without the document — then fail the
 * command instead of letting it wait forever, and give a cap cycle back its swap.
 */
export function onSettled(s: CapSession, ctx: ExtensionContext, aborted: boolean): void {
	if (!s.manual) return;
	// pi defers a run started from inside agent_settled until settling is over.
	if (waitingAtSettle(s) && !aborted) startDemandRun(s, ctx);
	else failManual(s, ctx, aborted ? "aborted" : "the agent ended without calling context_handoff");
}

/** Fail the waiting command; a cap cycle it joined gets its swap ending back, a /handoff cycle ends. */
function failManual(s: CapSession, ctx: ExtensionContext, reason: string): void {
	settleManual(s, { ok: false, reason });
	if (s.cycle.origin === "manual") resetCycle(s);
	else s.cycle.ending = "swap";
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
}

/** session_shutdown: release the command silently — its ctx is being torn down — and drop the cycle. */
export function onShutdown(s: CapSession): void {
	settleManual(s, { ok: false });
	resetCycle(s);
}
