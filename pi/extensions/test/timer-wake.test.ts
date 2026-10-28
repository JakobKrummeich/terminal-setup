/**
 * timer.ts WakeTimer: the stranded-wake-up bookkeeping behind interactive timers.
 *
 * timer.test.ts drives real sessions and covers the happy path, including ONE
 * re-send after the settle race. What it cannot reach deterministically, and what
 * is pinned here against a stub ExtensionAPI with mocked timers:
 *  - the re-send BOUND (MAX_WAKE_RESENDS = 3). Without it, a wake-up that never
 *    shows up in a message_start (e.g. its text rewritten on the way in) would
 *    start a new agent run on every settle, forever;
 *  - what counts as delivery: only a USER message carrying the exact wake text;
 *  - a send that throws (at expiry or on re-send) gives up instead of retrying.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as timerModule from "../timer.ts";

const WAKE = 'Timer "t1" expired. Continue your task.';

type Handler = (event: unknown) => unknown;
type Execute = (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;

/** Stub ExtensionAPI: keeps handlers + the tool, records (or throws on) sendUserMessage. */
function stubPi(throwOnSend: (attempt: number) => boolean = () => false) {
	const handlers = new Map<string, Handler>();
	const sends: Array<{ text: string; deliverAs?: string }> = [];
	let execute: Execute | undefined;
	let attempts = 0;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: { execute: Execute }) => {
			execute = tool.execute;
		},
		registerToolRenderer: () => {},
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			attempts++;
			if (throwOnSend(attempts)) throw new Error("send failed");
			sends.push({ text, deliverAs: options?.deliverAs });
		},
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload);
	return {
		pi,
		sends,
		attempts: () => attempts,
		settle: () => emit("agent_settled"),
		messageStart: (message: unknown) => emit("message_start", { message }),
		/** Interactive `set` for 1 s, then let it expire (mocked clock). */
		async armAndExpire(t: TestContext) {
			assert.ok(execute, "timer tool registered");
			await execute("call-1", { action: "set", name: "t1", seconds: 1 }, undefined, undefined, { mode: "tui" });
			t.mock.timers.tick(1000);
		},
	};
}

// ESM runtime vs CJS-checked default export: unwrap either shape (as kill-switch.test.ts).
type ExtensionFn = (pi: unknown) => void;
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}
const timerExtension = defaultExport(timerModule);

function loadTimer(t: TestContext, throwOnSend?: (attempt: number) => boolean) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	t.mock.method(console, "warn", () => {});
	const stub = stubPi(throwOnSend);
	timerExtension(stub.pi);
	return stub;
}

test("a settle with no expired timer sends nothing", async (t) => {
	const stub = loadTimer(t);
	stub.settle();
	assert.deepEqual(stub.sends, []);
});

test("a wake-up never seen entering a run is re-sent at most 3 times, then dropped", async (t) => {
	const stub = loadTimer(t);
	await stub.armAndExpire(t);
	assert.deepEqual(stub.sends, [{ text: WAKE, deliverAs: "steer" }], "expiry steers the wake-up once");
	for (let i = 0; i < 6; i++) stub.settle();
	assert.equal(stub.sends.length, 4, "1 expiry send + MAX_WAKE_RESENDS (3) re-sends, never more");
	assert.ok(stub.sends.every((s) => s.text === WAKE && s.deliverAs === "steer"));
});

test("only a user message carrying the exact wake text counts as delivered", async (t) => {
	const stub = loadTimer(t);
	await stub.armAndExpire(t);

	stub.messageStart({ role: "assistant", content: [{ type: "text", text: WAKE }] });
	stub.settle();
	assert.equal(stub.sends.length, 2, "an assistant echo is not delivery: re-sent");

	stub.messageStart({ role: "user", content: 'Timer "other" expired. Continue your task.' });
	stub.settle();
	assert.equal(stub.sends.length, 3, "another timer's text is not delivery: re-sent");

	stub.messageStart({ role: "user", content: [{ type: "text", text: WAKE }] });
	stub.settle();
	stub.settle();
	assert.equal(stub.sends.length, 3, "delivered: the settle ends the wake cycle, nothing re-sent");
});

test("a wake-up whose expiry send throws is not retried on settle", async (t) => {
	const stub = loadTimer(t, (attempt) => attempt === 1);
	await stub.armAndExpire(t);
	stub.settle();
	stub.settle();
	assert.equal(stub.attempts(), 1, "no re-send after a failed expiry send");
});

test("a re-send that throws ends the wake cycle — no further attempts", async (t) => {
	const stub = loadTimer(t, (attempt) => attempt === 2);
	await stub.armAndExpire(t);
	stub.settle(); // re-send #1 throws
	stub.settle();
	stub.settle();
	assert.equal(stub.attempts(), 2, "expiry send + the one failed re-send");
});
