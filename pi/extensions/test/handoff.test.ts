/**
 * /handoff prompt alignment: the section list and line budget must come from
 * lib/handoff-writer.ts — the same source context-cap quotes — so the
 * CONTEXT_CAP_SCHEMA lever governs both and the two handoff flavours never
 * drift apart. Delivery differences (reply-harvest, no auto-continue) are the
 * command's own contract and are pinned in the prompt text itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as handoffModule from "../handoff.ts";
import { handoffLineBudget, handoffSections } from "../lib/handoff-writer.ts";
import { HANDOFF_PREAMBLE, HANDOFF_SUMMARY_TYPE, SWAP_MARKER_TYPE } from "../lib/message-types.ts";

const { HANDOFF_PROMPT, extractHandoffSummary } = handoffModule as unknown as {
	HANDOFF_PROMPT: string;
	extractHandoffSummary: (
		branch: Array<{ type: string; message?: { role?: string; stopReason?: string; content?: unknown } }>,
	) => { ok: true; text: string } | { ok: false; reason: string };
};

const assistant = (content: unknown, stopReason = "stop") => ({
	type: "message",
	message: { role: "assistant", stopReason, content },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

// ESM/CJS interop unwrap, same pattern as kill-switch.test.ts.
type ExtensionFn = (pi: unknown) => void;
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

test("/handoff quotes the live schema: sections and budget from lib/handoff-writer.ts", () => {
	assert.ok(HANDOFF_PROMPT.includes(handoffSections()), "section list must be the shared one, verbatim");
	assert.ok(HANDOFF_PROMPT.includes(`~${handoffLineBudget()} lines`), "line budget must be the shared one");
	// The v2 essentials the old 4-bullet prompt lacked — present via the shared list.
	for (const needle of ['"## Current Task"', '"## Files"', '"## Next Step"', '"## Dead Ends"']) {
		assert.ok(HANDOFF_PROMPT.includes(needle), `prompt must demand ${needle}`);
	}
});

test("/handoff is reply-mode: document as reply, tools banned, no auto-continue suffix", () => {
	assert.match(HANDOFF_PROMPT, /as your reply/);
	assert.match(HANDOFF_PROMPT, /do NOT call any tools/);
	assert.match(HANDOFF_PROMPT, /not even context_handoff/);
	// The successor stays interactive: the injected message must not tell it to
	// continue on its own (that suffix belongs to context-cap's swap summary).
	assert.ok(!HANDOFF_PROMPT.includes("Continue your work."), "no auto-continue instruction");
});

test("handoff wire format is pinned: preamble text and persisted customTypes", () => {
	// All writers/readers import these from lib/message-types.ts; the literals here
	// pin the persisted format itself. Session files on disk carry these strings —
	// renaming one orphans the handoff markers of every existing session.
	assert.equal(SWAP_MARKER_TYPE, "context-cap-swap");
	assert.equal(HANDOFF_SUMMARY_TYPE, "handoff-summary");
	assert.equal(
		HANDOFF_PREAMBLE,
		"You are continuing work from a previous session. The agent before you left you this information:",
	);
});

test("harvest accepts only a clean, non-empty reply", () => {
	const doc = "## Current Task\nfinish the demo";
	assert.deepEqual(
		extractHandoffSummary([user("prompt"), assistant([{ type: "text", text: doc }])]),
		{ ok: true, text: doc },
	);
	assert.deepEqual(extractHandoffSummary([assistant(doc)]), { ok: true, text: doc }, "string content");
	// The newest assistant message wins — never an older one.
	const r = extractHandoffSummary([assistant("old reply"), user("prompt"), assistant("new doc")]);
	assert.deepEqual(r, { ok: true, text: "new doc" });
});

test("harvest rejects errored, aborted and empty replies — even with partial text", () => {
	// Observed live: a timed-out request synthesizes stopReason 'error'. With
	// partial streamed text attached, seeding it would ship a truncated handoff.
	const errored = extractHandoffSummary([
		assistant([{ type: "text", text: "## Current Task\ntruncated half-docu" }], "error"),
	]);
	assert.equal(errored.ok, false);
	assert.match((errored as { reason: string }).reason, /failed.*run \/handoff again/);

	const aborted = extractHandoffSummary([assistant("partial", "aborted")]);
	assert.equal(aborted.ok, false);
	assert.match((aborted as { reason: string }).reason, /aborted.*run \/handoff again/);

	assert.equal(extractHandoffSummary([assistant([])]).ok, false, "empty reply");
	assert.equal(extractHandoffSummary([assistant("   ")]).ok, false, "whitespace-only reply");
	assert.equal(extractHandoffSummary([user("prompt only")]).ok, false, "no assistant at all");
	assert.deepEqual(
		extractHandoffSummary([assistant("doc"), { type: "custom" }, { type: "message" }]),
		{ ok: true, text: "doc" },
		"non-message entries and role-less messages after the reply are skipped",
	);
});

test("extension registers the /handoff command", () => {
	const commands: string[] = [];
	defaultExport(handoffModule)({
		on: () => {},
		registerCommand: (name: string) => commands.push(name),
	});
	assert.deepEqual(commands, ["handoff"]);
});

test("/handoff harvests only after its own prompt entered a run, then seeds the successor", async () => {
	type Handler = (event: unknown) => void;
	const handlers = new Map<string, Handler>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sentPrompts: string[] = [];
	defaultExport(handoffModule)({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, spec: { handler: typeof command }) => (command = spec.handler),
		sendUserMessage: (text: string) => sentPrompts.push(text),
	});
	const doc = "## Current Task\nship it";
	const seeded: unknown[] = [];
	const run = command!("", {
		isIdle: () => false,
		ui: { notify: () => {} },
		sessionManager: { getBranch: () => [user(HANDOFF_PROMPT), assistant([{ type: "text", text: doc }])] },
		newSession: async ({ withSession }: { withSession: (ctx: unknown) => Promise<void> }) =>
			withSession({ sendMessage: async (message: unknown) => seeded.push(message) }),
	});
	assert.deepEqual(sentPrompts, [HANDOFF_PROMPT]);

	// The run in flight when /handoff fired ends first: must NOT trigger the harvest.
	handlers.get("agent_end")!({});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(seeded.length, 0, "agent_end before the prompt was delivered must not harvest");

	// Other user messages don't count as delivery; the prompt itself (text blocks) does.
	handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: "unrelated" }] } });
	handlers.get("agent_end")!({});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(seeded.length, 0, "an unrelated user message is not the handoff prompt");

	handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: HANDOFF_PROMPT }] } });
	handlers.get("agent_end")!({});
	await run;
	assert.deepEqual(seeded, [{ customType: HANDOFF_SUMMARY_TYPE, content: `${HANDOFF_PREAMBLE}\n\n${doc}`, display: true }]);
});

test("/handoff shutdown before its prompt ran: handler returns without harvesting or seeding", async () => {
	type Handler = (event: unknown) => void;
	const handlers = new Map<string, Handler>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	defaultExport(handoffModule)({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, spec: { handler: typeof command }) => (command = spec.handler),
		sendUserMessage: () => {},
	});
	// The branch still ends in the pre-handoff reply: harvesting it would seed the
	// successor with the wrong document (the very thing `delivered` guards against).
	const calls: string[] = [];
	const run = command!("", {
		isIdle: () => false,
		ui: { notify: () => calls.push("notify") },
		sessionManager: { getBranch: () => (calls.push("getBranch"), [assistant("pre-handoff reply")]) },
		newSession: async () => calls.push("newSession"),
	});
	handlers.get("session_shutdown")!({});
	await run; // must settle: shutdown never leaves the command hanging
	assert.deepEqual(calls, [], "a shut-down session is neither harvested nor replaced");
});

/** Loads the extension against a recording stub; returns its handlers, /handoff and the sent prompts. */
function loadHandoff() {
	type Handler = (event: unknown) => void;
	const handlers = new Map<string, Handler>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sentPrompts: string[] = [];
	defaultExport(handoffModule)({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, spec: { handler: typeof command }) => (command = spec.handler),
		sendUserMessage: (text: string) => sentPrompts.push(text),
	});
	const deliverAndEnd = () => {
		handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: HANDOFF_PROMPT }] } });
		handlers.get("agent_end")!({});
	};
	return { run: command!, sentPrompts, deliverAndEnd };
}

