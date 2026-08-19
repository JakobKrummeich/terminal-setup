/**
 * Child sessions get NO timer tool — "timer works differently in a subagent"
 * resolved by not offering it there at all.
 *
 * Why: a child binds its extensions with `session.bindExtensions({})`, and pi's
 * ExtensionRunner defaults `mode` to "print" (dist/core/extensions/runner.js),
 * so a child timer could only ever take the BLOCKING path — which buys nothing
 * over `bash sleep N` (nothing in pi times a tool call out) while costing
 * tool-listing tokens in every child prompt and inviting park-semantics
 * confusion. timer.ts therefore registers nothing in children (bind-time
 * inChildSession() guard, same pattern as wsstate.ts / agent-busy-tracker.ts).
 * Explorers never had it (readonly allowlist); this covers agent children too.
 *
 * Pinned here on a REAL child driven through runChildTool, with timer.ts (and
 * the two OSC extensions) present in the child's extensions dir like in
 * production:
 *  - a scripted timer call comes back "Tool timer not found" — the tool is
 *    structurally absent, not merely discouraged;
 *  - nothing blocks: the child's run completes far quicker than the requested
 *    wait, and no pending-work claim is left behind;
 *  - the child emits NO wsstate/wswait OSC on the shared stdout (those
 *    extensions are main-session-only, agent-busy-tracker.test.ts has the
 *    positive side).
 */

// Children resolve their agent dir and session dir from the environment; point
// both at temp dirs so tests never load the live ~/.pi/agent extensions.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-childtimer-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-childtimer-sessions-"));
// No remote model-catalog refresh: its keep-alive TLS sockets hang the suite.
process.env.PI_OFFLINE = "1";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { hasPendingWork } from "../lib/pending-work.ts";
import { type ResponseStep, type ScriptedStep, sleep, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Children discover extensions in <agentDir>/extensions. Re-export wrappers
// (real files, not symlinks) let each repo extension resolve its relative
// imports from its real location (same trick as child-contract.test.ts).
// wsstate + agent-busy-tracker ride along like in a production child: all three
// must detect the child at bind time and register nothing.
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
for (const name of ["timer.ts", "wsstate.ts", "agent-busy-tracker.ts"]) {
	writeFileSync(
		path.join(childExtDir, name),
		`export { default } from ${JSON.stringify(path.join(EXT_DIR, name))};\n`,
	);
}

// The child's tool calls flow through ChildView's ToolExecutionComponent,
// which needs an initialized theme.
initTheme(undefined, false);

const TIMER_SECONDS = 30;

const CHILD_OPTIONS = {
	kind: "agent",
	busyGroup: "child-timer-test",
	tools: ["timer"],
	excludeTools: [],
};

/** One LLM call as the scripted child model saw it. */
interface CapturedCall {
	/** JSON of the LLM-visible message array. */
	messages: string;
}

/**
 * Fake ExtensionContext whose model runtime streams scripted responses and
 * records the message array each LLM call could see (child-contract.test.ts's
 * makeCtx, minus the system-prompt capture).
 */
async function makeCtx(script: ScriptedStep[], calls: CapturedCall[]): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-childtimer-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let step = 0;
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		calls.push({ messages: JSON.stringify(context?.messages ?? []) });
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
					totalTokens: 2,
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

test("a real child has no timer tool: call errors fast, nothing blocks, no OSC, no claim", async () => {
	const calls: CapturedCall[] = [];
	const ctx = await makeCtx(
		[
			toolStep("t1", "timer", { action: "set", name: "childwait", seconds: TIMER_SECONDS }),
			textStep("final report without waiting"),
		],
		calls,
	);
	// Capture everything the child writes to the shared stdout: a child's
	// wsstate/agent-busy-tracker emission would corrupt the parent terminal's
	// workspace state (child agent_end → "idle"/"waiting" mid-parent-run).
	const stdoutChunks: string[] = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stdout.write;
	try {
		const startedAt = Date.now();
		const result = await runChildTool(
			{ prompt: "try to wait, then report", description: "child without timer" },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);
		const elapsed = Date.now() - startedAt;
		const text = result.content[0]?.text ?? "";

		// The child recovered from the missing tool and its report is harvested —
		// long before the requested 30s wait could have elapsed.
		assert.match(text, /final report without waiting/);
		assert.ok(elapsed < TIMER_SECONDS * 1000, `run must not block on the timer (took ${elapsed}ms)`);

		// The timer call itself came back as a structural error: not registered.
		assert.equal(calls.length, 2, "timer attempt + final answer");
		assert.ok(
			calls[1].messages.includes("Tool timer not found"),
			"the child's timer call must fail as an unknown tool",
		);
		assert.ok(!calls[1].messages.includes("fired after"), "no blocking wait ran");
		assert.ok(!calls[1].messages.includes("expired."), "no wake-up was injected");

		// No pending-work claim outlives the call (the interactive path's claim
		// machinery never engaged).
		for (const record of liveChildren.values()) {
			assert.equal(
				hasPendingWork(record.session.sessionManager.getSessionId()),
				false,
				"child must hold no pending-work claim",
			);
		}

		// The child loaded wsstate.ts and agent-busy-tracker.ts like production
		// children do — and emitted NO terminal-state OSC: all main-session-only.
		const osc = stdoutChunks.filter((c) => c.includes("SetUserVar=ws"));
		assert.deepEqual(osc, [], "child must not write wsstate/wswait to the shared stdout");
	} finally {
		process.stdout.write = originalWrite;
		for (const record of liveChildren.values()) record.session.dispose();
		liveChildren.clear();
	}
});
