/**
 * Timer — lets the agent wait out a long-running background task.
 *
 * TWO MODES, because "end your turn, a message will wake you" is only true where
 * something outside the agent loop can start a new run:
 *
 * - Interactive (`ctx.mode === "tui"`): async. The agent sets a single timer and
 *   ends its turn; on expiry a user message is injected ("Timer '{name}' expired.
 *   Continue your task.") which triggers a new turn. The TUI's own input loop keeps
 *   the process and the extension context alive in the meantime.
 * - Headless (everything else — `pi -p` print/json, rpc, or an unknown mode):
 *   BLOCKING. `runPrintMode()` awaits one `session.prompt()` and then disposes the
 *   runtime in a `finally`; once the agent's turn ends with no tool call nothing
 *   re-enters the loop, so a `setTimeout` firing afterwards has no session left to
 *   wake — the run just exits 0 mid-task (this cost a real experiment its control
 *   arm). So in headless the tool call itself stays in flight for the wait: the run
 *   cannot end, the process cannot exit, and the result says "continue", never
 *   "end your turn". Blocking is safe in every mode, the wake-up is not, so
 *   anything that is not confirmed "tui" takes the blocking path.
 *
 * One timer at a time; setting a new one replaces the old (stated in result).
 *
 * Delivery: `deliverAs: "steer"`, NOT "followUp". pi delivers follow-ups only
 * once the whole run ends (agent has no more tool calls), so during a long run
 * the wake-up never arrives — expiries pile up in the queue and are flushed as a
 * stack of stale wake-ups at the end (see test/timer.test.ts). Steering messages
 * are delivered at the next turn boundary (after the current tool calls, before
 * the next LLM call), which is what "wake me when the time is up" means.
 * When the agent is idle, deliverAs is ignored and the message starts a turn.
 *
 * Pending-work claims: an armed timer means "this session will do more work after
 * the current run ends". A child session (Agent tool) must not be reported as
 * finished in that window, so the timer claims pending work from `set` until the
 * wake-up run has settled (see lib/pending-work.ts). Release is evidence-based:
 * the claim is dropped only after the wake-up message was actually DELIVERED
 * (observed via message_start) and its run settled — not merely because some run
 * settled. If a settle finds the wake-up undelivered (expiry fired in the gap
 * between a run's final queue drain and agent_settled, stranding the steer in a
 * dead loop), the wake-up is re-sent — the session is idle at that point, so the
 * re-send starts the run the expiry was meant to trigger. Claims carry a cancel
 * callback so a caller that stops supervising the session (abort) can disarm the
 * timer entirely instead of leaving it to fire unsupervised.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { envInt } from "./lib/env.ts";
import { claimPendingWork, releasePendingWork } from "./lib/pending-work.ts";

const CLAIM = "timer";
/** Safety margin on the armed claim; refreshed with a longer budget once it fires. */
const ARMED_GRACE_MS = 60_000;
/** Cap on how long the woken-up run may keep a caller waiting. */
const WAKE_TIMEOUT_MS = 30 * 60_000;
/** Re-send attempts for a stranded wake-up before giving up and releasing. */
const MAX_WAKE_RESENDS = 3;
/**
 * Cap on ONE blocking (headless) wait, in seconds. Bounded from above by the
 * supervising harness, which treats a tool child blocked for 1500s as a stall,
 * and by the fact that a blocked call reports no progress at all; bounded from
 * below by the cost of looping (each extra call is another LLM round-trip).
 * 10 minutes covers most build/test/download waits in a single call and leaves
 * a 2.5x margin under the watchdog. Longer requests wait the cap and are told to
 * call again, so the agent can wait arbitrarily long without ever ending a turn.
 * Override with PI_TIMER_MAX_WAIT_S (read per call, so tests can set it).
 */
const DEFAULT_HEADLESS_MAX_WAIT_S = 600;

function headlessMaxWaitMs(): number {
	return envInt("PI_TIMER_MAX_WAIT_S", DEFAULT_HEADLESS_MAX_WAIT_S) * 1000;
}

