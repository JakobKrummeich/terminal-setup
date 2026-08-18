/**
 * A REAL child session's timer takes the BLOCKING path — the contract behind
 * "timer works differently in a subagent than in the main agent".
 *
 * Why this is worth pinning: child-session.ts binds child extensions with
 * `session.bindExtensions({})`, and it is pi's ExtensionRunner DEFAULT
 * (`mode = "print"`, dist/core/extensions/runner.js) that makes timer's
 * isInteractive() false in every child, even when the parent runs under the
 * TUI. Nothing in this repo states that mode; if a pi update ever changed the
 * default (or started inheriting the parent's mode), children would silently
 * flip to the async wake-up path. That flip would still be bridged by the
 * pending-work machinery (session-quiet.test.ts covers it with a forced
 * mode: "tui"), but the observable semantics change: the child goes idle
 * mid-wait, claims pending work, and is woken by an injected user message.
 * This test fails loudly on that day instead of letting the semantics drift.
 *
 * Blocking-path fingerprints asserted here, on a child driven through the real
 * runChildTool + the real timer extension:
 *  - the tool call itself spans the wait (parent's call is held >= the wait);
 *  - the post-wait LLM call sees the blocking TOOL RESULT ("fired after Ns")
 *    and NO injected wake-up user message ("expired." is the async text);
 *  - the child never claims pending work during the wait (the async path
 *    claims from the moment the timer is set).
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

// Children discover extensions in <agentDir>/extensions. A re-export wrapper
// (real file, not a symlink) lets the repo's timer.ts resolve its relative
// imports from its real location (same trick as child-contract.test.ts).
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
// wsstate + agent-busy-tracker ride along like in a production child (children
// load the whole extensions dir): both must detect the child and stay silent.
for (const name of ["timer.ts", "wsstate.ts", "agent-busy-tracker.ts"]) {
	writeFileSync(
		path.join(childExtDir, name),
		`export { default } from ${JSON.stringify(path.join(EXT_DIR, name))};\n`,
	);
}

// The child's tool calls flow through ChildView's ToolExecutionComponent,
// which needs an initialized theme.
initTheme(undefined, false);

const TIMER_SECONDS = 2;

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

test("a real child's timer blocks inside the tool call (print mode), no wake-up, no claim", async () => {
	const calls: CapturedCall[] = [];
	const ctx = await makeCtx(
		[
			toolStep("t1", "timer", { action: "set", name: "childwait", seconds: TIMER_SECONDS }),
			textStep("final report after the wait"),
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
		const resultPromise = runChildTool(
			{ prompt: "wait it out, then report", description: "child timer blocking" },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);

		// Mid-wait probe: find the child and check it holds NO pending-work claim.
		// The async path claims from the moment the timer is set; the blocking
		// path never does — the in-flight tool call itself is the pending work.
		let childSessionId: string | undefined;
		for (let i = 0; i < 100 && childSessionId === undefined; i++) {
			await sleep(20);
			for (const record of liveChildren.values()) {
				childSessionId = record.session.sessionManager.getSessionId();
			}
		}
		assert.ok(childSessionId, "child session must appear in the registry");
		await sleep((TIMER_SECONDS * 1000) / 2); // now mid-wait, if it blocks
		assert.equal(hasPendingWork(childSessionId), false, "blocking path must not claim pending work");

		const result = await resultPromise;
		const elapsed = Date.now() - startedAt;
		const text = result.content[0]?.text ?? "";

		// The harvested report only exists after the wait: the call spanned it.
		assert.match(text, /final report after the wait/);
		assert.ok(
			elapsed >= TIMER_SECONDS * 1000 - 50,
			`parent's tool call must span the wait (took ${elapsed}ms)`,
		);

		// The post-wait LLM call saw the blocking tool RESULT, not a wake-up.
		assert.equal(calls.length, 2, "set + final answer, nothing else");
		assert.ok(
			calls[1].messages.includes("fired after"),
			"post-wait call must carry the blocking result ('fired after Ns')",
		);
		assert.ok(
			!calls[1].messages.includes("expired."),
			"no injected wake-up user message (that is the interactive path)",
		);
		assert.ok(
			!calls[1].messages.includes("End your turn"),
			"the blocking result never tells the child to end its turn",
		);

		// The child loaded wsstate.ts and agent-busy-tracker.ts like production
		// children do — and emitted NO terminal-state OSC: both are main-session-only.
		const osc = stdoutChunks.filter((c) => c.includes("SetUserVar=ws"));
		assert.deepEqual(osc, [], "child must not write wsstate/wswait to the shared stdout");
	} finally {
		process.stdout.write = originalWrite;
		for (const record of liveChildren.values()) record.session.dispose();
		liveChildren.clear();
	}
});
