/**
 * Cross-extension "this session is not finished yet" registry.
 *
 * A pi run ends when the model stops calling tools. Two of our extensions break
 * that assumption by restarting a session from the outside:
 *   - `timer`: the expiry message wakes the agent after its run ended.
 *   - `context-cap`: `context_handoff` swaps the context and the agent continues.
 * In the top-level session this is invisible (the user just sees more turns). In a
 * child session driven by the Agent tool it is fatal: the tool call would resolve
 * at the first pause and everything the child does afterwards is lost to the caller.
 *
 * So the end-of-work signal for a child is not "the run ended" but "the run ended
 * and nobody claims pending work". Extensions that restart a session claim before
 * the run can end and release once the restarted run has settled.
 *
 * State lives on globalThis, NOT in module scope: pi's extension loader creates a
 * fresh jiti instance with `moduleCache: false` per extension file, so timer.ts and
 * subagent.ts each import their own *copy* of this module (verified in
 * core/extensions/loader.js — loadExtensionModule). Module-level state would not be
 * shared between them; a global symbol is.
 *
 * Every claim carries a timeout: a lost wake-up must not hang the caller forever.
 */

interface Claim {
	timeout: NodeJS.Timeout;
}

interface Registry {
	/** sessionId -> reason -> claim */
	claims: Map<string, Map<string, Claim>>;
	listeners: Set<(sessionId: string) => void>;
}

const REGISTRY_KEY = Symbol.for("terminal-setup.pending-work");
const globals = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry: Registry = (globals[REGISTRY_KEY] ??= { claims: new Map(), listeners: new Set() });

function notify(sessionId: string): void {
	for (const listener of [...registry.listeners]) {
		try {
			listener(sessionId);
		} catch {
			// A broken listener must not break the claim bookkeeping.
		}
	}
}

/**
 * Declare that `sessionId` has work coming that outlives the current run.
 * Re-claiming the same reason refreshes the timeout. Auto-released after
 * `timeoutMs` so a lost wake-up degrades to "child returns" instead of a hang.
 */
export function claimPendingWork(sessionId: string, reason: string, timeoutMs: number): void {
	let bySession = registry.claims.get(sessionId);
	if (!bySession) {
		bySession = new Map();
		registry.claims.set(sessionId, bySession);
	}
	clearTimeout(bySession.get(reason)?.timeout);
	const timeout = setTimeout(() => releasePendingWork(sessionId, reason), timeoutMs);
	timeout.unref?.();
	bySession.set(reason, { timeout });
	notify(sessionId);
}

export function releasePendingWork(sessionId: string, reason: string): void {
	const bySession = registry.claims.get(sessionId);
	const claim = bySession?.get(reason);
	if (!bySession || !claim) return;
	clearTimeout(claim.timeout);
	bySession.delete(reason);
	if (bySession.size === 0) registry.claims.delete(sessionId);
	notify(sessionId);
}

export function hasPendingWork(sessionId: string): boolean {
	return (registry.claims.get(sessionId)?.size ?? 0) > 0;
}

export function pendingWorkReasons(sessionId: string): string[] {
	return [...(registry.claims.get(sessionId)?.keys() ?? [])];
}

/** Resolves on the next claim/release for `sessionId`, or when `signal` aborts. */
export function waitForPendingWorkChange(sessionId: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => {
			registry.listeners.delete(listener);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const listener = (changed: string) => {
			if (changed === sessionId) done();
		};
		registry.listeners.add(listener);
		signal?.addEventListener("abort", done, { once: true });
	});
}
