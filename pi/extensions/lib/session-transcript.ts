/**
 * session-transcript — the ONE module that knows pi's session JSONL format.
 *
 * Everything that reads a session transcript (dashboard cost/turn stats,
 * /api/transcript rendering) goes through here, so a `pi update` that shifts
 * the format has exactly one place to re-verify (same risk class as
 * markdown-no-padding.ts; see docs/agent-dashboard-spec.md "Risks").
 *
 * Format, as of session version 3 (authoritative types in pi's dist:
 * core/session-manager.d.ts, core/messages.d.ts, pi-ai types.d.ts):
 *  - line 1: { type: "session", id, timestamp, cwd, ... } header
 *  - then entries { type, id, parentId, timestamp (ISO), ... }:
 *      type "message"        → { message: { role: "user"|"assistant"|"toolResult"|..., ... } }
 *        user      : content = string | [{type:"text",text}|{type:"image",...}]
 *        assistant : content = [{type:"text"|"thinking"|"toolCall",...}], usage.cost.total (USD),
 *                    message.timestamp = epoch ms
 *        toolResult: { toolCallId, toolName, content, isError } — matched to the
 *                    assistant toolCall by id, never its own transcript entry
 *      type "custom_message" → { customType, ... } (context-cap/handoff markers)
 *      type "compaction" | "branch_summary" → entry-level usage.cost.total
 *      anything else (model_change, label, custom, ...) → skipped
 *
 * Entries link by id/parentId into a tree; this parser walks FILE ORDER and
 * ignores branching (accepted v1 simplification — in-file branches are rare,
 * forks get their own file). Damaged lines are skipped, never fatal.
 */
import { readFileSync, statSync } from "node:fs";
import type { SessionFileStats, TranscriptEntry, TranscriptToolCall } from "./dashboard-api.ts";
import { HANDOFF_SUMMARY_TYPE, SWAP_MARKER_TYPE } from "./message-types.ts";

/** Tool outputs beyond this are cut (spec: transcript view truncates ~2000 chars). */
const OUTPUT_LIMIT = 2000;
/** Tool-call argument JSON beyond this is cut — args are a summary, not a payload. */
const ARGS_LIMIT = 400;
const TRUNCATION_MARK = "… [truncated]";

/** customType values that mark a context handoff in the transcript (writers: context-cap.ts, handoff.ts). */
const HANDOFF_CUSTOM_TYPES: ReadonlySet<string> = new Set([SWAP_MARKER_TYPE, HANDOFF_SUMMARY_TYPE]);

