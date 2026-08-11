/**
 * Delegate-contract injection and its survival across context-cap swaps.
 *
 * RunChildOptions.contract must reach the child as a SYSTEM-prompt suffix —
 * registered by subagent.ts's before_agent_start handler at child bind time —
 * and therefore survive a context-cap handoff+swap, which slices only the
 * message array. A first-message contract (the old promptPrefix design) was
 * deleted by the first swap, so the post-swap child no longer knew its last
 * message is harvested as the tool result.
 *
 * These tests run the real runChildTool against children that load the real
 * subagent.ts and context-cap.ts extensions (via re-export wrappers in a temp
 * agent dir), with the model runtime's streamSimple replaced by a scripted
 * stream that records the LLM-visible system prompt and messages per call.
 */

// Must be set before a child loads context-cap.ts (env is read at module load,
// which happens inside createChildSession → createAgentSession → jiti import).
process.env.CONTEXT_CAP_SOFT = "5";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Children resolve their agent dir and session dir from the environment; point
// both at temp dirs so tests never load the live ~/.pi/agent extensions.
// (Assignments in the module body run before any test callback, which is when
// the children are created — static-import hoisting is irrelevant here.)
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-contract-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-contract-sessions-"));
// No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests
// and hang the test process.
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";
import { type ResponseStep, type ScriptedStep, sleep, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// context-cap writes handoff files under the real home dir (os.homedir()), not
// the agent dir override — clean up per child session id in each test.
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

// Children discover extensions in <agentDir>/extensions. Re-export wrappers
// (real files, not symlinks) so each repo extension resolves its own relative
// imports (./lib/…) from its real repo location. Only the two files under test:
// subagent.ts registers the contract injection, context-cap.ts the swap machinery.
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
for (const name of ["subagent.ts", "context-cap.ts"]) {
	writeFileSync(
		path.join(childExtDir, name),
		`export { default } from ${JSON.stringify(path.join(EXT_DIR, name))};\n`,
	);
}

// The children's tool calls flow through ChildView's ToolExecutionComponent, which
// needs an initialized theme (same reason as the view-rendering explore test).
initTheme(undefined, false);

const CONTRACT =
	"CONTRACT-SENTINEL: you are a delegated child; your LAST message is harvested as the tool result.";

const CHILD_OPTIONS = {
	kind: "explorer",
	busyGroup: "contract-test",
	tools: ["read", "grep", "find", "ls", CONTEXT_CAP_TOOL_NAME],
	excludeTools: [],
	contract: CONTRACT,
};

/**
 * The script that drives a full soft-cap handoff cycle in the child
 * (CONTEXT_CAP_SOFT=5; contextTokens 10 is above the cap):
 *  1. harmless tool call above the cap → context-cap steers a handoff request
 *  2. the child finishes its work first — pre-swap "final" answer
 *  3. reminder followUp arrives → the child writes the handoff → swap
 *  4. post-swap turn: context is sliced at the marker; this is the real report
 */
const handoffScript = (): ScriptedStep[] => [
	toolStep("t1", "ls", { path: "." }, 10),
	textStep("real final answer", 10),
	toolStep("h1", CONTEXT_CAP_TOOL_NAME, { markdown: "## Current Task\nReport what happened." }, 10),
	textStep("post-swap report", 2),
];

/** One LLM call as the scripted child model saw it. */
interface CapturedCall {
	systemPrompt: string;
	/** JSON of the LLM-visible message array (post context-event slicing). */
	messages: string;
}

/**
 * Fake ExtensionContext whose model runtime streams scripted responses and
 * records what each LLM call could see. Same shape as explore.test.ts's makeCtx,
 * plus the script/capture plumbing.
 */
async function makeCtx(script: ScriptedStep[], calls: CapturedCall[]): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-contract-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let step = 0;
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		calls.push({
			systemPrompt: String(context?.systemPrompt ?? ""),
			messages: JSON.stringify(context?.messages ?? []),
		});
		// This driver renders responses only (no error steps in child scripts).
		const scripted = (script[step++] ?? textStep("(script exhausted)")) as ResponseStep;
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					// Drives ctx.getContextUsage().tokens (context-cap triggers).
					totalTokens: scripted.contextTokens ?? 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(20);
			if (scripted.kind === "tool") {
				output.content = [
					{ type: "toolCall", id: scripted.id, name: scripted.name, arguments: scripted.args },
				];
				output.stopReason = "toolUse";
			} else {
				output.content = [{ type: "text", text: scripted.text }];
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		})();
		return stream;
	};
	const parentModel = getModel("anthropic", "claude-sonnet-4-5")!;
	return {
		cwd: dir,
		model: parentModel,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
	} as unknown as ExtensionContext;
}

