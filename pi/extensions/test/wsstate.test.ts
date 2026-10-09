/**
 * wsstate: the pi agent's workspace state (wsstate=busy|blocked|waiting|idle)
 * emitted to wezterm via OSC 1337 SetUserVar.
 *
 * The contract under test (see the extension header):
 *  - busy from agent_start until agent_settled — NOT agent_end: retries,
 *    compaction and queued continuations run after agent_end;
 *  - blocked while a select/confirm/input/editor dialog is open (it beats
 *    busy and waiting); "custom" overlays never block;
 *  - waiting once settled with a timer armed. Detection uses ONLY the timer
 *    tool's public surface: args are harvested at tool_execution_start, the
 *    verdict at tool_execution_end, joined by toolCallId — pi's end event
 *    carries NO args (an earlier version read `e.args` off the end event and
 *    therefore never armed). A successful `set` arms, `cancel` disarms,
 *    errored calls do neither, and only the TUI arms (timer blocks elsewhere);
 *  - any run start clears the park (a wake or a human both start a run);
 *  - a state is sent once per change; session start/shutdown always send;
 *  - inside tmux the OSC is wrapped in DCS passthrough with doubled ESC,
 *    same pattern as shell/wsstate.sh.
 *
 * The extension is pure event wiring on ExtensionAPI, so these tests drive it
 * through a recording stub (kill-switch.test.ts pattern) and intercept
 * process.stdout.write to read the escape sequences it emits.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as wsstateModule from "../wsstate.ts";
import { at } from "./assert-helpers.ts";

type Handler = (event?: unknown, ctx?: unknown) => void;

/** Handlers see the live ExtensionContext; only .mode matters here. */
const TUI_CTX = { mode: "tui" };
type ExtensionFn = (pi: { on: (event: string, handler: Handler) => void }) => void;

// ESM/CJS interop unwrap, same pattern as kill-switch.test.ts.
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

const wsstateExtension = defaultExport(wsstateModule);

/** Instantiate the extension against a stub pi; returns the captured handlers. */
function loadWsstate(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	wsstateExtension({ on: (event, handler) => handlers.set(event, handler) });
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

const prompt = (type: "ui_prompt_start" | "ui_prompt_end", kind: string) => ({ type, reason: "ui_prompt", kind });

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

/** All wsstate values emitted while fn runs, in order, base64-decoded. */
function emitted(fn: () => void): string[] {
	const states: string[] = [];
	for (const chunk of captureStdout(fn)) {
		for (const match of chunk.matchAll(/SetUserVar=wsstate=([A-Za-z0-9+/=]+)\x07/g)) {
			states.push(Buffer.from(at(match, 1), "base64").toString());
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

test("run lifecycle: busy from agent_start until agent_settled; agent_end is ignored", () => {
	withEnv("TMUX", undefined, () => {
		const h = loadWsstate();
		assert.deepEqual(emitted(() => fire(h, "session_start")), ["idle"]);
		assert.deepEqual(emitted(() => fire(h, "agent_start")), ["busy"]);
		// Retry / compaction / queued continuation may still follow agent_end,
		// so it must not end "busy" — the extension does not even listen.
		assert.equal(h.has("agent_end"), false, "agent_end must not drive wsstate");
		assert.deepEqual(emitted(() => fire(h, "agent_settled", { type: "agent_settled" })), ["idle"]);
		// Unchanged state is not re-sent; session boundaries always send.
		assert.deepEqual(emitted(() => fire(h, "agent_settled", { type: "agent_settled" })), []);
		assert.deepEqual(emitted(() => fire(h, "session_start")), ["idle"]);
		assert.deepEqual(emitted(() => fire(h, "session_shutdown")), ["idle"]);
	});
});

test("a successful timer set parks the settled agent as waiting; the next run unparks", () => {
	withEnv("TMUX", undefined, () => {
		const h = loadWsstate();
		fire(h, "session_start");
		fire(h, "agent_start");
		// Armed mid-run: still busy, nothing to send.
		assert.deepEqual(emitted(() => timerCall(h, "t1", "set")), []);
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["waiting"]);
		// A wake and human input both start a run.
		assert.deepEqual(emitted(() => fire(h, "agent_start")), ["busy"]);
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["idle"]);
	});
});

test("cancel disarms; errored, foreign, arg-less and stale timer calls never arm", () => {
	withEnv("TMUX", undefined, () => {
		const h = loadWsstate();
		fire(h, "session_start");

		fire(h, "agent_start");
		timerCall(h, "t1", "set");
		timerCall(h, "t2", "cancel");
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["idle"]);

		fire(h, "agent_start");
		timerCall(h, "t3", "set", true);
		fire(h, "tool_execution_start", { ...timerStart("t4", "set"), toolName: "bash" });
		fire(h, "tool_execution_end", { ...timerEnd("t4"), toolName: "bash" });
		fire(h, "tool_execution_start", { type: "tool_execution_start", toolCallId: "t5", toolName: "timer", args: undefined });
		fire(h, "tool_execution_end", timerEnd("t5"));
		fire(h, "tool_execution_end", timerEnd("t6-never-started"));
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["idle"]);

		// A straggler start (call aborted before its end event) is cleared at the
		// next run start — its late end event must not arm anything.
		fire(h, "tool_execution_start", timerStart("t-stale", "set"));
		fire(h, "agent_start");
		fire(h, "tool_execution_end", timerEnd("t-stale"));
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["idle"]);

		// Shutdown resets an armed park.
		fire(h, "agent_start");
		timerCall(h, "t7", "set");
		fire(h, "agent_settled");
		assert.deepEqual(emitted(() => fire(h, "session_shutdown")), ["idle"]);
	});
});

