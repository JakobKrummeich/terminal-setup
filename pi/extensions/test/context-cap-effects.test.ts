/**
 * context-cap side effects, in order: every footer status, notification (text +
 * level) and injected message (text + delivery) each state-machine path emits,
 * captured by binding the extension to a recording stub pi/ctx and driving its
 * handlers directly. The expected logs were recorded from the handlers as they
 * were BEFORE the decision logic moved to lib/context-cap-decide.ts — they pin
 * that the extraction kept the effect order, not just the decisions (those are
 * table-tested in context-cap-decisions.test.ts).
 */

// Must be set before the extension is imported (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextCapDir } from "../lib/agent-dir.ts";
import { at } from "./assert-helpers.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type ExecuteTool = (
	id: string,
	params: { markdown: string },
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) => Promise<{ isError?: boolean; content: { text: string }[] }>;

interface Driver {
	/** Ordered effect log: "status <s>", "notify <level> <text>", "send <deliverAs> <first line>". */
	log: string[];
	messageEnd(stopReason: "toolUse" | "stop" | "error" | "aborted", totalTokens: number | undefined): Promise<unknown>;
	turnEnd(toolResults: number, outcome?: string): Promise<unknown>;
	handoff(markdown: string): Promise<string>;
	/** What ctx.getContextUsage() reports from now on. */
	usage: { tokens: number | null };
	/** Scripted result of the machine writer's one LLM call. */
	writer: "ok" | "fail" | "abort";
	sessionId: string;
}

