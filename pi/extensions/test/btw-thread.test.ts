/**
 * BtwThread (lib/btw-thread.ts): one direct LLM request per question.
 *   - the request: the fork's model, toolChoice "none", reasoning from the
 *     thinking level (none when "off"), the session id, the abort signal;
 *   - streaming partials are visible as inFlight.partial;
 *   - abort() drops the in-flight turn (also when the provider answers anyway);
 *   - an errored answer is kept as a turn but left out of the next context;
 *   - a request that cannot be built (nothing to fork) becomes an errored turn;
 *   - every question re-forks from the LIVE snapshot.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { type BtwAgentMessage, BTW_PREAMBLE, ForkSnapshot } from "../lib/btw-context.ts";
import { BtwThread, btwRequest, NOTHING_TO_FORK } from "../lib/btw-thread.ts";
import { assistantMessage, fail, fakeRegistry, finish, flush, streamPartial } from "./btw-fakes.ts";

const MODEL = { id: "m-1", provider: "anthropic", api: "anthropic-messages" } as any;
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as BtwAgentMessage;
const lastText = (messages: any[]) => messages.at(-1).content[0].text as string;

function setup(thinkingLevel: "off" | "high" = "off") {
	const registry = fakeRegistry();
	const snapshot = new ForkSnapshot();
	snapshot.onRequest([user("task")]);
	const thread = new BtwThread();
	let changes = 0;
	thread.subscribe(() => changes++);
	const request = () =>
		btwRequest({ registry, model: MODEL, thinkingLevel, sessionId: "sess-42", fork: snapshot.fork() });
	return { registry, snapshot, thread, request, changes: () => changes };
}

test("request: fork model, toolChoice none, no reasoning when off, session id, signal; partial then turn", async () => {
	const { registry, thread, request, changes } = setup();
	const asked = thread.ask("what now?", request);
	assert.equal(thread.answering, true);
	assert.equal(thread.inFlight?.question, "what now?");
	assert.equal(registry.calls.length, 1, "request sent synchronously");
	const [call] = registry.calls;
	assert.equal(call!.model, MODEL);
	assert.equal(call!.options.toolChoice, "none");
	assert.equal(call!.options.reasoning, undefined);
	assert.equal(call!.options.sessionId, "sess-42");
	assert.ok(call!.options.signal instanceof AbortSignal);
	assert.equal(lastText(call!.context.messages), `${BTW_PREAMBLE}\n\nwhat now?`);

	// One request at a time.
	void thread.ask("second?", request);
	assert.equal(registry.calls.length, 1, "ask while answering is ignored");

	streamPartial(call!, "work");
	await flush();
	assert.equal((thread.inFlight?.partial?.content[0] as { text: string }).text, "work");
	const before = changes();
	finish(call!, assistantMessage("working on X"));
	await asked;
	assert.ok(changes() > before, "listeners hear the finished answer");
	assert.equal(thread.answering, false);
	assert.deepEqual(
		thread.turns.map((t) => [t.question, (t.answer.content[0] as { text: string }).text]),
		[["what now?", "working on X"]],
	);
});

test("reasoning = thinking level when not off", async () => {
	const { registry, thread, request } = setup("high");
	const asked = thread.ask("q", request);
	assert.equal(registry.calls[0]!.options.reasoning, "high");
	finish(registry.calls[0]!, assistantMessage("a"));
	await asked;
});

test("abort drops the turn — even if the provider still answers — and aborts the signal", async () => {
	const { registry, thread, request } = setup();
	const asked = thread.ask("q", request);
	const call = registry.calls[0]!;
	streamPartial(call, "half");
	await flush();
	thread.abort();
	assert.equal(thread.answering, false, "in-flight cleared at once");
	assert.equal(call.options.signal.aborted, true);
	await asked;
	assert.deepEqual(thread.turns, [], "aborted turn is lost");

	// A provider ignoring the abort and finishing anyway: still dropped.
	const deaf = { streamSimple: (m: any, c: any, o: any) => registry.streamSimple(m, c, { ...o, signal: undefined }) };
	const second = thread.ask("q2", () => ({ ...request(), registry: deaf }));
	thread.abort();
	finish(registry.calls[1]!, assistantMessage("late answer"));
	await second;
	assert.deepEqual(thread.turns, []);
	assert.equal(thread.answering, false);
});

test("errored answer: kept as a turn, excluded from the next context", async () => {
	const { registry, thread, request } = setup();
	const first = thread.ask("broken?", request);
	fail(registry.calls[0]!, "overloaded");
	await first;
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0]!.answer.stopReason, "error");
	assert.equal(thread.turns[0]!.answer.errorMessage, "overloaded");

	const second = thread.ask("again?", request);
	const roles = registry.calls[1]!.context.messages.map((m: { role: string }) => m.role);
	assert.deepEqual(roles, ["user", "user"], "fork + new question only — no errored exchange");
	finish(registry.calls[1]!, assistantMessage("fine"));
	await second;

	const third = thread.ask("third?", request);
	const texts = registry.calls[2]!.context.messages.map((m: any) => m.content[0]?.text ?? "");
	assert.deepEqual(texts, ["task", `${BTW_PREAMBLE}\n\nagain?`, "fine", `${BTW_PREAMBLE}\n\nthird?`]);
	finish(registry.calls[2]!, assistantMessage("ok"));
	await third;
});

test("nothing to fork / no model: an errored turn, no request", async () => {
	const registry = fakeRegistry();
	const thread = new BtwThread();
	await thread.ask("q", () =>
		btwRequest({ registry, model: MODEL, thinkingLevel: "off", sessionId: "s", fork: new ForkSnapshot().fork() }),
	);
	assert.equal(registry.calls.length, 0);
	assert.equal(thread.turns[0]!.answer.stopReason, "error");
	assert.equal(thread.turns[0]!.answer.errorMessage, NOTHING_TO_FORK);

	await thread.ask("q", () =>
		btwRequest({ registry, model: undefined, thinkingLevel: "off", sessionId: "s", fork: { messages: [] } }),
	);
	assert.match(thread.turns[1]!.answer.errorMessage ?? "", /no model/);
});

test("every question re-forks from the live snapshot", async () => {
	const { registry, snapshot, thread, request } = setup();
	const first = thread.ask("q1", request);
	finish(registry.calls[0]!, assistantMessage("a1"));
	await first;

	// The session moved on: a new request with more transcript.
	snapshot.onRequest([user("task"), user("progress since")]);
	const second = thread.ask("and now?", request);
	const texts = registry.calls[1]!.context.messages.map((m: any) => m.content[0]?.text);
	assert.deepEqual(texts, ["task", "progress since", `${BTW_PREAMBLE}\n\nq1`, "a1", `${BTW_PREAMBLE}\n\nand now?`]);
	finish(registry.calls[1]!, assistantMessage("a2"));
	await second;
});
