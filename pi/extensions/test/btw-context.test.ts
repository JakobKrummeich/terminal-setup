/**
 * btw side chat, pure half (lib/btw-context.ts): what a btw request sends.
 *   - buildBtwMessages: preamble framing, synthetic "still running" results only
 *     for calls without one, prior turns replayed without tool calls, errored
 *     turns excluded;
 *   - the forced-prompt projection (pi applies it after context_with_system):
 *     only when the captured prompt differs, keeping the head's toolsAdded;
 *   - ForkSnapshot: undefined before the first request, onRequest resets "since".
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	BTW_PREAMBLE,
	type BtwAgentMessage,
	buildBtwMessages,
	displayAnswer,
	ForkSnapshot,
	PENDING_RESULT_TEXT,
	projectForcedPrompt,
	TOOL_ONLY_TEXT,
} from "../lib/btw-context.ts";
import { assistantMessage } from "./btw-fakes.ts";

const TOOL = { name: "bash", description: "run", parameters: { type: "object", properties: {} } };
const system = (content: string, extra: Record<string, unknown> = {}) =>
	({ role: "system", content, timestamp: 5, ...extra }) as Message;
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 10 }) as Message;
const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "sleep 9" } }) as const;
const result = (id: string) =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 30,
	}) as Message;
const text = (message: Message | undefined) =>
	message && Array.isArray(message.content)
		? message.content.map((block) => ("text" in block ? block.text : `<${block.type}>`)).join("|")
		: String(message?.content);

const fork = (messages: Message[], systemPrompt?: string) => ({
	messages: messages as BtwAgentMessage[],
	systemPrompt,
});

test("buildBtwMessages: transcript, synthetic pending result right after its call, framed question", () => {
	const head = system("PROMPT", { toolsAdded: [TOOL] });
	const inFlight = assistantMessage([{ type: "text", text: "checking" }, call("c2")], "toolUse");
	const messages = buildBtwMessages(
		fork([head, user("task"), assistantMessage([call("c1")], "toolUse"), result("c1"), inFlight], "PROMPT"),
		[],
		"what now?",
	);
	assert.deepEqual(
		messages.map((m) => m.role),
		["system", "user", "assistant", "toolResult", "assistant", "toolResult", "user"],
	);
	assert.equal(messages[0], head, "prompt unchanged: no projection when the captured prompt matches");
	const pending = messages[5] as Extract<Message, { role: "toolResult" }>;
	assert.equal(pending.toolCallId, "c2");
	assert.equal(pending.toolName, "bash");
	assert.equal(pending.isError, false);
	assert.equal(text(pending), PENDING_RESULT_TEXT);
	assert.equal(text(messages[6]), `${BTW_PREAMBLE}\n\nwhat now?`, "preamble, blank line, question");
});

test("buildBtwMessages: no synthetic result when the call has one; old orphans and failed calls left alone", () => {
	const answered = buildBtwMessages(fork([user("t"), assistantMessage([call("c1")], "toolUse"), result("c1")]), [], "q");
	assert.equal(answered.filter((m) => m.role === "toolResult").length, 1, "only the real result");

	// An orphan call in an EARLIER assistant message is not running (a run killed
	// mid-tool): pi-ai's own "No result provided" applies, not "still running".
	const orphan = buildBtwMessages(
		fork([user("t"), assistantMessage([call("old")], "toolUse"), user("again"), assistantMessage("hi")]),
		[],
		"q",
	);
	assert.equal(orphan.filter((m) => m.role === "toolResult").length, 0);

	// transformMessages drops errored/aborted assistant messages — a result for
	// their calls would be an orphan the provider rejects.
	const errored = buildBtwMessages(fork([user("t"), assistantMessage([call("c9")], "error")]), [], "q");
	assert.equal(errored.filter((m) => m.role === "toolResult").length, 0);
});

test("buildBtwMessages: prior turns replayed without tool calls; errored turns excluded entirely", () => {
	const turns = [
		{ question: "first?", answer: assistantMessage([{ type: "text", text: "A1" }, call("x")], "toolUse") },
		{ question: "broken?", answer: assistantMessage([], "error", { errorMessage: "overloaded" }) },
		{ question: "tool only?", answer: assistantMessage([call("y")], "toolUse") },
	];
	const messages = buildBtwMessages(fork([user("task")]), turns, "third?");
	assert.deepEqual(
		messages.map((m) => `${m.role}:${text(m)}`),
		[
			"user:task",
			`user:${BTW_PREAMBLE}\n\nfirst?`,
			"assistant:A1",
			`user:${BTW_PREAMBLE}\n\ntool only?`,
			`assistant:${TOOL_ONLY_TEXT}`,
			`user:${BTW_PREAMBLE}\n\nthird?`,
		],
	);
	for (const m of messages) {
		if (m.role === "assistant") assert.ok(!m.content.some((b) => b.type === "toolCall"), "no tool calls replayed");
	}
});

test("displayAnswer: strips tool calls, placeholder only when nothing else remains, errors untouched", () => {
	const plain = assistantMessage("hi");
	assert.equal(displayAnswer(plain), plain, "no tool call: same object");
	const mixed = displayAnswer(assistantMessage([{ type: "text", text: "A" }, call("x")], "toolUse"));
	assert.equal(text(mixed), "A");
	assert.equal(mixed.stopReason, "stop");
	assert.equal(text(displayAnswer(assistantMessage([call("x")], "toolUse"))), TOOL_ONLY_TEXT);
	const failed = displayAnswer(assistantMessage([call("x")], "error", { errorMessage: "boom" }));
	assert.deepEqual(failed.content, [], "errored: AssistantMessageComponent shows the errorMessage instead");
});

test("projectForcedPrompt: forced prompt replaces the head, keeps current tools, drops other system messages", () => {
	const head = system("BUILT", { toolsAdded: [TOOL] });
	const update = system("UPDATE", { toolsAdded: [{ ...TOOL, name: "grep" }], timestamp: 50 });
	const transcript = [head, user("task"), update, assistantMessage("ok")];

	const projected = projectForcedPrompt(transcript, "FORCED");
	assert.deepEqual(
		projected.map((m) => m.role),
		["system", "user", "assistant"],
	);
	const newHead = projected[0] as Extract<Message, { role: "system" }>;
	assert.equal(newHead.content, "FORCED");
	assert.deepEqual(
		newHead.toolsAdded?.map((t) => t.name),
		["bash", "grep"],
		"the CURRENT tool set (getCurrentSystemMessage), like pi's projection",
	);
	assert.equal(newHead.timestamp, 5, "first system message's timestamp");

	// Captured prompt equal to the transcript's: untouched (no forced prompt was active).
	assert.deepEqual(projectForcedPrompt(transcript, "BUILT\n\nUPDATE"), transcript);
	assert.deepEqual(projectForcedPrompt(transcript, undefined), transcript, "not captured (children): untouched");

	// buildBtwMessages applies it.
	const built = buildBtwMessages(fork([head, user("task")], "FORCED"), [], "q");
	assert.equal((built[0] as { content: unknown }).content, "FORCED");
	assert.deepEqual((built[0] as { toolsAdded?: unknown }).toolsAdded, [TOOL]);
});

test("ForkSnapshot: undefined before the first request; onRequest resets the since-list", () => {
	const snapshot = new ForkSnapshot();
	snapshot.onMessageEnd(user("early") as BtwAgentMessage);
	assert.equal(snapshot.fork(), undefined, "nothing to fork before a model request");

	const request = [user("task")] as BtwAgentMessage[];
	snapshot.onRequest(request, "PROMPT");
	request.push(user("mutated after capture") as BtwAgentMessage);
	snapshot.onMessageEnd(assistantMessage([call("c1")], "toolUse"));
	let forked = snapshot.fork()!;
	assert.equal(forked.systemPrompt, "PROMPT");
	assert.deepEqual(
		forked.messages.map((m) => m.role),
		["user", "assistant"],
		"request slice + message finished since; the 'early' one is gone",
	);

	snapshot.onRequest([user("task"), user("next")] as BtwAgentMessage[]);
	forked = snapshot.fork()!;
	assert.equal(forked.messages.length, 2, "since-list cleared by the new request");
	assert.equal(forked.systemPrompt, undefined);
});
