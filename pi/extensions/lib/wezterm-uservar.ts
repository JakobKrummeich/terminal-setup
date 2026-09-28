/**
 * wezterm-uservar — set a wezterm user var via OSC 1337 SetUserVar.
 *
 * Shared by wsstate.ts (wsstate) and agent-busy-tracker.ts (wswait); consumed
 * by wezterm/workspace-status.lua. Same wire format as shell/wsstate.sh.
 * The escape sequence passes through `podman exec` ptys untouched.
 */

export function setUserVar(name: string, value: string): void {
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
