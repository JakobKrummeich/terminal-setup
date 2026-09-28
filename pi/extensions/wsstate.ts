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
import { inChildSession } from "./lib/child-context.ts";
import { setUserVar } from "./lib/wezterm-uservar.ts";

function emit(state: "busy" | "idle") {
	setUserVar("wsstate", state);
}

export default function (pi: ExtensionAPI) {
	// Child sessions (Agent/Explore) load this file too and share the parent's
	// stdout: a child's agent_end would flip the terminal to "idle" while the
	// parent is still mid-run — and stay wrong until the parent's next turn
	// boundary. Terminal state is the MAIN session's story; children emit nothing.
	// inChildSession() is only meaningful during extension load/bind (ALS scope) —
	// exactly where this code runs (same pattern as agent-dash.ts / subagent.ts).
	if (inChildSession()) return;

	pi.on("session_start", () => emit("idle"));
	pi.on("agent_start", () => emit("busy"));
	pi.on("agent_end", () => emit("idle"));
	pi.on("session_shutdown", () => emit("idle"));
}
