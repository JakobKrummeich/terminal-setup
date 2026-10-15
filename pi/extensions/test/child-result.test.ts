/**
 * What runChildTool hands back to the parent: the child's FINAL message — the
 * only thing the caller sees (CHILD_CONTRACT, Agent tool description) — plus the
 * resume_id trailer.
 *
 * The final message is the last assistant message with non-blank text, taken
 * WHOLE: a message whose text arrives in several blocks (pi-ai keeps one block
 * per provider content part; pi's own getLastAssistantText concatenates them)
 * must not be cut down to its last block. Assistant turns after it that carry no
 * text (tool calls, blank text) do not replace it.
 *
 * Children are fake records driven through the resume_id path (as in
 * subagent-wiring.test.ts): the fake session's prompt() emits the scripted
 * message_end events to whoever subscribed, so no model is needed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import type { ChildRecord } from "../lib/child-types.ts";

type Content = Array<{ type: string; text?: string; name?: string }>;

/** An idle child whose next run emits one message_end per entry of `messages`. */
function addChild(id: string, messages: Array<{ role: string; content: Content }>): void {
	const listeners: Array<(event: unknown) => void> = [];
	const session = {
		isIdle: true,
		pendingMessageCount: 0,
		messages: [],
		prompt: async () => {
			for (const message of messages) for (const listener of listeners) listener({ type: "message_end", message });
		},
		waitForIdle: async () => {},
		subscribe: (listener: (event: unknown) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		abort: async () => {},
		getSessionStats: () => ({ cost: 0 }),
		getContextUsage: () => undefined,
		// Empty session dir: agent-runs rows are skipped (appendEvent no-ops).
		sessionManager: { getEntries: () => [], getSessionDir: () => "" },
	};
	const view = { handle: () => {}, addUserMessage: () => {} };
	const record = { id, kind: "agent", sid: `sid-${id}`, rootSid: "root", session, view, description: id };
	liveChildren.set(id, { ...record, turns: 0, elapsedMs: 0, running: false } as unknown as ChildRecord);
}

async function resultText(id: string): Promise<string> {
	const options = { kind: "agent", busyGroup: "child-result-test", excludeTools: [] };
	const result = await runChildTool({ prompt: "go", resume_id: id }, options, undefined, undefined, {} as ExtensionContext);
	assert.equal(result.isError, undefined, JSON.stringify(result.content));
	return result.content[0]?.text ?? "";
}

const assistant = (...content: Content) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const TRAILER = "\n\n---\nagent id: c1 (pass as resume_id to continue)";

test("the final message is returned whole, even when its text spans several blocks", async () => {
	addChild("c1", [
		assistant(text("early notes"), { type: "toolCall", name: "read" }),
		{ role: "toolResult", content: [text("tool output")] },
		assistant(text("## Findings\nfoo.ts:12 is the bug."), { type: "thinking" }, text("Summary: fix foo.ts.")),
	]);
	assert.equal(await resultText("c1"), `## Findings\nfoo.ts:12 is the bug.\nSummary: fix foo.ts.${TRAILER}`);
	liveChildren.clear();
});

test("trailing assistant turns without text keep the last message that had text", async () => {
	addChild("c1", [
		assistant(text("  the real report  ")),
		assistant({ type: "toolCall", name: "ls" }),
		assistant(text("   ")),
	]);
	assert.equal(await resultText("c1"), `the real report${TRAILER}`);
	liveChildren.clear();
});

test("a run without any assistant text says so, and still names the resume id", async () => {
	addChild("c1", [assistant({ type: "toolCall", name: "ls" }), { role: "user", content: [text("not the child's")] }]);
	assert.equal(await resultText("c1"), `(agent produced no text output)${TRAILER}`);
	liveChildren.clear();
});
