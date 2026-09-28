/**
 * The `context_handoff` tool (CONTEXT_CAP_TOOL_NAME): the agent passes the
 * handoff markdown, the EXTENSION writes the file host-side. Why a tool and not
 * a file write by the agent (sandboxed setups): header of context-cap.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CapSession, writeCycleHandoff } from "./context-cap-session.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_TOOL_NAME } from "./env.ts";
import { handoffLineBudget } from "./handoff-writer.ts";

// Always active (never hidden): tool definitions are part of the cached prompt
// prefix, so toggling them mid-session would invalidate the provider prompt
// cache at ~260k tokens — far pricier than the ~100 tokens this always costs.
// setActiveTools also only takes effect on the NEXT turn, i.e. not on the very
// turn the soft-cap steer lands, which is exactly when the tool is needed.
export function registerHandoffTool(pi: Pick<ExtensionAPI, "registerTool">, s: CapSession): void {
	pi.registerTool({
		name: CONTEXT_CAP_TOOL_NAME,
		label: "Context handoff",
		description:
			"INTERNAL — context-cap machinery. Call this ONLY when a [context-cap] message explicitly instructs you to. " +
			"Never call it on your own initiative, and never because a handoff/summary sounds useful: calling it discards " +
			"your entire context and replaces it with the text you pass. For a user-requested summary, write a normal reply.",
		parameters: Type.Object({
			markdown: Type.String({
				description: `Handoff body, plain markdown, no YAML frontmatter. First section must be '## Current Task'. ~${handoffLineBudget(CONTEXT_CAP_SCHEMA)} lines.`,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeHandoff(s, params.markdown, ctx);
		},
	});
}

type HandoffToolResult = { content: { type: "text"; text: string }[]; details: Record<string, never>; isError?: true };

function toolError(text: string): HandoffToolResult {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

function executeHandoff(s: CapSession, markdown: string, ctx: ExtensionContext): HandoffToolResult {
	if (!s.cycle.expectedPath || s.cycle.phase === "idle") {
		return toolError(
			"Refused: no handoff was requested. This tool may only be called after a [context-cap] instruction. Nothing was written; continue your work.",
		);
	}
	const body = markdown.trim();
	if (!body) return toolError("Refused: 'markdown' is empty. Call again with the handoff body.");
	try {
		writeCycleHandoff(s, ctx, s.cycle.expectedPath, body, "agent");
	} catch (e) {
		// Host-side write failed (disk full, permissions). Report so the agent
		// can retry; the hard cap remains the backstop.
		return toolError(`Handoff write failed: ${e instanceof Error ? e.message : e}`);
	}
	s.cycle.handoffWritten = true;
	return {
		content: [
			{
				type: "text" as const,
				text: "Handoff recorded. End your turn now (no further tool calls) — your context is replaced immediately afterwards.",
			},
		],
		details: {},
	};
}