/**
 * Only the interactive TUI has an input loop that starts a new run after the
 * current one ended, so only there can an out-of-band wake-up arrive. Anything
 * else — print/json (`pi -p`), rpc, or a `mode` this pi build does not set at all
 * — is treated as headless and blocks instead. Fail-safe by construction:
 * an unknown mode degrades to the path that works everywhere.
 */
function isInteractive(ctx: ExtensionContext): boolean {
	return (ctx as { mode?: unknown }).mode === "tui";
}

/** Sleep that resolves early (with `aborted: true`) when the tool call is aborted. */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<{ aborted: boolean }> {
	if (signal?.aborted) return Promise.resolve({ aborted: true });
	return new Promise((resolve) => {
		// Deliberately NOT unref'd: this timer is what keeps the process alive for
		// the duration of the wait.
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ aborted: false });
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			resolve({ aborted: true });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const timerParams = Type.Object({
	action: Type.Union([Type.Literal("set"), Type.Literal("cancel")]),
	name: Type.Optional(Type.String({ description: "Echoed in expiry message" })),
	seconds: Type.Optional(Type.Number({ description: "Required for set; prefer >=30" })),
});

interface ActiveTimer {
	name: string;
	timeout: NodeJS.Timeout;
	expiresAt: number;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export default function timerExtension(pi: ExtensionAPI) {
	let active: ActiveTimer | undefined;
	let sessionId: string | undefined;
	/** Expiry fired, wake-up run not settled yet — still pending work. */
	let awaitingWake = false;
	/** Exact wake-up text sent at expiry; matched against message_start. */
	let wakeText: string | undefined;
	/** The wake-up message was observed entering a run. */
	let wakeDelivered = false;
	let wakeResends = 0;

	function release() {
		if (sessionId) releasePendingWork(sessionId, CLAIM);
	}

	function resetWakeState() {
		awaitingWake = false;
		wakeText = undefined;
		wakeDelivered = false;
		wakeResends = 0;
	}

	/** Claim cancel callback: the caller walked away — disarm everything. */
	function disarm() {
		if (active) {
			clearTimeout(active.timeout);
			active = undefined;
		}
		resetWakeState();
	}

	function clearActive(): ActiveTimer | undefined {
		const prev = active;
		if (prev) clearTimeout(prev.timeout);
		active = undefined;
		if (!awaitingWake) release();
		return prev;
	}

	pi.on("session_shutdown", () => {
		resetWakeState();
		clearActive();
	});

	// Watch for the wake-up message actually entering a run. This is the release
	// evidence: only a settle AFTER delivery means the wake-up work happened.
	pi.on("message_start", (event) => {
		if (!awaitingWake || wakeDelivered || !wakeText) return;
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "user") return;
		const text = Array.isArray(msg.content)
			? (msg.content as Array<{ type?: string; text?: string }>)
					.filter((c) => c?.type === "text")
					.map((c) => c.text ?? "")
					.join("\n")
			: String(msg.content ?? "");
		if (text.includes(wakeText)) wakeDelivered = true;
	});

	pi.on("agent_settled", () => {
		if (!awaitingWake) return;
		if (wakeDelivered) {
			// The run containing the wake-up has finished: nothing is outstanding
			// unless another timer was set during that run.
			resetWakeState();
			if (!active) release();
			return;
		}
		// Stranded wake-up: the expiry fired between this run's final queue drain and
		// its settle, so the steer was queued into a loop that had already ended. The
		// session is idle now — re-send to start the run the expiry meant to trigger.
		// (The stranded original may be drained too; a duplicate wake-up is harmless.)
		if (!wakeText || wakeResends >= MAX_WAKE_RESENDS) {
			resetWakeState();
			if (!active) release();
			return;
		}
		wakeResends++;
		try {
			pi.sendUserMessage(wakeText, { deliverAs: "steer" });
		} catch (e) {
			console.warn("[timer] failed to re-send stranded wake-up:", e);
			resetWakeState();
			if (!active) release();
		}
	});

	pi.registerTool({
		name: "timer",
		label: "Timer",
		description:
			"Wait out a long task (build, tests, deploy, download): start it in the background, then call timer. How the wait works depends on the run mode, and the tool result says which happened: either it blocks and returns when the time is up (continue working then), or it arms a wake-up message and tells you to end your turn. Follow the result text, not this description. One timer; new set replaces old.",
		parameters: timerParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			sessionId = ctx.sessionManager.getSessionId();
			const interactive = isInteractive(ctx);
			if (params.action === "cancel") {
				// Also runs headless: no async timer is ever armed there, but clearActive()
				// keeps the pending-work registry consistent either way.
				const prev = clearActive();
				if (prev) {
					const remaining = Math.max(0, Math.round((prev.expiresAt - Date.now()) / 1000));
					return ok(`Cancelled timer "${prev.name}" (${remaining}s remaining).`);
				}
				if (!interactive) {
					return ok(
						"No timer to cancel: in this mode timer waits inside the tool call, so there is never an armed timer running in the background. A wait in progress ends by aborting that tool call, not by cancelling.",
					);
				}
				return ok("No active timer.");
			}

			// action === "set"
			if (params.seconds === undefined || params.seconds <= 0) {
				return err("Error: 'seconds' must be a positive number when action is 'set'.");
			}

			const name = params.name?.trim() || "timer";

			if (!interactive) {
				// Headless: block inside the tool call. The run stays active, so the process
				// cannot exit and no wake-up (which nothing here could deliver) is promised.
				const requestedMs = params.seconds * 1000;
				const maxWaitMs = headlessMaxWaitMs();
				const waitMs = Math.min(requestedMs, maxWaitMs);
				const startedAt = Date.now();
				const { aborted } = await waitOrAbort(waitMs, signal);
				const elapsedS = Math.round((Date.now() - startedAt) / 1000);
				if (aborted) {
					return ok(
						`Timer "${name}" wait aborted after ${elapsedS}s of ${params.seconds}s requested. No timer is left running.`,
					);
				}
				if (waitMs < requestedMs) {
					const remainingS = Math.max(1, Math.round((requestedMs - waitMs) / 1000));
					return ok(
						`Timer "${name}": waited ${elapsedS}s of the ${params.seconds}s requested (one wait is capped at ${Math.round(maxWaitMs / 1000)}s). ${remainingS}s still to go — check the task; if it is not finished, call timer again with seconds: ${remainingS}. Keep working in this turn.`,
					);
				}
				return ok(`Timer "${name}" fired after ${elapsedS}s. Continue your task.`);
			}

			// Interactive: arm the async wake-up and hand the turn back.
			const replaced = clearActive();
			const expiresAt = Date.now() + params.seconds * 1000;

			const timeout = setTimeout(() => {
				active = undefined;
				awaitingWake = true;
				wakeText = `Timer "${name}" expired. Continue your task.`;
				wakeDelivered = false;
				wakeResends = 0;
				if (sessionId) claimPendingWork(sessionId, CLAIM, WAKE_TIMEOUT_MS, disarm);
				try {
					pi.sendUserMessage(wakeText, { deliverAs: "steer" });
				} catch (e) {
					// The wake-up can never arrive: release instead of holding a caller
					// hostage for the full claim timeout.
					console.warn("[timer] failed to deliver expiry message:", e);
					resetWakeState();
					release();
				}
			}, params.seconds * 1000);
			timeout.unref?.();

			active = { name, timeout, expiresAt };
			claimPendingWork(sessionId, CLAIM, params.seconds * 1000 + ARMED_GRACE_MS, disarm);

			const fireTime = new Date(expiresAt).toLocaleTimeString();
			const replacedNote = replaced
				? ` Replaced timer "${replaced.name}" (${Math.max(0, Math.round((replaced.expiresAt - Date.now()) / 1000))}s remaining).`
				: "";
			return ok(
				`Timer "${name}" set — fires in ${params.seconds}s (${fireTime}).${replacedNote} End your turn now; the expiry message will wake you.`,
			);
		},
	});
}
