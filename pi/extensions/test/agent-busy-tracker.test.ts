/**
 * agent-busy-tracker: the second workspace-status axis (wswait=waiting|free)
 * emitted to wezterm via OSC 1337 SetUserVar.
 *
 * The contract under test (see the extension header):
 *  - detection uses ONLY the timer tool's public surface: args are harvested
 *    at tool_execution_start, the verdict at tool_execution_end, joined by
 *    toolCallId — pi's end event carries NO args (agent-session.js builds it
 *    from toolCallId/toolName/result/isError only; an earlier version of the
 *    extension read `e.args` off the end event and therefore never armed).
 *    A successful `set` arms "waiting", `cancel` and errored calls do not;
 *  - the flag is EMITTED only at park/unpark boundaries (session_start,
 *    agent_start, agent_end, session_shutdown), because agent_end is the
 *    moment wsstate flips to idle and the workspace would otherwise claim
 *    "needs you";
 *  - any turn start clears the flag (a wake or a human both start a turn);
 *  - inside tmux the OSC is wrapped in DCS passthrough with doubled ESC,
 *    same pattern as shell/wsstate.sh.
 *
 * The extension is pure event wiring on ExtensionAPI, so these tests drive it
 * through a recording stub (kill-switch.test.ts pattern) and intercept
 * process.stdout.write to read the escape sequences it emits.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as trackerModule from "../agent-busy-tracker.ts";

type Handler = (event?: unknown, ctx?: unknown) => void;

/** Handlers see the live ExtensionContext; only .mode matters here. */
const TUI_CTX = { mode: "tui" };
type ExtensionFn = (pi: { on: (event: string, handler: Handler) => void }) => void;

// ESM/CJS interop unwrap, same pattern as kill-switch.test.ts.
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

const trackerExtension = defaultExport(trackerModule);

/** Instantiate the extension against a stub pi; returns the captured handlers. */
function loadTracker(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	trackerExtension({ on: (event, handler) => handlers.set(event, handler) });
	return handlers;
}

function fire(handlers: Map<string, Handler>, event: string, payload?: unknown, ctx: unknown = TUI_CTX): void {
	const handler = handlers.get(event);
	assert.ok(handler, `extension subscribed to ${event}`);
	handler(payload, ctx);
}

// Event payloads mirror what agent-session.js actually emits: args ride on
// the START event only; the END event has toolCallId/toolName/result/isError.
const timerStart = (toolCallId: string, action: string) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "timer",
	args: { action },
});

const timerEnd = (toolCallId: string, isError = false) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName: "timer",
	result: { content: [] },
	isError,
});

/** One full timer tool call: start (with args) then end (without). */
function timerCall(
	handlers: Map<string, Handler>,
	id: string,
	action: string,
	isError = false,
	ctx: unknown = TUI_CTX,
): void {
	fire(handlers, "tool_execution_start", timerStart(id, action), ctx);
	fire(handlers, "tool_execution_end", timerEnd(id, isError), ctx);
}

/**
 * Run fn while recording everything written to process.stdout. Writes still
 * reach the real stdout (the TAP reporter shares it); the returned array holds
 * the raw chunks for inspection.
 */
function captureStdout(fn: () => void): string[] {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks;
}

/** All wswait states emitted in the captured chunks, in order, base64-decoded. */
function emittedStates(chunks: string[]): string[] {
	const states: string[] = [];
	for (const chunk of chunks) {
		for (const match of chunk.matchAll(/SetUserVar=wswait=([A-Za-z0-9+/=]+)\x07/g)) {
			states.push(Buffer.from(match[1], "base64").toString());
		}
	}
	return states;
}

/** withEnv from kill-switch.test.ts: force one env var, restore afterwards. */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const prior = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (prior === undefined) delete process.env[name];
		else process.env[name] = prior;
	}
}

