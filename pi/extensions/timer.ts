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
 * The blocking wait honours the requested duration in full — an hour is an hour,
 * one tool call, one result. It is not chopped into re-callable chunks: every
 * re-call would be a fresh LLM round-trip at full context, so a capped wait bills
 * real money for nothing. Liveness comes from `onUpdate` heartbeats instead, and
 * an abort cuts the wait immediately. A cap remains available, opt-in, via
 * PI_TIMER_MAX_WAIT_S.
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
 * Stranded wake-ups: if the expiry fires in the gap between a run's final queue
 * drain and agent_settled, the steer is queued into a loop that already ended and
 * would never be delivered. So after expiry the timer watches for the wake-up
 * message actually entering a run (message_start); a settle that finds it
 * undelivered re-sends it — the session is idle at that point, so the re-send
 * starts the run the expiry was meant to trigger.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inChildSession } from "./lib/child-context.ts";
import { envInt } from "./lib/env.ts";
import { messageText } from "./lib/message-text.ts";
import { registerCompactCallRenderer } from "./lib/tool-call-render.ts";

/** Re-send attempts for a stranded wake-up before giving up. */
const MAX_WAKE_RESENDS = 3;
/**
 * Optional cap on ONE blocking (headless) wait, in seconds. Unset (or <= 0) means
 * NO cap: a headless agent has the same reach as an interactive one, which can arm
 * a wake-up of any length. Capping would force the agent to re-call every N
 * seconds, and every re-call is a full LLM round-trip at the current context size
 * — 3 extra round-trips at 200k+ tokens for a 30-minute wait, buying nothing.
 * Nothing in pi times a tool call out (pi-agent-core dist/agent-loop.js:453 awaits
 * `tool.execute()` bare), so the block is safe; liveness is shown by the heartbeat
 * below instead of by returning early. Set PI_TIMER_MAX_WAIT_S to opt into a cap
 * — the capped result then tells the agent how much is left and to call again.
 */
const DEFAULT_HEADLESS_MAX_WAIT_S = 0;

/** 0 = unlimited. Read per call, so a test or an operator can flip it live. */
function headlessMaxWaitMs(): number {
	return envInt("PI_TIMER_MAX_WAIT_S", DEFAULT_HEADLESS_MAX_WAIT_S) * 1000;
}

/**
 * Heartbeat cadence for a blocked wait: ~20 updates spread over the whole wait,
 * floored at 30s and ceilinged at 5min. Adaptive rather than fixed because the
 * point is "this call is alive", not a clock: 20 ticks proves that for a 2-minute
 * wait and for an 8-hour one alike, while a fixed 30s would emit 960 updates for
 * the latter — and pi-agent-core keeps one promise per update in an array it
 * awaits when execute() resolves (dist/agent-loop.js:454-469), so update count is
 * not free. The floor keeps short waits from spamming, the ceiling keeps a very
 * long wait from ever looking frozen for more than 5 minutes.
 * PI_TIMER_HEARTBEAT_MS overrides the interval outright (tests use it).
 */
const HEARTBEAT_FRACTION = 20;
const HEARTBEAT_MIN_MS = 30_000;
const HEARTBEAT_MAX_MS = 5 * 60_000;

function heartbeatIntervalMs(waitMs: number): number {
	const override = envInt("PI_TIMER_HEARTBEAT_MS", 0);
	if (override > 0) return override;
	return Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, Math.round(waitMs / HEARTBEAT_FRACTION)));
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

type TimerUpdate = ((partial: ReturnType<typeof ok>) => void) | undefined;