export interface ParsedTranscript {
	entries: TranscriptEntry[];
	/** Entry indexes where a context handoff happened (anchor targets), ascending. */
	handoffEntryIndexes: number[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? text.slice(0, limit) + TRUNCATION_MARK : text;
}

/** Text of a message content field: plain string, or the text parts of a part array. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		const rec = asRecord(part);
		if (rec?.type === "text" && typeof rec.text === "string") texts.push(rec.text);
	}
	return texts.join("\n");
}

/** Message timestamp (epoch ms), falling back to the entry's ISO timestamp. */
function entryTsMs(message: Record<string, unknown>, line: Record<string, unknown>): number | null {
	if (typeof message.timestamp === "number") return message.timestamp;
	if (typeof line.timestamp === "string") {
		const parsed = Date.parse(line.timestamp);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}

/** A toolCall content part → its summary, registered by id so the matching toolResult can fill its output. */
function toolCallPart(rec: Record<string, unknown>, callsById: Map<string, TranscriptToolCall>): TranscriptToolCall | null {
	if (rec.type !== "toolCall" || typeof rec.name !== "string") return null;
	const call: TranscriptToolCall = {
		name: rec.name,
		argsSummary: truncate(JSON.stringify(rec.arguments ?? {}), ARGS_LIMIT),
		output: "",
	};
	if (typeof rec.id === "string") callsById.set(rec.id, call);
	return call;
}

function assistantEntry(
	message: Record<string, unknown>,
	line: Record<string, unknown>,
	callsById: Map<string, TranscriptToolCall>,
): TranscriptEntry {
	const texts: string[] = [];
	const toolCalls: TranscriptToolCall[] = [];
	const content = Array.isArray(message.content) ? message.content : [];
	for (const part of content) {
		const rec = asRecord(part);
		if (!rec) continue;
		if (rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
		const call = toolCallPart(rec, callsById);
		if (call) toolCalls.push(call);
	}
	return { role: "assistant", text: texts.join("\n"), toolCalls, tsMs: entryTsMs(message, line) };
}

/** Fill the matching toolCall's output; results never become their own entries. */
function attachToolResult(message: Record<string, unknown>, callsById: Map<string, TranscriptToolCall>): void {
	if (typeof message.toolCallId !== "string") return;
	const call = callsById.get(message.toolCallId);
	if (!call) return;
	const text = contentText(message.content);
	call.output = truncate(message.isError === true ? `[tool error] ${text}` : text, OUTPUT_LIMIT);
}

/** Fold one `type: "message"` line's message into the transcript being built. */
function appendMessage(
	message: Record<string, unknown>,
	line: Record<string, unknown>,
	entries: TranscriptEntry[],
	callsById: Map<string, TranscriptToolCall>,
): void {
	if (message.role === "user") {
		entries.push({ role: "user", text: contentText(message.content), toolCalls: [], tsMs: entryTsMs(message, line) });
	} else if (message.role === "assistant") {
		entries.push(assistantEntry(message, line, callsById));
	} else if (message.role === "toolResult") {
		attachToolResult(message, callsById);
	}
	// other roles (bashExecution, custom, branchSummary, ...) skipped in v1
}

/** Fold one parsed JSONL line into the transcript being built. */
function appendLine(
	line: Record<string, unknown>,
	entries: TranscriptEntry[],
	handoffEntryIndexes: number[],
	callsById: Map<string, TranscriptToolCall>,
): void {
	if (line.type === "custom_message") {
		if (typeof line.customType === "string" && HANDOFF_CUSTOM_TYPES.has(line.customType)) {
			handoffEntryIndexes.push(entries.length); // anchors at the next entry; clamped by the caller
		}
		return;
	}
	if (line.type !== "message") return; // header, model_change, compaction, ... — not transcript entries
	const message = asRecord(line.message);
	if (message) appendMessage(message, line, entries, callsById);
}

/** Object lines of a session JSONL, in file order. Torn/damaged lines (live file mid-append) and non-objects are skipped. */
function* jsonRecords(content: string): Generator<Record<string, unknown>> {
	for (const rawLine of content.split("\n")) {
		if (!rawLine.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawLine);
		} catch {
			continue;
		}
		const line = asRecord(parsed);
		if (line) yield line;
	}
}

/** Parse a session JSONL into transcript entries; null when the file is unreadable. */
export function parseTranscript(file: string): ParsedTranscript | null {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const entries: TranscriptEntry[] = [];
	const handoffEntryIndexes: number[] = [];
	const callsById = new Map<string, TranscriptToolCall>();
	for (const line of jsonRecords(content)) appendLine(line, entries, handoffEntryIndexes, callsById);
	const lastIndex = Math.max(0, entries.length - 1);
	return { entries, handoffEntryIndexes: handoffEntryIndexes.map((i) => Math.min(i, lastIndex)) };
}

/**
 * Cost paid inside this entry line, in USD.
 * Assistant messages carry usage.cost.total; compaction/branch_summary entries
 * carry entry-level usage. toolResult usage is deliberately EXCLUDED: subagent
 * tool results would double-count children already summed from finish rows.
 * Cost of that exclusion: pi's own usage-totals counts toolResult usage as a
 * distinct "Tools/summaries" bucket (built-in LLM-backed tools), so dashboard
 * cost undercounts pi's totals when such tools run — accepted v1 tradeoff.
 */
function entryCostUsd(line: Record<string, unknown>): number {
	const message = asRecord(line.message);
	const usage = message ? (message.role === "assistant" ? asRecord(message.usage) : null) : asRecord(line.usage);
	const total = asRecord(usage?.cost)?.total;
	return typeof total === "number" ? total : 0;
}

/**
 * Cheap one-pass stats for a session file: own cost, assistant-message count
 * ("turns"), and mtime (liveness heuristic input). null when unreadable.
 */
export function readSessionStats(file: string): SessionFileStats | null {
	let content: string;
	let mtimeMs: number;
	try {
		content = readFileSync(file, "utf8");
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return null;
	}
	let costUsd = 0;
	let turns = 0;
	for (const line of jsonRecords(content)) {
		costUsd += entryCostUsd(line);
		if (line.type === "message" && asRecord(line.message)?.role === "assistant") turns += 1;
	}
	return { costUsd, turns, mtimeMs };
}