const resultText = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";

/** Remove this child's handoff files and drop all child sessions (open handles). */
function cleanup(childId: string | undefined) {
	if (childId) {
		const sessionId = liveChildren.get(childId)?.session.sessionManager.getSessionId();
		if (sessionId) {
			try {
				for (const n of readdirSync(CAP_DIR)) {
					if (n.startsWith(`${sessionId}-`)) rmSync(path.join(CAP_DIR, n), { force: true });
				}
			} catch {}
		}
	}
	for (const record of liveChildren.values()) record.session.dispose();
	liveChildren.clear();
}

test("finish-then-handoff: the post-swap message is harvested as the tool result", async () => {
	const calls: CapturedCall[] = [];
	const ctx = await makeCtx(handoffScript(), calls);
	let childId: string | undefined;
	try {
		const result = await runChildTool(
			{ prompt: "do the thing", description: "swap survivor" },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);
		childId = (result.details as { id?: string }).id;
		// The new contract of the tool: after a handoff+swap the child keeps acting
		// as a delegate, and the LAST message — the post-swap one — is the report.
		assert.match(resultText(result), /post-swap report/);
		assert.doesNotMatch(resultText(result), /real final answer/);
		// The swap really happened (collectMeta counts the context_handoff call).
		assert.equal((result.details as { resets?: number }).resets, 1);
		assert.equal(calls.length, 4, "the whole cycle must drain inside one tool call");
	} finally {
		cleanup(childId);
	}
});

test("contract survives the swap: still in the system prompt on post-swap and resume turns", async () => {
	const calls: CapturedCall[] = [];
	const script = [...handoffScript(), textStep("resumed answer", 2)];
	const ctx = await makeCtx(script, calls);
	let childId: string | undefined;
	try {
		const result = await runChildTool(
			{ prompt: "original task prompt", description: "contract carrier" },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);
		childId = (result.details as { id?: string }).id;
		assert.equal(calls.length, 4);
		// Injected from the very first turn…
		assert.ok(calls[0].systemPrompt.includes(CONTRACT), "turn 1 system prompt must carry the contract");
		// …and never as a prompt prefix: no request's messages contain it.
		for (const [i, call] of calls.entries()) {
			assert.ok(!call.messages.includes("CONTRACT-SENTINEL"), `call ${i} messages must not carry the contract`);
		}
		// The last call really is post-swap: the original task is gone from the
		// LLM-visible context, replaced by the handoff marker…
		assert.ok(!calls[3].messages.includes("original task prompt"), "post-swap context must be sliced");
		assert.ok(calls[3].messages.includes("continuing work from a previous session"));
		// …and — load-bearing — the system prompt STILL carries the contract.
		assert.ok(calls[3].systemPrompt.includes(CONTRACT), "post-swap system prompt must carry the contract");

		// Resume turns get the contract too (before_agent_start fires per prompt()).
		assert.ok(childId, "result must carry the child id");
		const resumed = await runChildTool(
			{ prompt: "follow-up question", resume_id: childId },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);
		assert.match(resultText(resumed), /resumed answer/);
		assert.equal(calls.length, 5);
		assert.ok(calls[4].systemPrompt.includes(CONTRACT), "resume-turn system prompt must carry the contract");
	} finally {
		cleanup(childId);
	}
});
