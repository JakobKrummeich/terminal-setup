/**
 * ChildView.replay of a cut-off child: the F2 transcript of a child reopened
 * from its session file (lib/child-reopen.ts) after an abort mid-tool or a pi
 * kill mid-run. No live events will ever complete a past tool call, so replay
 * itself must settle every call it draws:
 *   - result saved → paired to its call by toolCallId (also covered end-to-end
 *     in child-reopen.test.ts);
 *   - call of an aborted / errored assistant message → "Operation aborted" /
 *     the message's errorMessage (else "Error"), as pi's own transcript shows;
 *   - any other call without a saved result → "(interrupted — no result recorded)",
 *     including an earlier message's call when a LATER message is the failed one;
 *   - nothing is left pending: a late live event for a replayed id changes nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ChildView } from "../lib/child-view.ts";

initTheme(undefined, false);

const INTERRUPTED = "(interrupted — no result recorded)";

/** A view whose tool rows use pi's generic fallback renderer (no tool definitions). */
function newView(): ChildView {
	const session = {
		getToolDefinition: () => undefined,
		extensionRunner: { resolveToolRenderers: (_name: string, base: () => unknown) => base() },
	};
	return new ChildView(session as never, "/tmp");
}

/** Each call's args carry its id, so the rendered row can be found by it. */
const call = (id: string, name = "ls") => ({ type: "toolCall", id, name, arguments: { path: id } });
const assistant = (calls: unknown[], stopReason: string, errorMessage?: string) => ({
	type: "message",
	message: { role: "assistant", content: calls, stopReason, ...(errorMessage && { errorMessage }) },
});
const toolResult = (toolCallId: string, text: string) => ({
	type: "message",
	message: { role: "toolResult", toolCallId, content: [{ type: "text", text }] },
});

/** Rendered text of the tool row whose args name `id`: from its args up to the next tool row. */
function toolRow(view: ChildView, id: string): string {
	const text = view
		.render(100)
		.map((line) => stripTerminalSequences(line))
		.join("\n");
	const start = text.indexOf(`"path": "${id}"`);
	assert.ok(start >= 0, `no tool row for ${id}:\n${text}`);
	const next = text.indexOf(`"path": "`, start + 1);
	return text.slice(start, next < 0 ? undefined : next);
}

test("replay pairs saved results by id and marks a call without one as interrupted", () => {
	const view = newView();
	view.replay([assistant([call("a1"), call("a2")], "toolUse"), toolResult("a2", "A2-RESULT")]);
	assert.match(toolRow(view, "a2"), /A2-RESULT/);
	assert.ok(!toolRow(view, "a2").includes(INTERRUPTED), "a call with a saved result is not interrupted");
	assert.ok(toolRow(view, "a1").includes(INTERRUPTED), toolRow(view, "a1"));
	assert.ok(!toolRow(view, "a1").includes("A2-RESULT"), "results pair by toolCallId, not by order");
});

test("calls of an aborted or errored message show why they never ran", () => {
	const view = newView();
	view.replay([
		assistant([call("b1")], "aborted"),
		assistant([call("c1")], "error", "PROVIDER-BOOM"),
		assistant([call("d1")], "error"),
	]);
	assert.match(toolRow(view, "b1"), /Operation aborted/);
	assert.match(toolRow(view, "c1"), /PROVIDER-BOOM/);
	assert.match(toolRow(view, "d1"), /\bError\b/);
	for (const id of ["b1", "c1", "d1"]) {
		assert.ok(!toolRow(view, id).includes(INTERRUPTED), `${id}: failed-message calls are not "interrupted"`);
	}
});

test("a later failed message does not relabel an earlier message's unanswered call", () => {
	const view = newView();
	view.replay([assistant([call("e1")], "toolUse"), assistant([call("f1")], "aborted")]);
	assert.ok(toolRow(view, "e1").includes(INTERRUPTED), toolRow(view, "e1"));
	assert.ok(!toolRow(view, "e1").includes("Operation aborted"), toolRow(view, "e1"));
	assert.match(toolRow(view, "f1"), /Operation aborted/);
});

test("replay leaves nothing pending: a late live event for a replayed call changes nothing", () => {
	const view = newView();
	view.replay([assistant([call("g1")], "toolUse")]);
	view.handle({
		type: "tool_execution_end",
		toolCallId: "g1",
		toolName: "ls",
		result: { content: [{ type: "text", text: "LATE-RESULT" }] },
		isError: false,
	} as never);
	assert.ok(!toolRow(view, "g1").includes("LATE-RESULT"), toolRow(view, "g1"));
	assert.ok(toolRow(view, "g1").includes(INTERRUPTED), toolRow(view, "g1"));
});
