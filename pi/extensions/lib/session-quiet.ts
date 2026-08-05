/**
 * "Really done" for a driven session (Agent tool child): idle AND no queued input
 * AND no pending-work claims.
 *
 * `session.prompt()` resolving only means the model stopped calling tools. Two more
 * signals matter before a caller may treat the session as finished:
 *   - pending-work claims (lib/pending-work.ts): an extension (timer) has scheduled
 *     work that restarts the session from the outside.
 *   - queued messages: a steer/follow-up was queued but not yet delivered — its run
 *     is about to start (or it was stranded by the settle race, in which case its
 *     owner also holds a claim and re-sends; see timer.ts). Checking the queue uses
 *     pi's own state and catches strandedness from any source.
 *
 * Claims self-expire, so a lost wake-up delays the caller instead of hanging it;
 * the queue grace is budgeted so a permanently stranded message cannot spin forever.
 */

import { hasPendingWork, pendingWorkReasons, waitForPendingWorkChange } from "./pending-work.ts";

/** Structural subset of AgentSession that the wait loop needs. */
export interface QuietSession {
	readonly isIdle: boolean;
	/** Steering + follow-up messages queued but not yet delivered. */
	readonly pendingMessageCount: number;
	waitForIdle(): Promise<void>;
}

const QUEUE_POLL_MS = 250;
const QUEUE_GRACE_BUDGET_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve once `session` is idle with an empty queue and no pending-work claim,
 * or once `signal` aborts. `onWaiting` is called with the current claim reasons
 * when a between-runs wait starts, and with `[]` when it ends (status display).
 */
export async function waitForSessionQuiet(
	session: QuietSession,
	sessionId: string,
	signal: AbortSignal | undefined,
	onWaiting?: (reasons: string[]) => void,
): Promise<void> {
	// The timers this wait depends on (timer expiry, claim expiry) are all unref'd,
	// so without a ref'd handle the event loop can drain mid-wait and the promise
	// silently never resolves. A caller awaiting quiet must keep the process alive.
	const keepAlive = setInterval(() => {}, 30_000);
	try {
		let queueGraceLeft = QUEUE_GRACE_BUDGET_MS;
		while (!signal?.aborted) {
			await session.waitForIdle();
			if (session.pendingMessageCount > 0 && queueGraceLeft > 0) {
				// Idle with queued input: a wake-up's run is about to start (its prompt()
				// is in flight). Bounded, so a stranded orphan can't spin us forever.
				queueGraceLeft -= QUEUE_POLL_MS;
				await sleep(QUEUE_POLL_MS);
				continue;
			}
			if (!hasPendingWork(sessionId)) return;
			queueGraceLeft = QUEUE_GRACE_BUDGET_MS;
			onWaiting?.(pendingWorkReasons(sessionId));
			await waitForPendingWorkChange(sessionId, signal);
			onWaiting?.([]);
		}
	} finally {
		clearInterval(keepAlive);
	}
}
