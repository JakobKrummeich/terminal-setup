/**
 * trackChildBtw (lib/btw-child.ts) on a REAL child session (runChildTool with a
 * scripted model runtime, like child-contract.test.ts): the snapshot captured at
 * the child's agent.transformContext is exactly the context the child's model
 * call received — incl. the child contract that subagent.ts forces into the
 * system prompt — and the finished final answer lands in the since-list.
 * childBtwSource asks with the child's model and session id.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-btwchild-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-btwchild-sessions-"));
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { type ExtensionContext, initTheme, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BTW_PREAMBLE, buildBtwMessages } from "../lib/btw-context.ts";
import { childBtw, childBtwSource } from "../lib/btw-child.ts";
import { BtwThread } from "../lib/btw-thread.ts";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { assistantMessage, fakeRegistry, finish } from "./btw-fakes.ts";
import { type ResponseStep, type ScriptedStep, sleep, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// The child loads subagent.ts (the contract injection = a forced system prompt).
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
writeFileSync(
	path.join(childExtDir, "subagent.ts"),
	`export { default } from ${JSON.stringify(path.join(EXT_DIR, "subagent.ts"))};\n`,
);
initTheme(undefined, false);

const CONTRACT = "BTW-CONTRACT-SENTINEL: delegated child.";
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Scripted runtime; records each call's messages and the child's fork at that moment. */
async function makeCtx(script: ScriptedStep[], calls: unknown[][], forksAtCall: unknown[][]) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-btwchild-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let step = 0;
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		calls.push(json(context.messages));
		const record = [...liveChildren.values()][0]!;
		forksAtCall.push(json(buildBtwMessages(childBtw(record.session)!.snapshot.fork()!, [], "q").slice(0, -1)));
		// Response steps only (no error steps in this script).
		const scripted = (script[step++] ?? textStep("(script exhausted)")) as ResponseStep;
		const stream = createAssistantMessageEventStream();
		void (async () => {
			await sleep(5);
			const message = assistantMessage(
				scripted.kind === "tool"
					? [{ type: "toolCall", id: scripted.id, name: scripted.name, arguments: scripted.args as never }]
					: [{ type: "text", text: scripted.text }],
				scripted.kind === "tool" ? "toolUse" : "stop",
				{ api: m.api, provider: m.provider, model: m.id, timestamp: Date.now() },
			);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason as "stop", message });
			stream.end();
		})();
		return stream;
	};
	return {
		cwd: dir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

test("child snapshot = the child's model context exactly (forced contract incl.); final answer in since", async () => {
	const calls: unknown[][] = [];
	const forksAtCall: unknown[][] = [];
	const ctx = await makeCtx([toolStep("t1", "ls", { path: "." }), textStep("final report")], calls, forksAtCall);
	try {
		await runChildTool(
			{ prompt: "look around", description: "btw child" },
			{ kind: "explorer", busyGroup: "btw-test", tools: ["ls"], excludeTools: [], contract: CONTRACT },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(calls.length, 2);
		for (const [i, sent] of calls.entries()) {
			assert.deepEqual(forksAtCall[i], sent, `call ${i}: fork at request time = what the model got`);
		}
		assert.ok(getCurrentSystemPrompt(calls[0] as never).includes(CONTRACT), "precondition: contract forced");

		const record = [...liveChildren.values()][0]!;
		const btw = childBtw(record.session)!;
		const thread = new BtwThread();
		const messages = json(buildBtwMessages(btw.snapshot.fork()!, [], "how did it go?"));
		const last = calls[1]!;
		assert.deepEqual(messages.slice(0, last.length), last);
		assert.equal(messages[last.length].role, "assistant");
		assert.equal(messages[last.length].content[0].text, "final report", "message_end since the last request");
		assert.equal(messages.at(-1).content[0].text, `${BTW_PREAMBLE}\n\nhow did it go?`);

		// The F2 source asks with the child's model and session id.
		const registry = fakeRegistry();
		const asked = thread.ask("q", () => childBtwSource(registry, record, btw.snapshot).request());
		const call = registry.calls[0]!;
		assert.equal(call.model, record.session.model);
		assert.equal(call.options.sessionId, record.session.sessionManager.getSessionId());
		assert.equal(call.options.toolChoice, "none");
		finish(call, assistantMessage("fine"));
		await asked;
		assert.equal(thread.turns.length, 1);
	} finally {
		for (const record of liveChildren.values()) record.session.dispose();
		liveChildren.clear();
	}
});
