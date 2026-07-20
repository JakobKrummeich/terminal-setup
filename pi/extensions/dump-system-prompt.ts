/**
 * dump-system-prompt.ts
 *
 * On the first provider request of each session, extracts the actual system
 * instructions from the wire payload and dumps them to a temp file.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DUMP_FILE = join(tmpdir(), `pi-system-prompt-${process.pid}.txt`);

/** Extract system instructions from a provider wire payload (best effort). */
function extractWireSystemPrompt(payload: any): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;

	// Anthropic messages API: payload.system is a string or array of text blocks
	if (typeof payload.system === "string") return payload.system;
	if (Array.isArray(payload.system)) {
		return payload.system
			.map((b: any) => (typeof b === "string" ? b : b?.text ?? ""))
			.join("\n");
	}

	// OpenAI responses API: payload.instructions
	if (typeof payload.instructions === "string") return payload.instructions;

	// OpenAI completions API: leading system/developer messages
	if (Array.isArray(payload.messages)) {
		const sys = payload.messages.filter(
			(m: any) => m?.role === "system" || m?.role === "developer",
		);
		if (sys.length > 0) {
			return sys
				.map((m: any) =>
					typeof m.content === "string"
						? m.content
						: (m.content ?? []).map((c: any) => c?.text ?? "").join("\n"),
				)
				.join("\n");
		}
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	let wireCaptured = false;

	pi.on("session_start", async () => {
		wireCaptured = false;
	});

	// Capture the actual system instructions from the first wire payload.
	pi.on("before_provider_request", (event, ctx) => {
		if (wireCaptured) return;
		const sys = extractWireSystemPrompt(event.payload);
		if (sys === undefined) return;
		wireCaptured = true;
		try {
			writeFileSync(DUMP_FILE, sys);
			if (ctx.hasUI) {
				ctx.ui.notify(`Wire system prompt saved: ${DUMP_FILE}`, "info");
			}
		} catch {
			// best effort
		}
	});
}
