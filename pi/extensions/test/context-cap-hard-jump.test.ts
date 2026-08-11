/**
 * One-jump hard-cap crossing in a CHILD session (regression, observed live
 * 2026-08-11): an explorer greps a sourcemap and one tool result jumps its
 * context from far below the soft cap straight past the hard cap. The old code
 * wiped the context at message_end ("hard-no-file" swap) before any handoff was
 * ever requested — the child continued on the "context lost, ask the user"
 * fallback and its report was garbage. Since the crossing message ends in tool
 * calls, another turn is guaranteed, so context-cap must steer an emergency
 * handoff instead and the swap must carry the real handoff body.
 *
 * Also covers the display half of the same report: ChildView (F2 watch) must
 * render injected user messages (context-cap steers/reminders) and displayable
 * custom messages (the swap marker) — previously both were silently dropped, so
 * a watched child appeared to "lose" its handoff even when the swap worked.
 */

// Caps must be set before a child loads context-cap.ts (env is read at module
// load, inside createChildSession → createAgentSession → jiti import).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Children resolve their agent dir and session dir from the environment; point
// both at temp dirs so tests never load the live ~/.pi/agent extensions.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-hardjump-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-hardjump-sessions-"));
// No remote model-catalog refresh: its keep-alive TLS sockets hang the test process.
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionEvent,
	initTheme,
	ModelRuntime,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ChildView, liveChildren, runChildTool } from "../lib/child-session.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";
import { type ScriptedStep, sleep, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// context-cap writes handoff files under the real home dir (os.homedir()).
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

// Children discover extensions in <agentDir>/extensions. Re-export wrapper (real
// file, not symlink) so context-cap.ts resolves its relative imports (./lib/…)
// from its real repo location.
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
writeFileSync(
	path.join(childExtDir, "context-cap.ts"),
	`export { default } from ${JSON.stringify(path.join(EXT_DIR, "context-cap.ts"))};\n`,
);

// ChildView's components (ToolExecutionComponent, UserMessageComponent) need an
// initialized theme.
initTheme(undefined, false);

const HANDOFF_BODY = "## Current Task\nSurvive-the-jump-SENTINEL.";

const CHILD_OPTIONS = {
	kind: "explorer",
	busyGroup: "hard-jump-test",
	tools: ["read", "grep", "find", "ls", CONTEXT_CAP_TOOL_NAME],
	excludeTools: [],
};

/**
 * The script that reproduces the live failure:
 *  1. harmless tool call whose result jumps the context to 60 tokens — past
 *     BOTH caps (soft 5, hard 50) in one message, with stopReason "toolUse"
 *  2. the emergency steer arrives → the child writes the handoff (still ≥ hard;
 *     the grace turn must protect this message from the backstop)
 *  3. post-swap turn: the sliced context must contain the handoff body
 */
const jumpScript = (): ScriptedStep[] => [
	toolStep("t1", "ls", { path: "." }, 60),
	toolStep("h1", CONTEXT_CAP_TOOL_NAME, { markdown: HANDOFF_BODY }, 60),
	textStep("post-swap report", 2),
];

/** One LLM call as the scripted child model saw it. */
interface CapturedCall {
	/** JSON of the LLM-visible message array (post context-event slicing). */
	messages: string;
}

/** Fake ExtensionContext with a scripted model runtime — same shape as child-contract.test.ts. */
async function makeCtx(script: ScriptedStep[], calls: CapturedCall[]): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-hardjump-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let step = 0;
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		calls.push({ messages: JSON.stringify(context?.messages ?? []) });
		const scripted = script[step++] ?? textStep("(script exhausted)");
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

test("one-jump hard-cap crossing: emergency steer, handoff survives into the swap", async () => {
	const calls: CapturedCall[] = [];
	const ctx = await makeCtx(jumpScript(), calls);
	let childId: string | undefined;
	try {
		const result = await runChildTool(
			{ prompt: "explore something huge", description: "jump survivor" },
			CHILD_OPTIONS,
			undefined,
			undefined,
			ctx,
		);
		childId = (result.details as { id?: string }).id;
		const text = result.content[0]?.text ?? "";
		assert.match(text, /post-swap report/);
		assert.equal(calls.length, 3, "jump turn, handoff turn, post-swap turn — nothing more");

		// The emergency steer reached the agent before the handoff turn.
		assert.ok(calls[1].messages.includes("[context-cap]"), "handoff turn must have seen the emergency steer");

		// The load-bearing assertion: the post-swap context carries the REAL
		// handoff body, not the "context lost" fallback.
		assert.ok(
			calls[2].messages.includes("Survive-the-jump-SENTINEL"),
			`post-swap context must contain the handoff body, got: ${calls[2].messages.slice(0, 400)}`,
		);
		assert.ok(calls[2].messages.includes("continuing work from a previous session"));
		assert.ok(
			!calls[2].messages.includes("hit its hard context limit"),
			"post-swap context must not be the no-handoff fallback",
		);
		// Sliced: the original prompt is gone from the LLM-visible context.
		assert.ok(!calls[2].messages.includes("explore something huge"), "post-swap context must be sliced");

		// Session forensics: the swap was a fresh-handoff swap, and the tool was
		// never refused (the old code reset the cycle before the tool ran).
		assert.ok(childId);
		const messages = liveChildren.get(childId)!.session.messages as Array<{
			role: string;
			customType?: string;
			details?: { trigger?: string; handoffPath?: string | null };
			content?: unknown;
		}>;
		const marker = messages.find((m) => m.role === "custom" && m.customType === "context-cap-swap");
		assert.ok(marker, "swap marker must be in the session");
		assert.equal(marker.details?.trigger, "soft", "swap must be the fresh-handoff kind");
		assert.ok(marker.details?.handoffPath, "swap must record the handoff file");
		const refused = messages.some(
			(m) => m.role === "toolResult" && JSON.stringify(m.content ?? "").includes("Refused: no handoff was requested"),
		);
		assert.equal(refused, false, "the handoff tool must not be refused");
	} finally {
		cleanup(childId);
	}
});

test("ChildView renders injected steers and swap markers; prompt renders once", () => {
	const view = new ChildView({ getToolDefinition: () => undefined } as never, "/tmp");
	const event = (message: Record<string, unknown>) =>
		({ type: "message_start", message }) as unknown as AgentSessionEvent;
	view.addUserMessage("TASK-PROMPT-SENTINEL");
	// prompt() re-delivers the prompt as a user message event — must not double-render.
	view.handle(event({ role: "user", content: [{ type: "text", text: "TASK-PROMPT-SENTINEL" }] }));
	// Mid-run injections: a context-cap steer (user) and the swap marker (custom).
	view.handle(event({ role: "user", content: [{ type: "text", text: "STEER-SENTINEL" }] }));
	view.handle(
		event({ role: "custom", customType: "context-cap-swap", content: "MARKER-SENTINEL", display: true }),
	);
	// Non-display custom messages stay hidden.
	view.handle(event({ role: "custom", customType: "other", content: "HIDDEN-SENTINEL", display: false }));
	const out = view.render(200).join("\n");
	assert.ok(out.includes("STEER-SENTINEL"), "steer message must render");
	assert.ok(out.includes("MARKER-SENTINEL"), "swap marker must render");
	assert.ok(!out.includes("HIDDEN-SENTINEL"), "display:false custom messages must not render");
	assert.equal(out.split("TASK-PROMPT-SENTINEL").length - 1, 1, "prompt must render exactly once");
});
