/**
 * Lossless eviction: a finished child evicted from liveChildren (memory cap) —
 * or lost with the in-memory state on a pi restart — is reopened from its
 * session file when a later call passes its resume_id.
 *
 * Real runChildTool, real createAgentSession/SessionManager on a temp session
 * dir, with the model runtime's streamSimple replaced by a responder that
 * answers from the LLM-visible messages (and records them per call).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Children resolve their agent dir and session dir from the environment; point
// both at temp dirs so tests never touch (or load extensions from) ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-reopen-agentdir-"));
const SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-reopen-sessions-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRuns } from "../lib/agent-runs.ts";
import { type ChildRecord, liveChildren, resetChildState, runChildTool } from "../lib/child-session.ts";
import { conversationMessages } from "./context-compat.ts";
import { sleep } from "./harness.ts";

// Replayed/live tool calls render through ToolExecutionComponent: needs a theme.
initTheme(undefined, false);

const OPTIONS = {
	kind: "explorer",
	busyGroup: "reopen-test",
	concurrency: 3,
	tools: ["read", "ls"],
	excludeTools: [],
};
const AGENT_OPTIONS = { ...OPTIONS, kind: "agent" };

type Result = Awaited<ReturnType<typeof runChildTool>>;
const resultText = (result: Result) => result.content[0]?.text ?? "";
const errorOf = (result: Result) => (result.details as { error?: string }).error;
const idOf = (result: Result) => (result.details as { id: string }).id;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/**
 * Fake ExtensionContext (same shape as explore.test.ts's makeCtx) whose model
 * answers from the conversation: a user message containing USE-LS gets an `ls`
 * tool call, a tool result gets "after-tool answer", SLOW delays the answer,
 * anything else gets "answer: <prompt>". `calls` records each call's messages.
 * `rootSid` becomes ctx.sessionManager's id — the spawner/root of every child,
 * which is also what makes children write agent-runs.jsonl rows.
 */
