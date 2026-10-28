/**
 * lib/child-runs.ts: the meta/status text of a child run (F2 picker/header via
 * metaLine, F2 viewport via formatDuration, Agent/Explore tool result details
 * via collectMeta) and the progress-row write throttle of agent-runs.jsonl.
 * Integration tests only reach the common shapes (a "1m05s" duration, a known
 * context usage, resets from one context_handoff call); these pin the rest.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runsFilePath } from "../lib/agent-runs.ts";
import {
	collectMeta,
	formatDuration,
	metaLine,
	type RunMeta,
	statusLine,
	writeProgressEvent,
} from "../lib/child-runs.ts";
import type { ChildRecord } from "../lib/child-types.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";

interface FakeSession {
	dir?: string;
	entries?: Array<{ type?: string }>;
	messages?: Array<{ role: string; content?: unknown }>;
	usage?: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

/** A ChildRecord with just the session surface child-runs.ts reads. */
function fakeRecord(session: FakeSession = {}, fields: Partial<ChildRecord> = {}): ChildRecord {
	return {
		id: "c1",
		kind: "agent",
		sid: "sid-c1",
		rootSid: "root",
		description: "desc",
		turns: 0,
		elapsedMs: 0,
		running: true,
		session: {
			sessionManager: { getSessionDir: () => session.dir ?? "", getEntries: () => session.entries ?? [] },
			messages: session.messages ?? [],
			getSessionStats: () => ({ cost: 0.25 }),
			getContextUsage: () => session.usage,
		},
		...fields,
	} as unknown as ChildRecord;
}

test("formatDuration: seconds, then zero-padded m/s, then zero-padded h/m", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(59_500), "1m00s", "rounds to whole seconds before picking the unit");
	assert.equal(formatDuration(65_000), "1m05s");
	assert.equal(formatDuration(3_599_000), "59m59s");
	assert.equal(formatDuration(3_600_000), "1h00m");
	assert.equal(formatDuration(3_725_000), "1h02m", "the hour form drops the seconds");
});

const META: RunMeta = {
	id: "c1",
	kind: "explorer",
	turns: 3,
	contextTokens: 2_000,
	contextWindow: 200_000,
	contextPercent: 1.2,
	resets: 2,
	costUsd: 0.25,
	durationMs: 65_000,
};

test("metaLine: full form, unknown percent, unknown usage", () => {
	assert.equal(metaLine(META), "explorer#c1 · 3 turns · ctx 2k/200k (1%) · 2 resets · $0.250 · 1m05s");
	assert.equal(
		metaLine({ ...META, contextPercent: null }),
		"explorer#c1 · 3 turns · ctx 2k/200k · 2 resets · $0.250 · 1m05s",
	);
	assert.equal(
		metaLine({ ...META, contextTokens: null, contextPercent: null }),
		"explorer#c1 · 3 turns · ctx ? · 2 resets · $0.250 · 1m05s",
	);
});

test("collectMeta: resets = pi compactions + context_handoff calls; unknown usage stays null", () => {
	const record = fakeRecord({
		entries: [{ type: "message" }, { type: "compaction" }, { type: "compaction" }],
		messages: [
			{ role: "user", content: [{ type: "toolCall", name: CONTEXT_CAP_TOOL_NAME }] },
			{
				role: "assistant",
				content: [
					{ type: "text" },
					{ type: "toolCall", name: CONTEXT_CAP_TOOL_NAME },
					{ type: "toolCall", name: "read" },
				],
			},
			{ role: "assistant", content: "plain string content" },
		],
		usage: undefined,
	});
	const meta = collectMeta(record);
	assert.equal(meta.resets, 3, "2 compactions + 1 assistant context_handoff call; user/other tool calls ignored");
	assert.equal(meta.contextTokens, null);
	assert.equal(meta.contextPercent, null);
	assert.equal(meta.contextWindow, 0);
	assert.equal(meta.costUsd, 0.25);
});

// child-retry.test.ts only sees a short one-line "Request timed out."; the
// first-line cut and the 80-char cap exist for multi-line JSON provider errors.
test("statusLine: retry beats the running tool; its error is cut to one line of at most 80 chars", () => {
	const record = fakeRecord({}, { turns: 2 });
	assert.equal(statusLine(record), "agent#c1 · desc · turn 3 · thinking");
	record.currentTool = "bash";
	assert.equal(statusLine(record), "agent#c1 · desc · turn 3 · running bash");

	record.retry = { attempt: 2, maxAttempts: 3, errorMessage: '503 {\n  "error": "overloaded"\n}' };
	assert.equal(statusLine(record), "agent#c1 · desc · turn 3 · retrying 2/3 after: 503 {");

	record.retry = { attempt: 1, maxAttempts: 3, errorMessage: "x".repeat(80) };
	assert.ok(statusLine(record).endsWith(`after: ${"x".repeat(80)}`), "exactly 80 chars stay uncut");
	record.retry = { attempt: 1, maxAttempts: 3, errorMessage: "y".repeat(81) };
	assert.ok(statusLine(record).endsWith(`after: ${"y".repeat(79)}\u2026`), "81 chars → 79 + ellipsis = 80");

	record.retry = undefined;
	assert.equal(statusLine(record), "agent#c1 · desc · turn 3 · running bash", "retry end restores the activity");
});

test("writeProgressEvent: at most one row per child per 2s; tool only when one is running", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-child-runs-"));
	try {
		const record = fakeRecord({ dir }, { turns: 1 });
		writeProgressEvent(record);
		record.currentTool = "edit";
		writeProgressEvent(record); // inside the throttle window: dropped
		record.lastProgressAt = Date.now() - 2_001;
		writeProgressEvent(record);

		const rows = readFileSync(runsFilePath(dir), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.equal(rows.length, 2, "the second call inside 2s must not write");
		assert.deepEqual(
			rows.map(({ ts: _ts, ...rest }) => rest),
			[
				{ event: "progress", sid: "sid-c1", turn: 2 },
				{ event: "progress", sid: "sid-c1", turn: 2, tool: "edit" },
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