function secondsUntil(expiresAt: number): number {
	return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

/**
 * Headless path: block inside the tool call. The run stays active, so the process
 * cannot exit and no wake-up (which nothing here could deliver) is promised.
 */
async function blockingWait(name: string, seconds: number, signal: AbortSignal | undefined, onUpdate: TimerUpdate) {
	const requestedMs = seconds * 1000;
	const maxWaitMs = headlessMaxWaitMs();
	const waitMs = maxWaitMs > 0 ? Math.min(requestedMs, maxWaitMs) : requestedMs;
	const startedAt = Date.now();
	// Progress, so a long block never looks frozen: same channel the child-session
	// tools use (lib/child-session.ts pushStatus), rendered as a live tool update.
	const heartbeat = setInterval(() => {
		const elapsed = Date.now() - startedAt;
		const remainingS = Math.max(0, Math.round((waitMs - elapsed) / 1000));
		onUpdate?.(ok(`Timer "${name}": waiting — ${Math.round(elapsed / 1000)}s elapsed, ${remainingS}s remaining.`));
	}, heartbeatIntervalMs(waitMs));
	const { aborted } = await waitOrAbort(waitMs, signal).finally(() => clearInterval(heartbeat));
	const elapsedS = Math.round((Date.now() - startedAt) / 1000);
	if (aborted) {
		return ok(`Timer "${name}" wait aborted after ${elapsedS}s of ${seconds}s requested. No timer is left running.`);
	}
	if (waitMs < requestedMs) {
		// Only reachable with PI_TIMER_MAX_WAIT_S set: loop instead of one long block.
		const remainingS = Math.max(1, Math.round((requestedMs - waitMs) / 1000));
		return ok(
			`Timer "${name}": waited ${elapsedS}s of the ${seconds}s requested (one wait is capped at ${Math.round(maxWaitMs / 1000)}s). ${remainingS}s still to go — check the task; if it is not finished, call timer again with seconds: ${remainingS}. Keep working in this turn.`,
		);
	}
	return ok(`Timer "${name}" fired after ${elapsedS}s. Continue your task.`);
}

/**
 * The interactive (async) timer plus its wake-up delivery tracking. One instance
 * per extension load — the state is per-session, never module-level.
 */
class WakeTimer {
	readonly pi: ExtensionAPI;
	active: ActiveTimer | undefined;
	/** Expiry fired, wake-up run not settled yet. */
	awaitingWake = false;
	/** Exact wake-up text sent at expiry; matched against message_start. */
	wakeText: string | undefined;
	/** The wake-up message was observed entering a run. */
	wakeDelivered = false;
	wakeResends = 0;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	resetWakeState() {
		this.awaitingWake = false;
		this.wakeText = undefined;
		this.wakeDelivered = false;
		this.wakeResends = 0;
	}

	clearActive(): ActiveTimer | undefined {
		const prev = this.active;
		if (prev) clearTimeout(prev.timeout);
		this.active = undefined;
		return prev;
	}

	/** Also runs headless: no async timer is ever armed there, so clearActive() finds nothing. */
	cancel(interactive: boolean) {
		const prev = this.clearActive();
		if (prev) return ok(`Cancelled timer "${prev.name}" (${secondsUntil(prev.expiresAt)}s remaining).`);
		if (!interactive) {
			return ok(
				"No timer to cancel: in this mode timer waits inside the tool call, so there is never an armed timer running in the background. A wait in progress ends by aborting that tool call, not by cancelling.",
			);
		}
		return ok("No active timer.");
	}

	/** Interactive: arm the async wake-up and hand the turn back. */
	arm(name: string, seconds: number) {
		const replaced = this.clearActive();
		const expiresAt = Date.now() + seconds * 1000;
		const timeout = setTimeout(() => this.expire(name), seconds * 1000);
		timeout.unref?.();
		this.active = { name, timeout, expiresAt };

		const fireTime = new Date(expiresAt).toLocaleTimeString();
		const replacedNote = replaced
			? ` Replaced timer "${replaced.name}" (${secondsUntil(replaced.expiresAt)}s remaining).`
			: "";
		return ok(
			`Timer "${name}" set — fires in ${seconds}s (${fireTime}).${replacedNote} End your turn now; the expiry message will wake you.`,
		);
	}

	expire(name: string) {
		this.active = undefined;
		this.awaitingWake = true;
		this.wakeText = `Timer "${name}" expired. Continue your task.`;
		this.wakeDelivered = false;
		this.wakeResends = 0;
		try {
			this.pi.sendUserMessage(this.wakeText, { deliverAs: "steer" });
		} catch (e) {
			// The wake-up can never arrive: nothing left to watch for.
			console.warn("[timer] failed to deliver expiry message:", e);
			this.resetWakeState();
		}
	}

	// Watch for the wake-up message actually entering a run: only a settle AFTER
	// delivery means the wake-up work happened.
	onMessageStart(message: unknown) {
		if (!this.awaitingWake || this.wakeDelivered || !this.wakeText) return;
		const msg = message as { role?: string; content?: unknown };
		if (msg.role !== "user") return;
		if (messageText(msg.content).includes(this.wakeText)) this.wakeDelivered = true;
	}

	onSettled() {
		if (!this.awaitingWake) return;
		if (this.wakeDelivered) {
			// The run containing the wake-up has finished.
			this.resetWakeState();
			return;
		}
		// Stranded wake-up: the expiry fired between this run's final queue drain and
		// its settle, so the steer was queued into a loop that had already ended. The
		// session is idle now — re-send to start the run the expiry meant to trigger.
		// (The stranded original may be drained too; a duplicate wake-up is harmless.)
		if (!this.wakeText || this.wakeResends >= MAX_WAKE_RESENDS) {
			this.resetWakeState();
			return;
		}
		this.wakeResends++;
		try {
			this.pi.sendUserMessage(this.wakeText, { deliverAs: "steer" });
		} catch (e) {
			console.warn("[timer] failed to re-send stranded wake-up:", e);
			this.resetWakeState();
		}
	}
}

function registerTimerTool(pi: ExtensionAPI, timer: WakeTimer): void {
	registerCompactCallRenderer(pi, "timer", timerCallSummary);
	pi.registerTool({
		name: "timer",
		label: "Timer",
		description:
			"Wait out a long task (build, tests, deploy, download): start it in the background, then call timer with the full time you need. How the wait works depends on the run mode, and the tool result says which happened: either it blocks for the whole duration and returns when the time is up (continue working then), or it arms a wake-up message and tells you to end your turn. Follow the result text, not this description. One timer; new set replaces old.",
		parameters: timerParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const interactive = isInteractive(ctx);
			if (params.action === "cancel") return timer.cancel(interactive);

			// action === "set"
			if (params.seconds === undefined || params.seconds <= 0) {
				return err("Error: 'seconds' must be a positive number when action is 'set'.");
			}
			const name = params.name?.trim() || "timer";
			if (!interactive) return blockingWait(name, params.seconds, signal, onUpdate);
			return timer.arm(name, params.seconds);
		},
	});
}