async function makeCtx(rootSid: string, calls: string[] = []): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-reopen-cwd-"));
	writeFileSync(path.join(dir, "MARKER-FILE.txt"), "x");
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		const messages = conversationMessages(context);
		calls.push(JSON.stringify(messages));
		const last = messages.at(-1);
		const lastText = textOf(last?.content);
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
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
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(last?.role === "user" && lastText.includes("SLOW") ? 400 : 10);
			if (last?.role === "user" && lastText.includes("USE-LS")) {
				output.content = [{ type: "toolCall", id: `ls-${calls.length}`, name: "ls", arguments: { path: "." } }];
				output.stopReason = "toolUse";
			} else {
				const text = last?.role === "toolResult" ? "after-tool answer" : `answer: ${lastText}`;
				output.content = [{ type: "text", text }];
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		})();
		return stream;
	};
	return {
		cwd: dir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		thinkingLevel: "off",
		// Real lookups: a reopened child resolves its saved model through the registry.
		modelRegistry: {
			runtime,
			find: (provider: string, modelId: string) => getModel(provider as "anthropic", modelId as never),
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => false,
		},
		sessionManager: { getSessionId: () => rootSid },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

const run = (ctx: ExtensionContext, prompt: string, extra: { description?: string; resume_id?: string } = {}, options = OPTIONS) =>
	runChildTool({ prompt, ...extra }, options, undefined, undefined, ctx);

/** Spawn and finish enough fresh children that `id` (finished) gets evicted. */
async function evict(ctx: ExtensionContext, id: string) {
	for (let i = 0; i < 12 && liveChildren.has(id); i++) {
		const filler = await run(ctx, `filler ${i}`, { description: `filler ${i}` });
		assert.equal(errorOf(filler), undefined, "filler must run");
	}
	assert.ok(!liveChildren.has(id), `${id} must have been evicted`);
}

/** Child session files in the session dir (agent-runs.jsonl excluded). */
const sessionFiles = () => readdirSync(SESSION_DIR).filter((n) => n.endsWith(".jsonl") && n !== "agent-runs.jsonl");

/** Drop all children, disposing their sessions (open handles), like a pi restart. */
function restart() {
	for (const record of liveChildren.values()) record.session.dispose();
	resetChildState();
}

test("evicted child is reopened: history in context, same file grows, record fields carried over", async () => {
	const calls: string[] = [];
	const ctx = await makeCtx("root-evict", calls);
	try {
		const first = await run(ctx, "FIRST-PROMPT about widgets", { description: "widget probe" });
		const id = idOf(first);
		const record = liveChildren.get(id)!;
		const file = record.session.sessionManager.getSessionFile()!;
		const sid = record.sid;
		const turnsBefore = record.turns;
		const elapsedBefore = record.elapsedMs;
		assert.equal(turnsBefore, 1);
		await evict(ctx, id);
		const sizeBefore = statSync(file).size;
		const filesBefore = sessionFiles().length;
		const callsBefore = calls.length;

		const resumed = await run(ctx, "SECOND-PROMPT follow-up", { resume_id: id });
		assert.equal(errorOf(resumed), undefined, resultText(resumed));
		assert.match(resultText(resumed), /answer: SECOND-PROMPT follow-up/);
		// The reopened session's LLM context carries the pre-eviction history.
		const context = calls[callsBefore]!;
		assert.ok(context.includes("FIRST-PROMPT about widgets"), "first prompt must be in the reopened context");
		assert.ok(context.includes("answer: FIRST-PROMPT about widgets"), "first answer must be in the reopened context");

		const reopened = liveChildren.get(id)!;
		assert.ok(reopened, "reopened child is live again");
		assert.equal(reopened.sid, sid, "same session id");
		assert.equal(reopened.session.sessionManager.getSessionFile(), file, "same session file");
		assert.ok(statSync(file).size > sizeBefore, "the same file keeps growing");
		assert.equal(sessionFiles().length, filesBefore, "no new session file");
		assert.equal(reopened.description, "widget probe", "description restored");
		assert.equal(reopened.turns, turnsBefore + 1, "turns continue from the evicted count");
		assert.ok(reopened.elapsedMs >= elapsedBefore, "elapsed time is cumulative");
		assert.equal((resumed.details as { turns: number }).turns, 2);
		assert.equal(reopened.session.sessionName, `explorer#${id}`, "persisted session name kept");
	} finally {
		restart();
	}
});

test("parallel resume of one evicted id: one reopens, the other gets child_running; reservation released", async () => {
	const ctx = await makeCtx("root-parallel");
	try {
		const id = idOf(await run(ctx, "original task"));
		await evict(ctx, id);
		const results = await Promise.all([
			run(ctx, "SLOW resume one", { resume_id: id }),
			run(ctx, "SLOW resume two", { resume_id: id }),
		]);
		const errors = results.map(errorOf).sort();
		assert.deepEqual(errors, ["child_running", undefined].sort(), "exactly one proceeds");
		const loser = results.find((r) => errorOf(r) === "child_running")!;
		assert.match(resultText(loser), /still running/);
		assert.equal([...liveChildren.keys()].filter((k) => k === id).length, 1);
		// Reservation released: evict the child again and reopen it once more.
		await evict(ctx, id);
		const again = await run(ctx, "third resume", { resume_id: id });
		assert.equal(errorOf(again), undefined, resultText(again));
		assert.match(resultText(again), /answer: third resume/);
	} finally {
		restart();
	}
});

test("after a restart (resetChildState) the child is found via agent-runs.jsonl — same root only, same kind only", async () => {
	const calls: string[] = [];
	const ctx = await makeCtx("root-restart", calls);
	try {
		const first = await run(ctx, "PRE-RESTART task", { description: "restart probe" });
		const id = idOf(first);
		const file = liveChildren.get(id)!.session.sessionManager.getSessionFile();
		restart();

		// Another main session (e.g. after /new): its root differs → rejected.
		const otherRoot = await makeCtx("root-other");
		const foreign = await run(otherRoot, "not yours", { resume_id: id });
		assert.equal(errorOf(foreign), "unknown_resume_id");
		assert.match(resultText(foreign), /No explorer session with id .* belongs to another main session/);

		// Kind mismatch: an explorer id is not an agent.
		const wrongKind = await run(ctx, "wrong kind", { resume_id: id }, AGENT_OPTIONS);
		assert.equal(errorOf(wrongKind), "unknown_resume_id");
		assert.match(resultText(wrongKind), /No agent session with id/);

		const callsBefore = calls.length;
		const resumed = await run(ctx, "POST-RESTART follow-up", { resume_id: id });
		assert.equal(errorOf(resumed), undefined, resultText(resumed));
		assert.ok(calls[callsBefore]!.includes("PRE-RESTART task"), "history restored from disk");
		const record = liveChildren.get(id)!;
		assert.equal(record.session.sessionManager.getSessionFile(), file);
		assert.equal(record.description, "restart probe", "description from the spawn row");
		assert.equal(record.rootSid, "root-restart");
		assert.equal(record.turns, 2, "turns continue from the last finish row");
	} finally {
		restart();
	}
});

test("missing session file → unknown_resume_id naming the missing file", async () => {
	const ctx = await makeCtx("root-missing");
	try {
		const id = idOf(await run(ctx, "soon gone"));
		const file = liveChildren.get(id)!.session.sessionManager.getSessionFile()!;
		await evict(ctx, id);
		rmSync(file);
		const resumed = await run(ctx, "follow-up", { resume_id: id });
		assert.equal(errorOf(resumed), "unknown_resume_id");
		assert.match(resultText(resumed), /cannot be resumed: its session file is missing/);
		assert.ok(resultText(resumed).includes(file), "error names the file");
		assert.ok(!liveChildren.has(id));
		// Truly unknown ids keep the other wording.
		const unknown = await run(ctx, "follow-up", { resume_id: "nope1234" });
		assert.equal(errorOf(unknown), "unknown_resume_id");
		assert.match(resultText(unknown), /No explorer session with id "nope1234"/);
	} finally {
		restart();
	}
});

test("watch view of a reopened child replays the saved history once, then the new prompt", async () => {
	const ctx = await makeCtx("root-replay");
	try {
		const id = idOf(await run(ctx, "USE-LS then REPLAY-PROMPT-ONE"));
		await evict(ctx, id);
		const resumed = await run(ctx, "REPLAY-PROMPT-TWO", { resume_id: id });
		assert.equal(errorOf(resumed), undefined, resultText(resumed));
		const rendered = liveChildren.get(id)!.view.render(120).join("\n");
		const order = [
			"USE-LS then REPLAY-PROMPT-ONE",
			"MARKER-FILE.txt", // ls tool result
			"after-tool answer",
			"REPLAY-PROMPT-TWO",
			"answer: REPLAY-PROMPT-TWO",
		];
		let at = -1;
		for (const needle of order) {
			const next = rendered.indexOf(needle, at + 1);
			assert.ok(next > at, `"${needle}" must follow the previous block:\n${rendered}`);
			at = next;
		}
		const count = (needle: string) => rendered.split(needle).length - 1;
		assert.equal(count("REPLAY-PROMPT-ONE"), 1, "earlier prompt rendered once");
		assert.equal(count("after-tool answer"), 1, "earlier answer rendered once");
		assert.equal(count("MARKER-FILE.txt"), 1, "tool result rendered once");
		// "answer: REPLAY-PROMPT-TWO" also contains the prompt text: 2 occurrences = prompt + answer.
		assert.equal(count("REPLAY-PROMPT-TWO"), 2, "new prompt rendered once (plus its answer)");
	} finally {
		restart();
	}
});

test("resume landing right after a reopen inserts its record gets child_running; the reopen completes cleanly", async () => {
	const ctx = await makeCtx("root-race");
	try {
		const id = idOf(await run(ctx, "race original"));
		await evict(ctx, id);
		// Hook the reopen's liveChildren insert and fire resumes at increasing
		// microtask depths — across the window before the reopening call releases
		// its reservation and sets record.running itself.
		const racers: Promise<Result>[] = [];
		const originalSet = liveChildren.set;
		liveChildren.set = ((key: string, value: ChildRecord) => {
			const result = originalSet.call(liveChildren, key, value);
			if (key === id) {
				delete (liveChildren as unknown as { set?: unknown }).set; // one-shot
				let depth = 0;
				const fire = () => {
					racers.push(run(ctx, `racer ${depth}`, { resume_id: id }));
					if (++depth < 6) queueMicrotask(fire);
				};
				queueMicrotask(fire);
			}
			return result;
		}) as typeof liveChildren.set;
		let winner: Result;
		try {
			winner = await run(ctx, "SLOW winner", { resume_id: id });
		} finally {
			delete (liveChildren as unknown as { set?: unknown }).set;
		}
		assert.equal(racers.length, 6, "all racers fired");
		for (const racer of await Promise.all(racers)) {
			assert.equal(errorOf(racer), "child_running", resultText(racer));
		}
		assert.equal(errorOf(winner), undefined, resultText(winner));
		assert.match(resultText(winner), /answer: SLOW winner/);
		const record = liveChildren.get(id)!;
		assert.equal(record.running, false, "winner's run settled");
		const finishes = readRuns(SESSION_DIR).filter((e) => e.event === "finish" && e.sid === record.sid);
		assert.deepEqual(
			finishes.map((e) => (e as { status: string }).status),
			["done", "done"],
			"one clean finish per real run, no error rows from racers",
		);
	} finally {
		restart();
	}
});

test("reopened child keeps its own model and thinking level, not the parent's current ones", async () => {
	const ctx = await makeCtx("root-model");
	const modelA = getModel("anthropic", "claude-sonnet-4-5")!;
	const modelB = getModel("anthropic", "claude-haiku-4-5")!;
	const parent = ctx as unknown as { model: typeof modelA; thinkingLevel: string; modelRegistry: { find: unknown } };
	parent.model = modelA;
	parent.thinkingLevel = "low";
	try {
		const id = idOf(await run(ctx, "task on model A"));
		assert.equal(liveChildren.get(id)!.session.model?.id, modelA.id);
		// The parent moves on: different model and thinking level.
		parent.model = modelB;
		parent.thinkingLevel = "high";
		await evict(ctx, id);
		const resumed = await run(ctx, "follow-up after the switch", { resume_id: id });
		assert.equal(errorOf(resumed), undefined, resultText(resumed));
		let session = liveChildren.get(id)!.session;
		assert.equal(session.model?.id, modelA.id, "reopened child stays on its own model");
		assert.equal(session.thinkingLevel, "low", "reopened child keeps its thinking level");
		// Saved model not resolvable (unknown to this registry) → parent's model.
		parent.modelRegistry.find = () => undefined;
		await evict(ctx, id);
		const fallback = await run(ctx, "follow-up, model gone", { resume_id: id });
		assert.equal(errorOf(fallback), undefined, resultText(fallback));
		session = liveChildren.get(id)!.session;
		assert.equal(session.model?.id, modelB.id, "unresolvable saved model falls back to the parent's");
		assert.equal(session.thinkingLevel, "low", "saved thinking level still wins");
	} finally {
		restart();
	}
});
