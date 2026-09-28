/**
 * session-transcript: parseTranscript / readSessionStats against hand-built
 * session JSONL files. Pins the format rules the dashboard relies on — which
 * lines become entries, how tool results attach, where handoff anchors land,
 * and which usage rows count toward cost — plus tolerance for damaged lines.
 */

import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HANDOFF_SUMMARY_TYPE, SWAP_MARKER_TYPE } from "../lib/message-types.ts";
import { parseTranscript, readSessionStats } from "../lib/session-transcript.ts";
import { at } from "./assert-helpers.ts";

function sessionFile(lines: (object | string)[]): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-session-transcript-"));
	const file = path.join(dir, "s.jsonl");
	writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
	return file;
}

const message = (msg: object, timestamp = "2025-01-01T00:00:00.000Z") => ({ type: "message", timestamp, message: msg });
const usage = (total: number) => ({ cost: { total } });

test("parseTranscript: user/assistant entries, tool calls matched to results, damaged lines skipped", () => {
	const file = sessionFile([
		{ type: "session", id: "s" },
		"",
		"{torn line",
		"42",
		message({ role: "user", content: "hi" }),
		message({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }, "not a date"),
		message({
			role: "assistant",
			timestamp: 1234,
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "one" },
				"junk",
				{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "x".repeat(500) } },
				{ type: "toolCall", id: "c2", name: "read" },
				{ type: "toolCall", id: "c3" }, // no name: dropped
				{ type: "toolCall", name: "edit" }, // no id: never gets output
				{ type: "text", text: "two" },
			],
		}),
		message({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "y".repeat(2500) }] }),
		message({ role: "toolResult", toolCallId: "c2", isError: true, content: "boom" }),
		message({ role: "toolResult", toolCallId: "nope", content: "lost" }),
		message({ role: "bashExecution", command: "ls" }),
		{ type: "message", message: "not an object" },
		{ type: "model_change" },
	]);
	const parsed = parseTranscript(file);
	assert.ok(parsed);
	assert.deepEqual(
		parsed.entries.map((entry) => [entry.role, entry.text, entry.tsMs]),
		[
			["user", "hi", Date.parse("2025-01-01T00:00:00.000Z")],
			["user", "a\nb", null],
			["assistant", "one\ntwo", 1234],
		],
	);
	const calls = at(parsed.entries, 2).toolCalls;
	assert.deepEqual(
		calls.map((call) => call.name),
		["bash", "read", "edit"],
	);
	assert.equal(at(calls, 0).argsSummary, JSON.stringify({ cmd: "x".repeat(500) }).slice(0, 400) + "… [truncated]");
	assert.equal(at(calls, 0).output, "y".repeat(2000) + "… [truncated]");
	assert.equal(at(calls, 1).argsSummary, "{}", "missing arguments → {}");
	assert.equal(at(calls, 1).output, "[tool error] boom");
	assert.equal(at(calls, 2).output, "");
	assert.deepEqual(parsed.handoffEntryIndexes, []);
});

test("parseTranscript: handoff markers anchor at the next entry, clamped to the last one", () => {
	const file = sessionFile([
		{ type: "custom_message", customType: SWAP_MARKER_TYPE },
		message({ role: "user", content: "a" }),
		{ type: "custom_message", customType: "something-else" },
		{ type: "custom_message" },
		message({ role: "user", content: "b" }),
		{ type: "custom_message", customType: HANDOFF_SUMMARY_TYPE },
	]);
	assert.deepEqual(parseTranscript(file)?.handoffEntryIndexes, [0, 1]);
	assert.deepEqual(parseTranscript(sessionFile([{ type: "custom_message", customType: SWAP_MARKER_TYPE }])), {
		entries: [],
		handoffEntryIndexes: [0],
	});
});

test("readSessionStats: assistant + entry-level usage count, toolResult/user usage excluded, turns = assistant messages", () => {
	const file = sessionFile([
		{ type: "session", id: "s" },
		"{torn",
		"null",
		message({ role: "user", content: "hi", usage: usage(9) }),
		message({ role: "assistant", content: [], usage: usage(0.5) }),
		message({ role: "assistant", content: [] }),
		message({ role: "assistant", content: [], usage: { cost: { total: "1" } } }),
		message({ role: "toolResult", toolCallId: "c", content: "", usage: usage(7) }),
		{ type: "compaction", usage: usage(0.25) },
		{ type: "branch_summary", usage: usage(0.125) },
		{ type: "model_change" },
	]);
	assert.deepEqual(readSessionStats(file), { costUsd: 0.875, turns: 3, mtimeMs: statSync(file).mtimeMs });
});

test("unreadable file → null from both readers", () => {
	const missing = path.join(tmpdir(), "pi-session-transcript-missing", "nope.jsonl");
	assert.equal(parseTranscript(missing), null);
	assert.equal(readSessionStats(missing), null);
});
