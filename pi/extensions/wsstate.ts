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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildSession } from "./lib/child-context.ts";

type WsState = "busy" | "blocked" | "waiting" | "idle";

interface Status {
	running: boolean;
	prompting: boolean;
	timerArmed: boolean;
}

function deriveState(s: Status): WsState {
	if (s.prompting) return "blocked";
	if (s.running) return "busy";
	if (s.timerArmed) return "waiting";
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

/** Arm/disarm status.timerArmed from timer tool calls; calls report() on a verdict. */
function trackTimer(pi: ExtensionAPI, status: Status, report: () => void): () => void {
	// toolCallId → requested timer action, harvested at execution start and
	// consumed at execution end. clear() drops stragglers at run/session
	// boundaries (an aborted call may never see its end event).
	const pendingAction = new Map<string, string>();

	pi.on("tool_execution_start", (e, ctx) => {
		if ((ctx as { mode?: unknown }).mode !== "tui") return;
		if (e.toolName !== "timer") return;
		const action = (e.args as { action?: string } | undefined)?.action;
		if (typeof action === "string") pendingAction.set(e.toolCallId, action);
	});

	pi.on("tool_execution_end", (e) => {
		if (e.toolName !== "timer") return;
		const action = pendingAction.get(e.toolCallId);
		pendingAction.delete(e.toolCallId);
		if (e.isError) return;
		if (action === "set") status.timerArmed = true;
		else if (action === "cancel") status.timerArmed = false;
		report();
	});

	return () => pendingAction.clear();
}

export default function (pi: ExtensionAPI) {
	// Child sessions (Agent/Explore) load this file too and share the parent's
	// stdout: a child's run would flip the terminal state while the parent is
	// still mid-run. Terminal state is the MAIN session's story; children emit
	// nothing. inChildSession() is only meaningful during extension load/bind
	// (ALS scope) — exactly where this code runs (same pattern as timer.ts).
	if (inChildSession()) return;

	const status: Status = { running: false, prompting: false, timerArmed: false };
	let lastSent: WsState | undefined;
	function report() {
		const next = deriveState(status);
		if (next === lastSent) return;
		lastSent = next;
		setUserVar("wsstate", next);
	}
	const clearPending = trackTimer(pi, status, report);

	function reset() {
		clearPending();
		Object.assign(status, { running: false, prompting: false, timerArmed: false });
		// Always send: the pane's var may still hold a previous process's state.
		lastSent = undefined;
		report();
	}
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);

	// A wake always starts a run (timer expiry injects a user message), and a
	// human typing also starts one — either way the park is over. No second
	// clock here: durations stay owned by timer.ts.
	pi.on("agent_start", () => {
		clearPending();
		Object.assign(status, { running: true, timerArmed: false });
		report();
	});
	pi.on("agent_settled", () => {
		status.running = false;
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
