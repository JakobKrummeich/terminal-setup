/**
 * wsstate — report agent busy/idle to wezterm via OSC 1337 SetUserVar.
 *
 * busy  = agent turn running (agent_start)
 * idle  = turn finished / session start / shutdown
 *
 * The escape sequence passes through `podman exec` ptys untouched, so it
 * works identically when pi runs inside a container.
 * Consumed by wezterm/workspace-status.lua (workspace aggregation).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function emit(state: "busy" | "idle") {
	try {
		const b64 = Buffer.from(state).toString("base64");
		const osc = `\x1b]1337;SetUserVar=wsstate=${b64}\x07`;
		// Inside tmux, wrap in DCS passthrough (ESC doubled) or tmux eats the
		// OSC before wezterm sees it. Same pattern as shell/wsstate.sh.
		process.stdout.write(process.env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc);
	} catch {
		// never break the agent over a status ping
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => emit("idle"));
	pi.on("agent_start", () => emit("busy"));
	pi.on("agent_end", () => emit("idle"));
	pi.on("session_shutdown", () => emit("idle"));
}
