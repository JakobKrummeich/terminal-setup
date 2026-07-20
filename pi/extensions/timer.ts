/**
 * Timer — lets the agent wake itself after starting a long-running background task.
 *
 * The agent sets a single timer; on expiry a user message is injected
 * ("Timer '{name}' expired. Continue your task.") which triggers a new turn.
 * This closes the "started task in background, ended turn, needs user poke" loop.
 *
 * One timer at a time; setting a new one replaces the old (stated in result).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

	function clearActive(): ActiveTimer | undefined {
		const prev = active;
		if (prev) clearTimeout(prev.timeout);
		active = undefined;
		return prev;
	}

	pi.on("session_shutdown", () => {
		clearActive();
	});

	pi.registerTool({
		name: "timer",
		label: "Timer",
		description:
			"For long tasks (build, tests, deploy, download): start task in background, set timer, end turn. Expiry injects message waking you to check result. One timer; new set replaces old.",
		parameters: timerParams,

		async execute(_toolCallId, params) {
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
				try {
					pi.sendUserMessage(`Timer "${name}" expired. Continue your task.`, {
						deliverAs: "followUp",
					});
				} catch (e) {
					console.warn("[timer] failed to deliver expiry message:", e);
				}
			}, params.seconds * 1000);
			timeout.unref?.();

			active = { name, timeout, expiresAt };

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
