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
 * same surface the LLM sees. Aggregation lives in wezterm/workspace-status.lua.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	let waiting = false;

	function set(next: boolean) {
		waiting = next;
		emit(waiting ? "waiting" : "free");
	}

	pi.on("session_start", () => set(false));
	pi.on("session_shutdown", () => set(false));

	// A wake always starts a turn (timer expiry injects a user message), and a
	// human typing also starts one — either way the park is over. No second
	// clock here: durations stay owned by timer.ts.
	pi.on("agent_start", () => set(false));

	pi.on("tool_execution_end", (e) => {
		if (e.toolName !== "timer" || e.isError) return;
		const action = (e.args as { action?: string } | undefined)?.action;
		if (action === "set") waiting = true;
		else if (action === "cancel") waiting = false;
	});

	// Emit at turn end: that is the moment wsstate flips to idle and the
	// workspace would otherwise claim it needs you.
	pi.on("agent_end", () => emit(waiting ? "waiting" : "free"));
}