async function bind(): Promise<Driver> {
	const module = await import("../context-cap.ts");
	const defaultValue = module.default as unknown as ((pi: unknown) => void) | { default: (pi: unknown) => void };
	const extension = typeof defaultValue === "function" ? defaultValue : defaultValue.default;
	const handlers = new Map<string, Handler>();
	let execute: ExecuteTool | undefined;
	const log: string[] = [];
	const sessionId = `effects-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const pi = {
		on: (name: string, handler: Handler) => void handlers.set(name, handler),
		registerTool: (tool: { execute: ExecuteTool }) => {
			execute = tool.execute;
		},
		sendUserMessage: (text: string, opts?: { deliverAs?: string }) =>
			void log.push(`send ${opts?.deliverAs} ${text.split("\n")[0]}`),
	};
	extension(pi);
	const abort = new AbortController();
	const driver: Driver = {
		log,
		usage: { tokens: 0 },
		writer: "ok",
		sessionId,
		async messageEnd(stopReason, totalTokens) {
			last = {
				role: "assistant",
				content: [{ type: "text", text: `reply at ${totalTokens}` }],
				stopReason,
				usage: totalTokens === undefined ? undefined : { totalTokens },
				timestamp: Date.now(),
			};
			return handlers.get("message_end")!({ type: "message_end", message: last }, ctx);
		},
		async turnEnd(toolResults, outcome = "completed") {
			const event = {
				type: "turn_end",
				message: last,
				toolResults: Array.from({ length: toolResults }, () => ({})),
				outcome,
				entries: [],
				context: {},
				continue: false,
			};
			const result = (await handlers.get("turn_end")!(event, ctx)) as
				| { entries: { customType?: string; details?: { trigger?: string; stale?: boolean; author?: string | null } }[]; continue: boolean }
				| undefined;
			if (result) {
				const marker = result.entries.find((e) => e.customType);
				const swap = marker ? ` marker=${marker.details?.trigger}/${marker.details?.author}/stale=${marker.details?.stale}` : "";
				log.push(`boundary continue=${result.continue}${swap}`);
			}
			return result;
		},
		async handoff(markdown) {
			const r = await execute!("h", { markdown }, undefined, undefined, ctx);
			return `${r.isError ? "error" : "ok"}: ${at(r.content, 0).text.split(":")[0]}`;
		},
	};
	let last: unknown;
	const ctx = {
		model: { id: "test-model", provider: "test" },
		modelRegistry: {
			complete: async () => {
				if (driver.writer === "abort") {
					abort.abort();
					throw new Error("aborted");
				}
				if (driver.writer === "fail") throw new Error("provider down");
				return {
					role: "assistant",
					content: [{ type: "text", text: "## Current Task\nMachine draft." }],
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				};
			},
		},
		get signal() {
			return abort.signal;
		},
		getContextUsage: () =>
			driver.usage.tokens == null ? undefined : { tokens: driver.usage.tokens, contextWindow: 1_000_000, percent: 0 },
		sessionManager: { getSessionId: () => sessionId, getSessionDir: () => "" },
		ui: {
			setStatus: (_key: string, status: string) => void log.push(`status ${status}`),
			notify: (message: string, level: string) => void log.push(`notify ${level} ${message}`),
		},
	} as unknown as ExtensionContext;
	return driver;
}

function cleanup(d: Driver) {
	try {
		for (const name of fs.readdirSync(contextCapDir())) {
			if (name.startsWith(`${d.sessionId}-`)) fs.rmSync(path.join(contextCapDir(), name), { force: true });
		}
	} catch {
		// best-effort cleanup: the handoff dir may not exist
	}
}

async function scenario(run: (d: Driver) => Promise<void>): Promise<string[]> {
	const d = await bind();
	try {
		await run(d);
		return d.log;
	} finally {
		cleanup(d);
	}
}

/** Recorded from the pre-extraction handlers (see the header). */
const EXPECTED: Record<string, string[]> = {
	softToMachine: [
		"status 10/5",
		"status 10/5 ⚠ handoff",
		"send steer [context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at 10 tokens (soft cap 5, hard cap 50).",
		"notify info context-cap: soft cap (10) — handoff requested",
		"status 10/5 ⚠ handoff",
		"send followUp [context-cap] No handoff was recorded — the `context_handoff` tool was not called.",
		"boundary continue=true",
		"status 10/5 ⚠ handoff",
		"send followUp [context-cap] No handoff was recorded — the `context_handoff` tool was not called.",
		"boundary continue=true",
		"status 10/5 ⚠ handoff",
		"status 10/5 ⚠ awaiting hard cap",
		"notify warning context-cap: handoff never recorded — waiting for hard cap backstop",
		"status 60/5 ⚠ awaiting hard cap",
		"notify warning context-cap: hard cap (60) — forcing handoff",
		"status writing handoff/5",
		"notify warning context-cap: no fresh handoff — writing one from the context (one LLM call)",
		"status swapped/5",
		"notify info context-cap: context swapped (hard, 60 tokens)",
		"boundary continue=true marker=hard/machine/stale=false",
	],
	jumpToNoFile: [
		"status 60/5",
		"status 60/5 ⚠ handoff",
		"send steer [context-cap] ⚠️ CONTEXT LIMIT EMERGENCY: your context jumped to 60 tokens, past the hard cap 50. Do NOT start any new work. Call the `context_handoff` tool. Its `markdown` argument (plain markdown, NO YAML frontmatter, ~60 lines total):",
		"notify warning context-cap: hard cap (60) crossed in one jump — emergency handoff requested",
		"status 60/5 ⚠ handoff",
		"status 60/5 ⚠ handoff",
		"notify warning context-cap: hard cap (60) — forcing handoff",
		"status writing handoff/5",
		"notify warning context-cap: no fresh handoff — writing one from the context (one LLM call)",
		"notify warning context-cap: could not write a handoff — falling back to the previous file",
		"notify warning context-cap: hard cap hit with no handoff file — swapping without summary",
		"status swapped/5",
		"notify info context-cap: context swapped (hard-no-file, 60 tokens)",
		"boundary continue=true marker=hard-no-file/null/stale=false",
	],
	agentHandoff: [
		"status 10/5",
		"status 10/5 ⚠ handoff",
		"send steer [context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at 10 tokens (soft cap 5, hard cap 50).",
		"notify info context-cap: soft cap (10) — handoff requested",
		"status swapped/5",
		"notify info context-cap: context swapped (soft, 10 tokens)",
		"boundary continue=true marker=soft/agent/stale=false",
		"status 20/5",
		"status 20/5 ⚠ handoff",
		"send steer [context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at 20 tokens (soft cap 5, hard cap 50).",
		"notify info context-cap: soft cap (20) — handoff requested",
		"status 60/5 ⚠ handoff",
		"notify warning context-cap: hard cap (60) — forcing handoff",
		"status swapped/5",
		"notify info context-cap: context swapped (hard, 60 tokens)",
		"boundary continue=true marker=hard/agent/stale=false",
	],
	silentStopStale: [
		"status 10/5",
		"status 10/5 ⚠ handoff",
		"send followUp [context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at 10 tokens (soft cap 5, hard cap 50). This is your last turn before handoff.",
		"notify info context-cap: soft cap (10) — last-turn handoff requested",
		"boundary continue=true",
		"status swapped/5",
		"notify info context-cap: context swapped (soft, 10 tokens)",
		"boundary continue=true marker=soft/agent/stale=false",
		"status 60/5",
		"notify warning context-cap: hard cap (60) — forcing handoff",
		"status writing handoff/5",
		"notify warning context-cap: no fresh handoff — writing one from the context (one LLM call)",
		"notify warning context-cap: could not write a handoff — falling back to the previous file",
		"status swapped/5",
		"notify info context-cap: context swapped (hard, 60 tokens)",
		"boundary continue=true marker=hard/agent/stale=true",
	],
	skipsAndAbort: [
		"status 10/5",
		"status 10/5",
		"status 10/5",
		"status 10/5 ⚠ handoff",
		"send steer [context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at 10 tokens (soft cap 5, hard cap 50).",
		"notify info context-cap: soft cap (10) — handoff requested",
		"status ?/5 ⚠ handoff",
		"status 2/5 ⚠ handoff",
		"status 2/5",
		"notify info context-cap: context shrank mid-cycle — stale handoff cycle reset",
		"status 60/5",
		"notify warning context-cap: hard cap (60) — forcing handoff",
		"status writing handoff/5",
		"notify warning context-cap: no fresh handoff — writing one from the context (one LLM call)",
		"notify warning context-cap: could not write a handoff — falling back to the previous file",
		"notify warning context-cap: aborted while writing the handoff — swap deferred",
		"status 60/5",
	],
};

test("effects: soft steer → reminders → exhausted → hard cap, machine-written handoff", async () => {
	const log = await scenario(async (d) => {
		d.usage.tokens = 10;
		await d.messageEnd("toolUse", 10); // soft steer
		await d.turnEnd(1); // tools ran: keep waiting
		await d.messageEnd("stop", 10);
		await d.turnEnd(0); // reminder 1
		await d.messageEnd("stop", 10);
		await d.turnEnd(0); // reminder 2
		await d.messageEnd("stop", 10);
		await d.turnEnd(0); // exhausted
		d.usage.tokens = 60;
		await d.messageEnd("toolUse", 60); // exhausted: no grace → backstop, machine draft
		await d.turnEnd(1); // commit
	});
	assert.deepEqual(log, EXPECTED.softToMachine);
});

test("effects: one-jump emergency steer → grace → backstop with no file", async () => {
	const log = await scenario(async (d) => {
		d.usage.tokens = 60;
		d.writer = "fail";
		await d.messageEnd("toolUse", 60); // one-jump steer
		await d.turnEnd(1);
		await d.messageEnd("toolUse", 60); // grace
		await d.turnEnd(1);
		await d.messageEnd("toolUse", 60); // grace used → backstop; writer fails; no file
		await d.turnEnd(1); // commit hard-no-file
	});
	assert.deepEqual(log, EXPECTED.jumpToNoFile);
});

test("effects: agent handoff at the hard cap swaps the fresh file", async () => {
	let reply0 = "";
	let reply1 = "";
	const log = await scenario(async (d) => {
		d.usage.tokens = 10;
		await d.messageEnd("toolUse", 10); // soft steer
		reply0 = await d.handoff("## Current Task\nAgent draft.");
		await d.turnEnd(1); // handoff written → soft swap
		d.usage.tokens = 20;
		await d.messageEnd("toolUse", 20); // new cycle
		await d.turnEnd(1);
		reply1 = await d.handoff("## Current Task\nSecond.");
		d.usage.tokens = 60;
		await d.messageEnd("stop", 60); // hard, handoff written → fresh file, no LLM call
		await d.turnEnd(0);
	});
	assert.equal(reply0, "ok: Handoff recorded. End your turn now (no further tool calls) — your context is replaced immediately afterwards.");
	assert.equal(reply1, reply0);
	assert.deepEqual(log, EXPECTED.agentHandoff);
});

test("effects: refused tool outside a cycle → silent stop → soft swap → hard cap falls back to the stale file", async () => {
	let refused = "";
	const log = await scenario(async (d) => {
		d.usage.tokens = 3;
		refused = await d.handoff("## Current Task\nUnasked."); // refused: no cycle
		d.usage.tokens = 10;
		await d.messageEnd("stop", 10); // soft crossed without tools: nothing yet
		await d.turnEnd(0); // silent stop prompt
		await d.handoff("## Current Task\nWritten after prompt.");
		await d.turnEnd(0); // soft swap (seq 1)
		d.writer = "fail";
		d.usage.tokens = 60;
		await d.messageEnd("stop", 60); // hard, idle, no fresh file → writer fails → stale seq 1
		await d.turnEnd(0);
	});
	assert.equal(refused, "error: Refused");
	assert.deepEqual(log, EXPECTED.silentStopStale);
});

test("effects: skips, shrink reset, abort while drafting", async () => {
	const log = await scenario(async (d) => {
		d.usage.tokens = 10;
		await d.messageEnd("error", 99); // errored: status only, from getContextUsage (10), not the message's usage
		await d.messageEnd("aborted", 0); // ESC-aborted: zeroed usage must not flash the footer to 0
		await d.messageEnd("toolUse", undefined); // falls back to getContextUsage (10) → soft steer
		d.usage.tokens = null;
		await d.messageEnd("toolUse", undefined); // unknown usage: status only
		await d.messageEnd("stop", 2); // shrank below soft/2 → reset
		await d.turnEnd(0, "error"); // failed turn: nothing
		d.writer = "abort";
		d.usage.tokens = 60;
		await d.messageEnd("stop", 60); // backstop, user aborts the draft → deferred
		await d.turnEnd(0); // aborted signal: nothing
	});
	assert.deepEqual(log, EXPECTED.skipsAndAbort);
});
