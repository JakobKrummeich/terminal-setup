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

/** `value[key]` when value is a non-null object, else undefined (the payload is untyped wire JSON). */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** A content block's text: string blocks as-is, `{ text }` blocks by field, anything else "". */
function blockText(block: unknown): unknown {
	return typeof block === "string" ? block : field(block, "text") ?? "";
}

/** Extract system instructions from a provider wire payload (best effort). Exported for tests. */
export function extractWireSystemPrompt(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;

	// Anthropic messages API: payload.system is a string or array of text blocks
	const system = field(payload, "system");
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return system.map(blockText).join("\n");

	// OpenAI responses API: payload.instructions
	const instructions = field(payload, "instructions");
	if (typeof instructions === "string") return instructions;

	// OpenAI completions API: leading system/developer messages
	return systemMessagesText(field(payload, "messages"));
}

/** OpenAI completions API: system/developer messages' text joined; undefined when there are none. */
function systemMessagesText(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	const sys = messages.filter((m) => field(m, "role") === "system" || field(m, "role") === "developer");
	if (sys.length === 0) return undefined;
	return sys
		.map((m) => {
			const content = field(m, "content");
			if (typeof content === "string") return content;
			return Array.isArray(content) ? content.map((c) => field(c, "text") ?? "").join("\n") : "";
		})
		.join("\n");
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
