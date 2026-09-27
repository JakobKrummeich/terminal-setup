/**
 * Plain text of a pi message's `content`: a string as-is (user/custom
 * messages), or the text blocks of a content array joined with "\n" (image,
 * thinking and tool-call blocks dropped). Anything else yields "".
 *
 * lib/session-transcript.ts keeps its own contentText on purpose: it skips text
 * blocks whose `text` is not a string, where this emits an empty line for them.
 * Pure; no pi imports.
 */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => (block as { type?: unknown } | null)?.type === "text")
		.map((block) => (block as { text?: string }).text ?? "")
		.join("\n");
}
