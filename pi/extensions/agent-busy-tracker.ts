/**
 * agent-busy-tracker — report "agent needs a human" to wezterm via OSC 1337 SetUserVar.
 *
 * Second axis on top of wsstate:
 *   wsstate = busy|idle    — is the agent streaming right now?
 *   wswait  = waiting|free — is the agent parked but able to wake itself?
 *
 * Between turns the agent can still be unavailable: it set a timer, ended its
 * turn, and the expiry message will start a new turn. wsstate correctly says
 * idle (nothing streaming), but the workspace must NOT show "needs you".
 *
 * Deliberately standalone: timer.ts and wsstate.ts know nothing about this
 * file. Detection uses the timer tool's public contract (name + args), the
 * same surface the LLM sees. The args ride on tool_execution_start; the
 * verdict (isError) on tool_execution_end — pi's end event carries NO args
 * (agent-session.js builds it from toolCallId/toolName/result/isError only),
 * so the two are joined by toolCallId. Aggregation lives in
 * wezterm/workspace-status.lua.
 *
 * A successful timer `set` only means "armed" on the INTERACTIVE path
 * (ctx.mode === "tui", the same test timer.ts itself branches on): everywhere
 * else timer BLOCKS inside the tool call and returns with the wait already
 * over — nothing stays armed, so arming here would report a stale "waiting".
 * Child sessions never get that far: they share the parent's stdout, so this
 * extension registers nothing in them at all (inChildSession guard).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildSession } from "./lib/child-session.ts";

function emit(state: "waiting" | "free") {
	try {
		const b64 = Buffer.from(state).toString("base64");
		const osc = `\x1b]1337;SetUserVar=wswait=${b64}\x07`;
		// Inside tmux, wrap in DCS passthrough (ESC doubled) or tmux eats the
		// OSC before wezterm sees it. Same pattern as shell/wsstate.sh.
		process.stdout.write(process.env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc);
	} catch {
		// never break the agent over a status ping
	}
}

export default function (pi: ExtensionAPI) {
	// Children share the parent's terminal; their timers block (print mode) and
	// never park anything. Same load/bind-time guard as wsstate.ts.
	if (inChildSession()) return;

	let waiting = false;
	// toolCallId → requested timer action, harvested at execution start. Entries
	// are consumed at execution end; turn/session boundaries clear stragglers
	// (an aborted call may never see its end event).
	const pendingAction = new Map<string, string>();

	function set(next: boolean) {
		waiting = next;
		emit(waiting ? "waiting" : "free");
	}

	pi.on("session_start", () => {
		pendingAction.clear();
		set(false);
	});
	pi.on("session_shutdown", () => {
		pendingAction.clear();
		set(false);
	});

	// A wake always starts a turn (timer expiry injects a user message), and a
	// human typing also starts one — either way the park is over. No second
	// clock here: durations stay owned by timer.ts.
	pi.on("agent_start", () => {
		pendingAction.clear();
		set(false);
	});

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
		if (action === "set") waiting = true;
		else if (action === "cancel") waiting = false;
	});

	// Emit at turn end: that is the moment wsstate flips to idle and the
	// workspace would otherwise claim it needs you.
	pi.on("agent_end", () => emit(waiting ? "waiting" : "free"));
}
