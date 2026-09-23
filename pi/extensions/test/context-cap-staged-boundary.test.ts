/** Staged context-cap markers are transactional with their originating turn. */
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type RegisteredTool = {
	execute: (
		id: string,
		params: { markdown: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ isError?: boolean }>;
};

interface BoundExtension {
	handlers: Map<string, Handler>;
	tool: RegisteredTool;
	sentMarkers: unknown[];
	notifications: string[];
	statuses: string[];
	ctx: ExtensionContext & { signal: AbortSignal };
	sessionId: string;
}

function assistant(id: string, stopReason: "toolUse" | "stop", totalTokens: number) {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: id } }]
				: [{ type: "text", text: id }],
		stopReason,
		usage: { totalTokens },
		timestamp: Date.now(),
	};
}

function boundary(message: unknown, outcome = "completed", actionable = true) {
	const base = { type: "turn_end", message, toolResults: [{}], outcome };
	return actionable ? { ...base, entries: [], context: {}, continue: false } : base;
}

async function bindExtension(): Promise<BoundExtension> {
	const module = await import("../context-cap.ts");
	const defaultValue = module.default as unknown as
		| ((pi: unknown) => void)
		| { default: (pi: unknown) => void };
	const extension = typeof defaultValue === "function" ? defaultValue : defaultValue.default;
	const handlers = new Map<string, Handler>();
	let tool: RegisteredTool | undefined;
	const sentMarkers: unknown[] = [];
	const notifications: string[] = [];
	const statuses: string[] = [];
	const sessionId = `staged-boundary-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const pi = {
		on: (name: string, handler: Handler) => void handlers.set(name, handler),
		registerTool: (registered: RegisteredTool) => {
			tool = registered;
		},
		sendMessage: (message: unknown) => void sentMarkers.push(message),
		sendUserMessage: () => {},
	};
	extension(pi);
	assert.ok(tool, "context_handoff tool registered");
	const ctx = {
		model: { id: "test-model", provider: "test" },
		modelRegistry: {
			complete: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## Current Task\nMachine draft." }],
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			}),
		},
		signal: new AbortController().signal,
		getContextUsage: () => ({ tokens: 60, contextWindow: 1_000_000, percent: 0 }),
		isIdle: () => true,
		sessionManager: { getSessionId: () => sessionId, getSessionDir: () => "" },
		ui: {
			setStatus: (_key: string, status: string) => void statuses.push(status),
			notify: (message: string) => void notifications.push(message),
		},
	} as unknown as BoundExtension["ctx"];
	return { handlers, tool, sentMarkers, notifications, statuses, ctx, sessionId };
}

async function stageHardSwap(bound: BoundExtension) {
	const messageEnd = bound.handlers.get("message_end")!;
	const turnEnd = bound.handlers.get("turn_end")!;
	const first = assistant("first", "toolUse", 60);
	const grace = assistant("grace", "toolUse", 60);
	const source = assistant("source", "toolUse", 60);
	await messageEnd({ type: "message_end", message: first }, bound.ctx);
	await turnEnd(boundary(first), bound.ctx);
	await messageEnd({ type: "message_end", message: grace }, bound.ctx);
	await turnEnd(boundary(grace), bound.ctx);
	await messageEnd({ type: "message_end", message: source }, bound.ctx);
	return source;
}

async function finishPreservedCycle(bound: BoundExtension, actionable = true) {
	const message = assistant("recovery", "toolUse", 10);
	await bound.handlers.get("message_end")!({ type: "message_end", message }, bound.ctx);
	const toolResult = await bound.tool.execute(
		"handoff",
		{ markdown: "## Current Task\nRecover safely." },
		undefined,
		undefined,
		bound.ctx,
	);
	assert.notEqual(toolResult.isError, true, "discarding stage must preserve armed handoff cycle");
	return await bound.handlers.get("turn_end")!(boundary(message, "completed", actionable), bound.ctx);
}

function cleanup(bound: BoundExtension) {
	const dir = path.join(os.homedir(), ".pi", "agent", "context-cap");
	try {
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith(`${bound.sessionId}-`)) fs.rmSync(path.join(dir, name), { force: true });
		}
	} catch {}
}

for (const failure of ["aborted outcome", "error outcome", "aborted signal"] as const) {
	test(`abort during tool execution: staged hard swap is discarded on ${failure}; cycle recovers`, async () => {
		const bound = await bindExtension();
		try {
			const source = await stageHardSwap(bound);
			if (failure === "aborted signal") bound.ctx.signal = AbortSignal.abort();
			const outcome = failure === "error outcome" ? "error" : failure === "aborted outcome" ? "aborted" : "completed";
			const rejected = await bound.handlers.get("turn_end")!(boundary(source, outcome), bound.ctx);
			assert.equal(rejected, undefined, "bad boundary must request no continuation or entries");
			assert.equal(bound.sentMarkers.length, 0, "bad boundary must send no legacy marker");
			assert.equal(bound.notifications.filter((text) => text.includes("context swapped")).length, 0);
			assert.equal(bound.statuses.filter((status) => status.startsWith("swapped/")).length, 0);

			bound.ctx.signal = new AbortController().signal;
			const recovered = (await finishPreservedCycle(bound)) as { entries?: unknown[]; continue?: boolean };
			assert.equal(recovered.continue, true);
			assert.equal(recovered.entries?.length, 1, "later valid boundary commits one marker");
			assert.equal(bound.notifications.filter((text) => text.includes("context swapped")).length, 1);
			assert.equal(bound.statuses.filter((status) => status.startsWith("swapped/")).length, 1);
		} finally {
			cleanup(bound);
		}
	});
}

test("staged swap ignores a mismatched boundary without resetting its cycle", async () => {
	for (const actionable of [true, false]) {
		const bound = await bindExtension();
		try {
			await stageHardSwap(bound);
			const other = assistant("other", "stop", 10);
			const rejected = await bound.handlers.get("turn_end")!(boundary(other, "completed", actionable), bound.ctx);
			assert.equal(rejected, undefined, "mismatched boundary must request no continuation or entries");
			assert.equal(bound.sentMarkers.length, 0, "mismatched boundary must send no marker");

			const recovered = (await finishPreservedCycle(bound, actionable)) as
				| { entries?: unknown[]; continue?: boolean }
				| undefined;
			if (actionable) {
				assert.equal(recovered?.continue, true);
				assert.equal(recovered?.entries?.length, 1);
			} else {
				assert.equal(recovered, undefined);
				assert.equal(bound.sentMarkers.length, 1, "legacy boundary sends exactly one marker");
			}
			assert.equal(bound.notifications.filter((text) => text.includes("context swapped")).length, 1);
			assert.equal(bound.statuses.filter((status) => status.startsWith("swapped/")).length, 1);
		} finally {
			cleanup(bound);
		}
	}
});