/** A command ctx whose branch ends in `reply`; records notifications and successor sessions. */
function handoffCtx(reply: ReturnType<typeof assistant>) {
	const notices: Array<[string, string]> = [];
	const sessions: unknown[] = [];
	const ctx = {
		isIdle: () => false,
		ui: { notify: (text: string, level: string) => notices.push([text, level]) },
		sessionManager: { getBranch: () => [user(HANDOFF_PROMPT), reply] },
		newSession: async (options: unknown) => sessions.push(options),
	};
	return { ctx, notices, sessions };
}

test("/handoff while one is in flight is refused; the first still completes", async () => {
	// Without the guard the second call would overwrite the in-flight wait: the
	// first handler would never settle and the prompt would be queued twice.
	const { run, sentPrompts, deliverAndEnd } = loadHandoff();
	const first = handoffCtx(assistant("## Current Task\nship it"));
	const firstRun = run("", first.ctx);
	const second = handoffCtx(assistant("unused"));
	await run("", second.ctx);
	assert.deepEqual(second.notices, [["/handoff already in progress", "warning"]]);
	assert.deepEqual(sentPrompts, [HANDOFF_PROMPT], "the refused call queues no second prompt");

	deliverAndEnd();
	await firstRun;
	assert.equal(first.sessions.length, 1, "the in-flight /handoff still seeds its successor");
});

test("/handoff with a rejected harvest reports it, seeds nothing, and can be run again", async () => {
	const { run, sentPrompts, deliverAndEnd } = loadHandoff();
	const failed = handoffCtx(assistant("## Current Task\ntruncated", "error"));
	const failedRun = run("", failed.ctx);
	deliverAndEnd();
	await failedRun;
	assert.equal(failed.sessions.length, 0, "a rejected reply must never become the successor's summary");
	assert.equal(failed.notices.length, 1);
	assert.equal(failed.notices[0]![1], "error");
	assert.match(failed.notices[0]![0], /^No summary generated — handoff generation failed — run \/handoff again$/);

	// The failure released the in-flight slot: the retry the message asks for works.
	const retry = handoffCtx(assistant("## Current Task\nship it"));
	const retryRun = run("", retry.ctx);
	deliverAndEnd();
	await retryRun;
	assert.deepEqual(retry.notices, [], "the retry is not refused as 'already in progress'");
	assert.equal(retry.sessions.length, 1);
	assert.deepEqual(sentPrompts, [HANDOFF_PROMPT, HANDOFF_PROMPT]);
});