/** `set 300s · build` / `cancel`; args may be partial while the call streams. */
export function timerCallSummary(args: { action?: unknown; seconds?: unknown; name?: unknown } | undefined): string {
	if (args?.action !== "set") return typeof args?.action === "string" ? args.action : "";
	const seconds = typeof args.seconds === "number" ? ` ${args.seconds}s` : "";
	return `set${seconds}${timerNameSuffix(args.name)}`;
}

function timerNameSuffix(name: unknown): string {
	const trimmed = typeof name === "string" ? name.trim() : "";
	return trimmed ? ` · ${trimmed}` : "";
}

export default function timerExtension(pi: ExtensionAPI) {
	// MAIN SESSION ONLY. A child session (Agent tool) is always headless
	// (bindExtensions({}) → mode "print"), so its timer could only ever take the
	// blocking path — which buys nothing over `bash sleep N` (nothing in pi times
	// a tool call out) while costing tool-listing tokens in every child prompt
	// and inviting park-semantics confusion. Explorers already exclude timer via
	// their readonly allowlist; this guard removes it from every other child kind
	// too: the tool is not registered, so a child's prompt never offers it.
	// Same bind-time ALS guard as wsstate.ts.
	if (inChildSession()) return;

	const timer = new WakeTimer(pi);
	pi.on("session_shutdown", () => {
		timer.resetWakeState();
		timer.clearActive();
	});
	pi.on("message_start", (event) => timer.onMessageStart(event.message));
	pi.on("agent_settled", () => timer.onSettled());
	registerTimerTool(pi, timer);
}
