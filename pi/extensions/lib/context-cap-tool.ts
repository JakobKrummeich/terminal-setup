/**
 * The `context_handoff` tool (CONTEXT_CAP_TOOL_NAME): the agent passes the
 * handoff markdown, the EXTENSION writes the file host-side and records the body
 * as `cycle.doc`, the successor text's only source. Cap demands and /handoff
 * both ask for it. Why a tool and not a file write by the agent (sandboxed
 * setups): header of context-cap.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CapSession, writeCycleHandoff } from "./context-cap-session.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_TOOL_NAME } from "./env.ts";
import { recordedMessage } from "./context-cap-messages.ts";
import { handoffLineBudget } from "./handoff-writer.ts";
import { registerCompactCallRenderer } from "./tool-call-render.ts";

// Always active, on every model, from the first request — never added late with
// setActiveTools. Tool declarations sit at the front of the cached prompt prefix.
// Some providers can declare a tool mid-conversation without touching that prefix
// (Anthropic `tool_addition` blocks, OpenAI Responses `additional_tools` items),
// but only while pi keeps its in-conversation system messages in place, and two
// things in this setup collapse them into the leading one, which rebuilds the
// top-level tool list (a full cache miss at ~260k tokens): caveman-prompt.ts
// forces the system prompt on every run, and this extension's own post-swap
// `context` slice makes pi fold them (runner.js restoreSystemMessages). Measured
// against pi 1.5's real payload builders for claude-opus-5-5 and gpt-6-luna;
// test/context-cap-cache.test.ts pins that the tool list never changes across a
// cycle. The ~100 tokens per request are the price. A call without a committed
// demand is refused harmlessly (executeHandoff).
export function registerHandoffTool(pi: Pick<ExtensionAPI, "registerTool" | "registerToolRenderer">, s: CapSession): void {
	pi.registerTool({
		name: CONTEXT_CAP_TOOL_NAME,
		label: "Context handoff",
		description:
			"INTERNAL — handoff machinery. Call this ONLY when a [context-cap] message or a /handoff request explicitly " +
			"asks for it. Never call it on your own initiative, and never because a handoff/summary sounds useful: calling " +
			"it ends your session and hands the text you pass to your successor.",
		parameters: Type.Object({
			markdown: Type.String({
				description: `Handoff body, plain markdown, no YAML frontmatter. First section must be '## Current Task'. ~${handoffLineBudget(CONTEXT_CAP_SCHEMA)} lines.`,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeHandoff(s, params.markdown, ctx);
		},
	});
	// Line count only: the body itself is rendered once, by the swap marker.
	registerCompactCallRenderer(pi, CONTEXT_CAP_TOOL_NAME, (args: { markdown?: unknown } | undefined) =>
		handoffCallSummary(args?.markdown),
	);
}

/** `(N lines)` of a (possibly still streaming) handoff body; empty before any text arrived. */
export function handoffCallSummary(markdown: unknown): string {
	const body = typeof markdown === "string" ? markdown.trim() : "";
	if (!body) return "";
	const lines = body.split("\n").length;
	return `(${lines} ${lines === 1 ? "line" : "lines"})`;
}

type HandoffToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
	isError?: true;
	terminate?: true;
};

function toolError(text: string): HandoffToolResult {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

/**
 * A demand entry of the current cycle is in the agent's context. Not merely an
 * armed cycle: message_end arms it before that same message's tool calls run,
 * so a call in the message that crossed the cap was made without any demand.
 */
function committedPath(s: CapSession): string | undefined {
	const { phase, expectedPath } = s.cycle;
	return phase === "demanded" || phase === "exhausted" ? expectedPath : undefined;
}

function executeHandoff(s: CapSession, markdown: string, ctx: ExtensionContext): HandoffToolResult {
	const filePath = committedPath(s);
	if (!filePath) {
		return toolError(
			"Refused: no handoff was requested. Call this tool only when a [context-cap] message or a /handoff request asks for it. Nothing was written; continue your work.",
		);
	}
	const body = markdown.trim();
	if (!body) return toolError("Refused: 'markdown' is empty. Call again with the handoff body.");
	try {
		writeCycleHandoff(s, ctx, filePath, body, "agent");
	} catch (e) {
		// Host-side write failed (disk full, permissions). Report so the agent
		// can retry; the hard cap remains the backstop.
		return toolError(`Handoff write failed: ${e instanceof Error ? e.message : e}`);
	}
	const text = recordedMessage(s.cycle.ending);
	// New-session ending: nothing follows in this window, so stop the loop right
	// after this tool batch instead of one more model call (pi stops only when
	// every call of the batch asks to).
	if (s.cycle.ending === "new-session") return { content: [{ type: "text", text }], details: {}, terminate: true };
	return { content: [{ type: "text", text }], details: {} };
}
