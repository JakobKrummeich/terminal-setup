/**
 * btw.ts on a real AgentSession (scripted LLM, harness.ts): while a bash tool
 * call runs, `/btw <question>` forks exactly what the session last sent to the
 * model — compared against the context the agent really sent — plus the
 * in-flight assistant message with a synthetic "still running" result, then the
 * framed question. With caveman-prompt.ts loaded (a FORCED system prompt pi
 * projects in after context_with_system) and without it.
 * Also: nothing to fork before the first request; the real session is untouched.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BTW_PREAMBLE, PENDING_RESULT_TEXT } from "../lib/btw-context.ts";
import { NOTHING_TO_FORK } from "../lib/btw-thread.ts";
import { assistantMessage, fakeRegistry, finish, flush } from "./btw-fakes.ts";
import { createTestSession, sleep, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const BTW = path.join(EXT_DIR, "btw.ts");
const CAVEMAN = path.join(EXT_DIR, "caveman-prompt.ts");

type ExtensionFn = (pi: unknown) => void;

/** JSON round-trip: typebox symbol keys and undefined fields out, like the wire. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

async function runBtwWhileToolRuns(extensionPaths: string[]) {
	const t = await createTestSession({
		extensionPaths,
		tools: ["bash"],
		script: [toolStep("c1", "bash", { command: "sleep 0.6" }), textStep("all done")],
		llmDelayMs: 10,
	});
	const sent: unknown[][] = [];
	const original = t.session.agent.streamFunction;
	t.session.agent.streamFunction = (model: any, context: any, options: any) => {
		sent.push(json(context.messages));
		return original(model, context, options);
	};
	const registry = fakeRegistry();
	const notes: string[] = [];
	const opened: { component?: any } = {};
	const ctx = {
		hasUI: true,
		model: t.session.model,
		thinkingLevel: "off",
		modelRegistry: registry,
		sessionManager: t.session.sessionManager,
		ui: {
			notify: (message: string) => notes.push(message),
			custom(factory: any) {
				const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
				const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, inverse: (s: string) => s };
				opened.component = factory(tui, theme, {}, () => {});
				return new Promise(() => {}); // stays open
			},
		},
	};
	const command = t.session.extensionRunner.getCommand("btw");
	assert.ok(command, "btw.ts registers /btw");

	void command.handler("too early?", ctx);
	assert.deepEqual(notes, [NOTHING_TO_FORK], "no model request yet: notify, don't open");
	// assert.ok on a comparison, not assert.equal: equal's `asserts` signature would
	// narrow opened.component to undefined for the rest of the function.
	assert.ok(opened.component === undefined, "overlay not opened");

	let toolRunning!: () => void;
	const running = new Promise<void>((resolve) => (toolRunning = resolve));
	t.session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") toolRunning();
	});
	const run = t.session.prompt("do the task");
	await running;
	void command.handler("what are you doing?", ctx);
	assert.ok(opened.component, "overlay opened");
	assert.equal(registry.calls.length, 1, "the question was sent immediately");
	const btwCall = registry.calls[0]!;
	const btwMessages = json(btwCall.context.messages);
	finish(btwCall, assistantMessage("waiting on bash"));
	await flush();
	await run;
	opened.component.dispose();
	t.dispose();
	return { sent, btwCall, btwMessages, t };
}

for (const [label, extensionPaths] of [
	["plain prompt", [BTW]],
	["forced prompt (caveman-prompt.ts)", [CAVEMAN, BTW]],
] as const) {
	test(`/btw mid-tool forks exactly what the model was sent — ${label}`, async () => {
		const { sent, btwCall, btwMessages, t } = await runBtwWhileToolRuns([...extensionPaths]);
		assert.equal(sent.length, 2, "the real run went on: tool turn + final answer");
		const request = sent[0]!;
		assert.deepEqual(btwMessages.slice(0, request.length), request, "fork prefix = the request as sent");
		if (label.startsWith("forced")) {
			assert.match(String(request[0] && (request[0] as any).content), /caveman/i, "precondition: forced prompt sent");
		}
		const [inFlight, pending, question] = btwMessages.slice(request.length);
		assert.equal(inFlight.role, "assistant");
		assert.equal(inFlight.content[0].type, "toolCall", "the in-flight assistant message with its tool call");
		assert.deepEqual(
			[pending.role, pending.toolCallId, pending.content[0].text, pending.isError],
			["toolResult", "c1", PENDING_RESULT_TEXT, false],
		);
		assert.equal(question.content[0].text, `${BTW_PREAMBLE}\n\nwhat are you doing?`);
		assert.equal(btwMessages.length, request.length + 3);

		assert.equal(btwCall.options.toolChoice, undefined, "same request shape as the session: no toolChoice (cache)");
		assert.equal(btwCall.options.reasoning, undefined, "thinking off");
		assert.equal(btwCall.options.sessionId, t.session.sessionManager.getSessionId());
		assert.equal(btwCall.model, t.session.model);

		// The real session never saw the side chat.
		const second = JSON.stringify(sent[1]);
		assert.ok(!second.includes("what are you doing?") && !second.includes("waiting on bash"));
		const persisted = JSON.stringify(t.session.sessionManager.getEntries());
		assert.ok(!persisted.includes("what are you doing?"), "nothing appended to the session");
		assert.deepEqual(
			t.deliveredUserMessages.map((m) => m.text),
			["do the task"],
			"no steer / follow-up delivered",
		);
	});
}

test("btw.ts registers nothing in a child session", async () => {
	const { runInChildSession } = await import("../lib/child-context.ts");
	// Same CJS/ESM default-export interop unwrap as caveman-prompt.test.ts.
	const mod = (await import("../btw.ts")) as unknown as { default: ExtensionFn | { default: ExtensionFn } };
	const extension = typeof mod.default === "function" ? mod.default : mod.default.default;
	const registered: string[] = [];
	const pi = new Proxy({}, { get: (_t, key) => () => registered.push(String(key)) });
	await runInChildSession({ kind: "agent", contract: undefined }, async () => extension(pi));
	assert.deepEqual(registered, []);
	await sleep(0);
});