test("session lifecycle emits free; a successful timer set flips agent_end to waiting", () => {
	withEnv("TMUX", undefined, () => {
		const handlers = loadTracker();

		// Baseline: session start parks nothing.
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "session_start"))),
			["free"],
		);

		// Arming the timer mid-turn emits NOTHING — the workspace only cares at
		// the park boundary (agent_end), where wsstate flips to idle. The end
		// event deliberately carries no args (real runtime shape).
		assert.deepEqual(
			emittedStates(captureStdout(() => timerCall(handlers, "t1", "set"))),
			[],
		);
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["waiting"],
		);

		// Any new turn unparks: wake and human input both start a turn.
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_start"))),
			["free"],
		);
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["free"],
		);
	});
});

test("cancel disarms; errored and foreign tool calls never arm", () => {
	withEnv("TMUX", undefined, () => {
		const handlers = loadTracker();
		fire(handlers, "session_start");

		// set then cancel within the same turn → parked free.
		timerCall(handlers, "t1", "set");
		timerCall(handlers, "t2", "cancel");
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["free"],
		);

		// A FAILED timer set armed nothing (isError is part of the contract).
		timerCall(handlers, "t3", "set", true);
		// A non-timer tool with a timer-shaped payload is ignored too.
		fire(handlers, "tool_execution_start", { ...timerStart("t4", "set"), toolName: "bash" });
		fire(handlers, "tool_execution_end", { ...timerEnd("t4"), toolName: "bash" });
		// A start with absent args must not throw (optional chaining contract),
		// and an end with no matching start arms nothing.
		fire(handlers, "tool_execution_start", { type: "tool_execution_start", toolCallId: "t5", toolName: "timer", args: undefined });
		fire(handlers, "tool_execution_end", timerEnd("t5"));
		fire(handlers, "tool_execution_end", timerEnd("t6-never-started"));
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["free"],
		);

		// A straggler start (call aborted before its end event) is cleared at the
		// next turn boundary — its late end event must not arm anything.
		fire(handlers, "tool_execution_start", timerStart("t-stale", "set"));
		fire(handlers, "agent_start");
		fire(handlers, "tool_execution_end", timerEnd("t-stale"));
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["free"],
		);

		// Shutdown resets and reports free.
		timerCall(handlers, "t7", "set");
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "session_shutdown"))),
			["free"],
		);
	});
});

test("outside the TUI a successful set arms nothing — timer blocked, the wait is already over", () => {
	withEnv("TMUX", undefined, () => {
		const handlers = loadTracker();
		fire(handlers, "session_start");
		// Same tool surface, headless ctx (pi -p / rpc / child): timer.ts blocks
		// inside the call, so by tool_execution_end nothing is armed anymore.
		timerCall(handlers, "t1", "set", false, { mode: "print" });
		assert.deepEqual(
			emittedStates(captureStdout(() => fire(handlers, "agent_end"))),
			["free"],
		);
	});
});

test("escape sequence: bare OSC outside tmux, DCS passthrough with doubled ESC inside", () => {
	const b64waiting = Buffer.from("waiting").toString("base64");
	const osc = `\x1b]1337;SetUserVar=wswait=${b64waiting}\x07`;

	withEnv("TMUX", undefined, () => {
		const handlers = loadTracker();
		timerCall(handlers, "t1", "set");
		const chunks = captureStdout(() => fire(handlers, "agent_end"));
		const emitted = chunks.find((c) => c.includes("wswait"));
		assert.equal(emitted, osc, "bare OSC 1337 outside tmux");
	});

	withEnv("TMUX", "/tmp/tmux-1000/default,42,0", () => {
		const handlers = loadTracker();
		timerCall(handlers, "t1", "set");
		const chunks = captureStdout(() => fire(handlers, "agent_end"));
		const emitted = chunks.find((c) => c.includes("wswait"));
		// Same wrap as shell/wsstate.sh: \ePtmux; + OSC with every ESC doubled + \e\\
		assert.equal(emitted, `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`, "DCS passthrough inside tmux");
	});
});
