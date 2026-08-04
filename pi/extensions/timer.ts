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
 * wake-up run has settled (see lib/pending-work.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { claimPendingWork, releasePendingWork } from "./lib/pending-work.ts";

const CLAIM = "timer";
/** Safety margin on the armed claim; refreshed with a longer budget once it fires. */
const ARMED_GRACE_MS = 60_000;
/** Cap on how long the woken-up run may keep a caller waiting. */
const WAKE_TIMEOUT_MS = 30 * 60_000;

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
	/** Expiry delivered, wake-up run not settled yet — still pending work. */
	let awaitingWake = false;

	function release() {
		if (sessionId) releasePendingWork(sessionId, CLAIM);
	}

	function clearActive(): ActiveTimer | undefined {
		const prev = active;
		if (prev) clearTimeout(prev.timeout);
		active = undefined;
		if (!awaitingWake) release();
		return prev;
	}

	pi.on("session_shutdown", () => {
		awaitingWake = false;
		clearActive();
	});

	// The wake-up run has finished (or the expiry landed as steering in a run that
	// has now ended): nothing is outstanding unless another timer was set meanwhile.
	pi.on("agent_settled", () => {
		if (!awaitingWake) return;
		awaitingWake = false;
		if (!active) release();
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
				if (sessionId) claimPendingWork(sessionId, CLAIM, WAKE_TIMEOUT_MS);
				try {
					pi.sendUserMessage(`Timer "${name}" expired. Continue your task.`, {
						deliverAs: "steer",
					});
				} catch (e) {
					console.warn("[timer] failed to deliver expiry message:", e);
				}
			}, params.seconds * 1000);
			timeout.unref?.();

			active = { name, timeout, expiresAt };
			claimPendingWork(sessionId, CLAIM, params.seconds * 1000 + ARMED_GRACE_MS);

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
