// What a child-session tool call hands back to the parent: the tool-result shape
// (textResult), the end-of-run result with its resume_id trailer (childRunResult)
// and the shared renderResult() of Agent/Explore (renderChildResult).
// Split out of lib/child-session.ts to keep that hot file under the 300-line gate.
import type { TextContent } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { failureText, type RunOutcome } from "./child-outcome.ts";
import { collectMeta, metaLine, type RunMeta } from "./child-runs.ts";
import type { ChildRecord } from "./child-types.ts";
import { messageText } from "./message-text.ts";

export function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text }] as TextContent[],
		details,
		...(isError && { isError: true }),
	};
}

export function childRunResult(record: ChildRecord, kind: string, outcome: RunOutcome, signal: AbortSignal | undefined) {
	const trailer = `\n\n---\n${kind} id: ${record.id} (pass as resume_id to continue)`;
	const details = { ...collectMeta(record), aborted: signal?.aborted === true };
	if (outcome.error !== undefined && !details.aborted) {
		return textResult(`${failureText(kind, outcome.error, outcome)}${trailer}`, { ...details, error: "child_failed" }, true);
	}
	return textResult(`${outcome.text || `(${kind} produced no text output)`}${trailer}`, details);
}

/** Shared renderResult() for child-session tools. */
export function renderChildResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
	theme: Pick<Theme, "fg">,
	context: { lastComponent?: unknown },
) {
	const text = messageText(result.content);
	const meta = result.details as RunMeta | undefined;
	const summary = meta?.kind ? theme.fg("toolTitle", metaLine(meta)) : "";
	const body = theme.fg("toolOutput", text);
	const component = (context.lastComponent as Text) ?? new Text("", 0, 0);
	component.setText([summary, body].filter(Boolean).join("\n"));
	return component;
}
