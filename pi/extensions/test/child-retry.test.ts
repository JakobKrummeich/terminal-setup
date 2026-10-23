/**
 * A child whose provider calls fail ("Request timed out.", observed live on Azure).
 *
 * pi auto-retries retryable errors INSIDE session.prompt() (agent-session.js
 * _startRun → _handlePostAgentRun → _prepareRetry): with the defaults that is
 * 4 attempts × 300 s request timeout ≈ 20 min of one pending prompt(). Before
 * this was handled, the parent saw "turn N · thinking" (N counting the failed
 * attempts), the F2 view showed a bare "Error: Request timed out.", and when
 * every attempt failed the tool result was a NON-error "(agent produced no text
 * output)" — or a stale interim message posing as the final answer — with a
 * "done" finish row.
 *
 * Also: a provider stream that never ends and ignores the abort signal keeps
 * prompt() pending forever (pi's agent loop awaits the stream without watching
 * the signal); the parent's ESC must still settle the tool call after a grace.
 *
 * Real child sessions (createChildSession) on a scripted model stream, as in
 * agent-runs.test.ts; the retry backoff comes from this file's own agent dir.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Children read settings (retry policy) and write agent-runs rows from these dirs.
const AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-child-retry-agentdir-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-child-retry-sessions-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
process.env.PI_OFFLINE = "1";
// pi's default retry policy (3 retries), with a 10 ms instead of 2 s base backoff.
writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 10 } }));

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { readRuns, type RunFinish } from "../lib/agent-runs.ts";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { sleep } from "./harness.ts";

initTheme(undefined, false);

/**
 * One scripted LLM call: "timeout" fails like pi-ai's azure-openai-responses catch
 * block does on the SDK's APIConnectionTimeoutError; "interim" is a text + tool
 * call turn; "dead" never ends and ignores abort (released via releaseDead()).
 */
type Step = "timeout" | "ok" | "interim" | "dead";

interface Scripted {
	ctx: ExtensionContext;
	/** Ends the pending "dead" stream (as aborted), so its session can drain. */
	releaseDead(): void;
}

function baseMessage(m: { api: string; provider: string; id: string }) {
	return {
		role: "assistant",
		content: [] as unknown[],
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		errorMessage: undefined as string | undefined,
		timestamp: Date.now(),
	};
}

async function scriptedCtx(script: Step[]): Promise<Scripted> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-child-retry-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let call = 0;
	let releaseDead = () => {};
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: { api: string; provider: string; id: string }) => {
		const step = script[call++] ?? "ok";
		const stream = createAssistantMessageEventStream();
		const output = baseMessage(m);
		const fail = (stopReason: string, errorMessage: string) => {
			Object.assign(output, { stopReason, errorMessage });
			stream.push({ type: "error", reason: stopReason, error: output } as never);
			stream.end();
		};
		if (step === "dead") {
			releaseDead = () => fail("aborted", "Request was aborted");
			return stream;
		}
		void (async () => {
			await sleep(10);
			if (step === "timeout") return fail("error", "Request timed out.");
			stream.push({ type: "start", partial: output } as never);
			output.content =
				step === "interim"
					? [
							{ type: "text", text: "INTERIM: let me check a file first" },
							{ type: "toolCall", id: `tc${call}`, name: "ls", arguments: { path: dir } },
						]
					: [{ type: "text", text: "child done" }];
			output.stopReason = step === "interim" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output } as never);
			stream.end();
		})();
		return stream;
	};
	const ctx = {
		cwd: dir,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "parent-sid" },
	} as unknown as ExtensionContext;
	return { ctx, releaseDead: () => releaseDead() };
}

const OPTIONS = { kind: "agent", busyGroup: "agent", excludeTools: ["Agent"] };

type Result = Awaited<ReturnType<typeof runChildTool>>;

/** Run one Agent call; `statuses` collects every parent-visible status text. */
async function runAgent(scripted: Scripted, statuses: string[] = []): Promise<Result> {
	const onUpdate = (partial: { content: Array<{ text: string }> }) => statuses.push(partial.content[0]?.text ?? "");
	return runChildTool({ prompt: "do the task", description: "retry test" }, OPTIONS, undefined, onUpdate, scripted.ctx);
}

function recordOf(result: Result) {
	const record = liveChildren.get((result.details as { id: string }).id);
	assert.ok(record, "the child record must exist");
	return record;
}

function finishRows(sid: string): RunFinish[] {
	return readRuns(SESSION_DIR).filter((e): e is RunFinish => e.event === "finish" && e.sid === sid);
}

function viewText(record: { view: { render(width: number): string[] } }): string {
	return record.view.render(200).map((line) => stripTerminalSequences(line)).join("\n");
}

function disposeChildren() {
	for (const record of liveChildren.values()) record.session.dispose();
	liveChildren.clear();
}

const ALL_TIMEOUTS: Step[] = ["timeout", "timeout", "timeout", "timeout"];

