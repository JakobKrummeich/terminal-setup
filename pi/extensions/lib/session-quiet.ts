/**
 * "Really done" for a driven session (Agent tool child): idle AND no queued input.
 *
 * `session.prompt()` resolving only means the model stopped calling tools. A
 * steer/follow-up may still be queued but not yet delivered — its run is about to
 * start (or it was stranded by the settle race: queued into a loop that had already
 * ended). Checking pi's own queue catches that from any source. The queue grace is
 * budgeted so a permanently stranded message cannot spin the caller forever.
 *
 * Out-of-band restarts (a message injected after the run ended, e.g. a timer
 * wake-up) are NOT waited for: nothing inside a child produces them — timer.ts
 * registers nothing in child sessions, and context-cap's handoff continuations
 * are drained inside the same prompt() call (test/context-cap.test.ts).
 */

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

/** Resolve once `session` is idle with an empty queue (or the grace budget is spent), or once `signal` aborts. */
export async function waitForSessionQuiet(session: QuietSession, signal: AbortSignal | undefined): Promise<void> {
	let queueGraceLeft = QUEUE_GRACE_BUDGET_MS;
	while (!signal?.aborted) {
		await session.waitForIdle();
		if (session.pendingMessageCount === 0 || queueGraceLeft <= 0) return;
		// Idle with queued input: its run is about to start (its prompt() is in
		// flight). Bounded, so a stranded orphan can't spin us forever.
		queueGraceLeft -= QUEUE_POLL_MS;
		await sleep(QUEUE_POLL_MS);
	}
}
