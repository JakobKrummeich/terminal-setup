/**
 * Timer — lets the agent wake itself after starting a long-running background task.
 *
 * The agent sets a single timer; on expiry a user message is injected
 * ("Timer '{name}' expired. Continue your task.") which triggers a new turn.
 * This closes the "started task in background, ended turn, needs user poke" loop.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { claimPendingWork, releasePendingWork } from "./lib/pending-work.ts";

const CLAIM = "timer";
/** Safety margin on the armed claim; refreshed with a longer budget once it fires. */
const ARMED_GRACE_MS = 60_000;
/** Cap on how long the woken-up run may keep a caller waiting. */
const WAKE_TIMEOUT_MS = 30 * 60_000;
/** Re-send attempts for a stranded wake-up before giving up and releasing. */
const MAX_WAKE_RESENDS = 3;

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
			"For long tasks (build, tests, deploy, download): start task in background, set timer, end turn. On expiry a message wakes you at the next turn boundary to check the result. One timer; new set replaces old.",
		parameters: timerParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "cancel") {
				const prev = clearActive();
				if (!prev) return ok("No active timer.");
				const remaining = Math.max(0, Math.round((prev.expiresAt - Date.now()) / 1000));
				return ok(`Cancelled timer "${prev.name}" (${remaining}s remaining).`);
			}

			// action === "set"
			if (params.seconds === undefined || params.seconds <= 0) {
				return err("Error: 'seconds' must be a positive number when action is 'set'.");
			}

			const name = params.name?.trim() || "timer";
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