test("every attempt times out → error result with the error and retry count, 'error' finish row", async () => {
	try {
		const result = await runAgent(await scriptedCtx(ALL_TIMEOUTS));
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true, `a failed run must be an error result: ${text}`);
		assert.match(text, /^agent failed: Request timed out\. \(after 3 retries\)/);
		const record = recordOf(result);
		assert.ok(text.endsWith(`agent id: ${record.id} (pass as resume_id to continue)`), text);
		assert.equal(finishRows(record.sid).at(-1)?.status, "error");
	} finally {
		disposeChildren();
	}
});

test("interim text, then every attempt times out → the text is partial output, not a clean answer", async () => {
	try {
		const result = await runAgent(await scriptedCtx(["interim", ...ALL_TIMEOUTS]));
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true, text);
		assert.match(text, /^agent failed: Request timed out\./);
		assert.match(text, /Partial output[^\n]*\n+INTERIM: let me check a file first/);
	} finally {
		disposeChildren();
	}
});

test("a run that recovers via retry stays a normal success", async () => {
	try {
		const result = await runAgent(await scriptedCtx(["timeout", "ok"]));
		const record = recordOf(result);
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.match(result.content[0]?.text ?? "", /^child done\n\n---\nagent id: /);
		assert.equal(finishRows(record.sid).at(-1)?.status, "done");
	} finally {
		disposeChildren();
	}
});

test("errored attempts do not count as turns", async () => {
	try {
		const failed = recordOf(await runAgent(await scriptedCtx(ALL_TIMEOUTS)));
		assert.equal(failed.turns, 0, "four failed attempts are zero turns");
		assert.equal(finishRows(failed.sid).at(-1)?.turns, 0);
		const recovered = recordOf(await runAgent(await scriptedCtx(["interim", "timeout", "ok"])));
		assert.equal(recovered.turns, 2, "interim turn + final turn; the timed-out attempt is not a turn");
	} finally {
		disposeChildren();
	}
});

test("the parent's status says the child is retrying, and why, between attempts", async () => {
	try {
		const statuses: string[] = [];
		await runAgent(await scriptedCtx(["timeout", "timeout", "ok"]), statuses);
		assert.ok(
			statuses.some((s) => /retrying 1\/3\b.*Request timed out\./.test(s)),
			`no retrying status: ${JSON.stringify(statuses)}`,
		);
		assert.ok(statuses.some((s) => /retrying 2\/3\b/.test(s)), JSON.stringify(statuses));
		assert.doesNotMatch(statuses.at(-1) ?? "", /retrying/, "a recovered run no longer reports retrying");
	} finally {
		disposeChildren();
	}
});

test("the F2 view shows each retry and the final retry failure", async () => {
	try {
		const recovered = recordOf(await runAgent(await scriptedCtx(["timeout", "ok"])));
		assert.match(viewText(recovered), /Retrying 1\/3 in \d+s: Request timed out\./);
		const failed = recordOf(await runAgent(await scriptedCtx(ALL_TIMEOUTS)));
		const view = viewText(failed);
		assert.match(view, /Retrying 3\/3 in \d+s: Request timed out\./);
		assert.match(view, /Retry failed after 3 attempts: Request timed out\./);
	} finally {
		disposeChildren();
	}
});

// The grace is short here; production waits ABORT_GRACE_MS (lib/abort-grace.ts).
const GRACE_MS = 200;

test("ESC on a child whose stream never ends settles the call after the grace, consistently", { timeout: 10_000 }, async () => {
	try {
		const scripted = await scriptedCtx(["dead", "ok"]);
		const controller = new AbortController();
		let abortedAt = 0;
		const onUpdate = () => {
			if (abortedAt) return;
			abortedAt = -1;
			setTimeout(() => {
				abortedAt = Date.now();
				controller.abort();
			}, 50);
		};
		const params = { prompt: "do the task", description: "dead stream" };
		const result = await runChildTool(params, { ...OPTIONS, abortGraceMs: GRACE_MS }, controller.signal, onUpdate, scripted.ctx);
		const settledAfterMs = Date.now() - abortedAt;
		assert.ok(settledAfterMs >= GRACE_MS && settledAfterMs < GRACE_MS + 1_000, `settled ${settledAfterMs} ms after ESC`);
		assert.equal((result.details as { aborted?: boolean }).aborted, true);
		const record = recordOf(result);
		assert.equal(record.running, false);
		assert.equal(finishRows(record.sid).length, 1);
		assert.equal(finishRows(record.sid).at(-1)?.status, "cancelled");

		// The orphaned run still holds the busy slot: no overlapping agent.
		const blocked = await runChildTool({ prompt: "overlap" }, OPTIONS, undefined, undefined, scripted.ctx);
		assert.equal((blocked.details as { error?: string }).error, "child_busy");

		// The stream finally ends: the orphan drains without touching the settled run.
		const turns = record.turns;
		scripted.releaseDead();
		await record.session.waitForIdle();
		await sleep(20);
		assert.equal(finishRows(record.sid).length, 1, "the orphaned prompt must not write a second finish row");
		assert.equal(record.running, false);
		assert.equal(record.turns, turns);

		const again = await runChildTool({ prompt: "retry", resume_id: record.id }, OPTIONS, undefined, undefined, scripted.ctx);
		assert.equal(again.isError, undefined, JSON.stringify(again.content));
	} finally {
		disposeChildren();
	}
});
