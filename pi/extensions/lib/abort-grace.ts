/** How long a caller abort waits for the child's run to wind down before the call returns without it. */
export const ABORT_GRACE_MS = 10_000;

/**
 * `run`, unless `signal` aborts and `run` is still pending `graceMs` later — then
 * resolve anyway and leave `run` orphaned (its rejection is swallowed).
 *
 * WHY: pi's agent loop awaits the provider stream without watching the abort
 * signal (pi-agent-core agent-loop.js streamAssistantResponse), so a stream that
 * ignores abort keeps session.prompt() pending forever — and with it the parent's
 * tool call, ESC included. The caller must keep the orphan from writing state:
 * child-session.ts stops its event watcher and the busy slot waits for idle.
 */
export function settleWithinAbortGrace(run: Promise<void>, signal: AbortSignal | undefined, graceMs: number): Promise<void> {
	if (!signal) return run;
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const startGrace = () => {
			timer = setTimeout(resolve, graceMs);
		};
		if (signal.aborted) startGrace();
		else signal.addEventListener("abort", startGrace, { once: true });
		void run.then(resolve, reject).finally(() => {
			clearTimeout(timer);
			signal.removeEventListener("abort", startGrace);
		});
	});
}
