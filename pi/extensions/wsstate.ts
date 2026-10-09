/**
 * wsstate — report the pi agent's state to wezterm via OSC 1337 SetUserVar.
 *
 *   busy    — a run is in progress (agent_start … agent_settled)
 *   blocked — an extension dialog waits for the human (ui_prompt_start/end)
 *   waiting — between runs, parked on a timer it armed: it wakes by itself
 *   idle    — between runs, nothing armed: needs you
 *
 * One var, same name and wire format as shell/wsstate.sh (shells use only
 * busy|idle). Consumed by wezterm/workspace-status.lua, where blocked and idle
 * both read as "needs you". The escape sequence passes through `podman exec`
 * ptys untouched, so it works identically when pi runs inside a container.
 *
 * Why not pi's own OSC 7501 program status (pi ≥ 1.1.0): tmux does not
 * forward it, wezterm's Lua cannot read it, and it has no "parked on a timer"
 * state — after a timer `set` it reports "done", i.e. "needs you".
 *
 * Idle is reported at agent_settled, NOT agent_end: auto-retry, compaction
 * and queued continuations run after agent_end, and the workspace would
 * claim "needs you" while the agent keeps working.
 *
 * Timer detection uses only the timer tool's public contract (name + args),
 * the surface the LLM sees — timer.ts knows nothing about this file. The args
 * ride on tool_execution_start; the verdict (isError) on tool_execution_end,
 * which carries NO args, so the two are joined by toolCallId. A successful
 * `set` only means "armed" on the INTERACTIVE path (ctx.mode === "tui", the
 * same test timer.ts branches on): elsewhere timer BLOCKS inside the call and
 * returns with the wait already over.
 *
 * The park is a deadline derived from the same public contract: a successful
 * `set` parks until now + its `seconds` arg, a successful `cancel` ends it, a
 * later `set` replaces it. Runs before the deadline do NOT end it: timer.ts
 * keeps its timer across human-started runs, and retries and continuations
 * re-emit agent_start inside one run. Once the deadline has passed, the park is
 * consumed by the next run start (the wake run) or settle (the wake arrived as
 * an in-run steer, or timer.ts re-sends a stranded one at settle, which starts
 * a new run). One unref'd fallback timeout ends a park whose wake never arrives.
 *
 * The derived state is written on every relevant event, unchanged or not:
 * duplicate writes are harmless, and a fresh process overwrites whatever a
 * previous one left in the pane's var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildSession } from "./lib/child-context.ts";

type WsState = "busy" | "blocked" | "waiting" | "idle";

// The wake run starts slightly after expiry (a steer queued into pi's input
// loop), so an idle agent stays "waiting" this long past the deadline until the
// wake run's agent_start consumes the park. Past it, the fallback timeout ends
// the park: a wake that never came reads as idle / "needs you".
const WAKE_GRACE_MS = 30_000;

interface Status {
	running: boolean;
	prompting: boolean;
	timerDeadline: number | undefined;
}

function deriveState(s: Status): WsState {
	if (s.prompting) return "blocked";
	if (s.running) return "busy";
	if (s.timerDeadline !== undefined && Date.now() < s.timerDeadline + WAKE_GRACE_MS) return "waiting";
	return "idle";
}

function setUserVar(name: string, value: string): void {
	try {
		const b64 = Buffer.from(value).toString("base64");
		const osc = `\x1b]1337;SetUserVar=${name}=${b64}\x07`;
		// Inside tmux, wrap in DCS passthrough (ESC doubled) or tmux eats the
		// OSC before wezterm sees it.
		process.stdout.write(process.env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc);
	} catch {
		// never break the agent over a status ping
	}
}

interface TimerTracking {
	/** Drop args of calls whose end event never came (aborted calls). */
	clearPending: () => void;
	/** End the park and its fallback timeout. */
	disarm: () => void;
	/** End the park if its deadline has passed: the wake has had its chance. */
	consumeIfDue: () => void;
}

/** Park/unpark status.timerDeadline from timer tool calls; calls report() on a verdict. */
function trackTimer(pi: ExtensionAPI, status: Status, report: () => void): TimerTracking {
	// toolCallId → requested timer args, harvested at execution start and
	// consumed at execution end.
	const pendingArgs = new Map<string, { action?: unknown; seconds?: unknown }>();
	let fallback: ReturnType<typeof setTimeout> | undefined;

	function disarm() {
		if (fallback) clearTimeout(fallback);
		fallback = undefined;
		status.timerDeadline = undefined;
	}
	function arm(rawSeconds: unknown) {
		// Same coercion timer.ts gets from typebox Value.Convert ("300" → 300);
		// the event args are the raw, unconverted tool arguments.
		const seconds = Number(rawSeconds);
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		disarm();
		status.timerDeadline = Date.now() + seconds * 1000;
		fallback = setTimeout(() => {
			disarm();
			report();
		}, seconds * 1000 + WAKE_GRACE_MS);
		fallback.unref?.();
	}

	pi.on("tool_execution_start", (e, ctx) => {
		if ((ctx as { mode?: unknown }).mode !== "tui") return;
		if (e.toolName !== "timer") return;
		const args = e.args as { action?: unknown; seconds?: unknown } | undefined;
		if (args) pendingArgs.set(e.toolCallId, args);
	});

	pi.on("tool_execution_end", (e) => {
		if (e.toolName !== "timer") return;
		const args = pendingArgs.get(e.toolCallId);
		pendingArgs.delete(e.toolCallId);
		if (e.isError || !args) return;
		if (args.action === "set") arm(args.seconds);
		else if (args.action === "cancel") disarm();
		report();
	});

	function consumeIfDue() {
		if (status.timerDeadline !== undefined && Date.now() >= status.timerDeadline) disarm();
	}

	return { clearPending: () => pendingArgs.clear(), disarm, consumeIfDue };
}

export default function (pi: ExtensionAPI) {
	// Child sessions (Agent/Explore) load this file too and share the parent's
	// stdout: a child's run would flip the terminal state while the parent is
	// still mid-run. Terminal state is the MAIN session's story; children emit
	// nothing. inChildSession() is only meaningful during extension load/bind
	// (ALS scope) — exactly where this code runs (same pattern as timer.ts).
	if (inChildSession()) return;

	const status: Status = { running: false, prompting: false, timerDeadline: undefined };
	function report() {
		setUserVar("wsstate", deriveState(status));
	}
	const timer = trackTimer(pi, status, report);

	function reset() {
		timer.clearPending();
		timer.disarm();
		Object.assign(status, { running: false, prompting: false });
		report();
	}
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);

	// Retries and continuations re-emit agent_start inside one run; only the
	// first one is a run boundary where unfinished timer calls are stale and a
	// due park is consumed by the wake run.
	pi.on("agent_start", () => {
		if (!status.running) {
			timer.clearPending();
			timer.consumeIfDue();
		}
		status.running = true;
		report();
	});
	pi.on("agent_settled", () => {
		status.running = false;
		timer.consumeIfDue();
		report();
	});

	// Same set pi's own program status counts as blocked: select/confirm/
	// input/editor. "custom" is excluded — it is any extension overlay (e.g.
	// the Agent watch view, lib/child-watch.ts) that does not wait on an answer.
	pi.on("ui_prompt_start", (e) => {
		if (e.kind === "custom") return;
		status.prompting = true;
		report();
	});
	pi.on("ui_prompt_end", (e) => {
		if (e.kind === "custom") return;
		status.prompting = false;
		report();
	});
}