test("outside the TUI a successful set arms nothing — timer blocked, the wait is already over", () => {
	withEnv("TMUX", undefined, () => {
		const h = loadWsstate();
		fire(h, "session_start");
		fire(h, "agent_start");
		timerCall(h, "t1", "set", false, { mode: "print" });
		assert.deepEqual(emitted(() => fire(h, "agent_settled")), ["idle"]);
	});
});

test("an open dialog is blocked — over busy and waiting; custom overlays never block", () => {
	withEnv("TMUX", undefined, () => {
		const h = loadWsstate();
		fire(h, "session_start");

		fire(h, "agent_start");
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_start", prompt("ui_prompt_start", "confirm"))), ["blocked"]);
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_end", prompt("ui_prompt_end", "confirm"))), ["busy"]);

		// e.g. the Agent watch view: an overlay, not a question.
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_start", prompt("ui_prompt_start", "custom"))), []);
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_end", prompt("ui_prompt_end", "custom"))), []);

		timerCall(h, "t1", "set");
		fire(h, "agent_settled");
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_start", prompt("ui_prompt_start", "select"))), ["blocked"]);
		assert.deepEqual(emitted(() => fire(h, "ui_prompt_end", prompt("ui_prompt_end", "select"))), ["waiting"]);
	});
});

test("escape sequence: bare OSC outside tmux, DCS passthrough with doubled ESC inside", () => {
	const osc = `\x1b]1337;SetUserVar=wsstate=${Buffer.from("busy").toString("base64")}\x07`;
	const busyChunk = (): string | undefined => {
		const h = loadWsstate();
		return captureStdout(() => fire(h, "agent_start")).find((c) => c.includes("SetUserVar=wsstate"));
	};

	withEnv("TMUX", undefined, () => {
		assert.equal(busyChunk(), osc, "bare OSC 1337 outside tmux");
	});
	withEnv("TMUX", "/tmp/tmux-1000/default,42,0", () => {
		// Same wrap as shell/wsstate.sh: \ePtmux; + OSC with every ESC doubled + \e\\
		assert.equal(busyChunk(), `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`, "DCS passthrough inside tmux");
	});
});
