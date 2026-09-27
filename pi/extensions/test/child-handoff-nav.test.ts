/**
 * F2 watch view: handoff dividers, jump anchors and header/navigation helpers.
 *
 * ChildView prefixes every context-cap swap marker ("context-cap-swap") with a
 * one-line `── ⇄ handoff i/N · at …k tokens · <trigger> ──` divider whose line
 * index render() records in handoffAnchors — the Shift+↑/↓ jump targets. Covered
 * for replay (saved branch), both live transports (message_start and Pi >=0.87
 * entry_appended), and a real child run whose swap is delivered by pi itself.
 */

// Caps must be set before a child loads context-cap.ts (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Temp agent/session dirs: never load the live ~/.pi/agent extensions.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-handoffnav-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-handoffnav-sessions-"));
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionEvent,
	initTheme,
	ModelRuntime,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ChildView, handoffDividerText } from "../lib/child-view.ts";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import {
	handoffContextIndex,
	handoffHeaderLine,
	handoffJumpTarget,
	handoffViewContext,
	liveElapsedMs,
} from "../lib/child-watch.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";
import { type ResponseStep, type ScriptedStep, sleep, textStep, toolStep } from "./harness.ts";
import { contextCapDir } from "../lib/agent-dir.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Children discover extensions in <agentDir>/extensions (re-export wrapper, see
// context-cap-hard-jump.test.ts).
const childExtDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions");
mkdirSync(childExtDir, { recursive: true });
writeFileSync(
	path.join(childExtDir, "context-cap.ts"),
	`export { default } from ${JSON.stringify(path.join(EXT_DIR, "context-cap.ts"))};\n`,
);

initTheme(undefined, false);

const newView = () => new ChildView({ getToolDefinition: () => undefined } as never, "/tmp");
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const marker = (content: string, details?: Record<string, unknown>) => ({
	type: "custom_message",
	customType: "context-cap-swap",
	content,
	display: true,
	...(details && { details }),
});
const userEntry = (text: string) => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});

test("replay: two swap markers get numbered dividers at the recorded anchors", () => {
	const view = newView();
	view.replay([
		userEntry("TASK-SENTINEL"),
		assistantEntry("WORK-ONE-SENTINEL"),
		marker("BODY-ONE-SENTINEL", { tokensAtSwap: 162_000, trigger: "soft", author: "agent" }),
		assistantEntry("WORK-TWO-SENTINEL"),
		marker("BODY-TWO-SENTINEL", { tokensAtSwap: 58_400, trigger: "hard-no-file", author: null }),
		assistantEntry("WORK-THREE-SENTINEL"),
	]);
	assert.equal(view.handoffCount, 2);
	const lines = plain(view.render(80));
	assert.equal(view.handoffAnchors.length, 2);
	const [first, second] = view.handoffAnchors.map((i) => lines[i]!);
	assert.match(first, /^── ⇄ handoff 1\/2 · at 162k tokens · soft cap ─+$/);
	assert.match(second, /^── ⇄ handoff 2\/2 · at 58k tokens · hard cap, no handoff file ─+$/);
	assert.equal([...first].length, 80, "divider is padded to the render width");
	// The divider sits right before its body; bodies and other messages render once.
	const out = lines.join("\n");
	for (const sentinel of ["TASK", "WORK-ONE", "BODY-ONE", "WORK-TWO", "BODY-TWO", "WORK-THREE"]) {
		assert.equal(count(out, `${sentinel}-SENTINEL`), 1, `${sentinel} renders exactly once`);
	}
	const bodyOne = lines.findIndex((line) => line.includes("BODY-ONE-SENTINEL"));
	assert.ok(bodyOne > view.handoffAnchors[0]! && bodyOne < view.handoffAnchors[1]!);
	// Anchors are line indexes of the LATEST render (width changes move them).
	const narrow = plain(view.render(30));
	assert.match(narrow[view.handoffAnchors[1]!]!, /^── ⇄ handoff 2\/2/);
});

test("replay: marker without details still gets a bare `handoff i/N` divider", () => {
	const view = newView();
	view.replay([userEntry("TASK"), marker("BODY-SENTINEL"), marker("BODY-2", { trigger: "weird" })]);
	assert.equal(view.handoffCount, 2);
	const lines = plain(view.render(60));
	assert.match(lines[view.handoffAnchors[0]!]!, /^── ⇄ handoff 1\/2 ─+$/);
	assert.match(lines[view.handoffAnchors[1]!]!, /^── ⇄ handoff 2\/2 ─+$/, "unknown trigger is omitted");
});

test("non-marker custom messages and hidden markers get no divider", () => {
	const view = newView();
	view.replay([
		{ type: "custom_message", customType: "other", content: "OTHER", display: true },
		{ ...marker("HIDDEN", { trigger: "soft" }), display: false },
	]);
	view.render(80);
	assert.equal(view.handoffCount, 0);
	assert.deepEqual(view.handoffAnchors, []);
});

test("live: both transports add one anchor each; N grows at render time", () => {
	const view = newView();
	view.addUserMessage("TASK-SENTINEL");
	view.handle({
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text: "TASK-SENTINEL" }] },
	} as unknown as AgentSessionEvent);
	// Legacy transport: steered custom message → message_start.
	view.handle({
		type: "message_start",
		message: {
			role: "custom",
			customType: "context-cap-swap",
			content: "LIVE-ONE-SENTINEL",
			display: true,
			details: { tokensAtSwap: 1500, trigger: "hard" },
		},
	} as unknown as AgentSessionEvent);
	assert.equal(view.handoffCount, 1);
	let lines = plain(view.render(80));
	assert.match(lines[view.handoffAnchors[0]!]!, /^── ⇄ handoff 1\/1 · at 2k tokens · hard cap ─+$/);
	// Pi >=0.87 boundary-committed marker: entry_appended only.
	view.handle({
		type: "entry_appended",
		entry: marker("LIVE-TWO-SENTINEL", { tokensAtSwap: 900, trigger: "soft" }),
	} as unknown as AgentSessionEvent);
	assert.equal(view.handoffCount, 2);
	lines = plain(view.render(80));
	assert.equal(view.handoffAnchors.length, 2);
	assert.match(lines[view.handoffAnchors[0]!]!, /handoff 1\/2 · at 2k tokens · hard cap/, "i/N recomputed");
	assert.match(lines[view.handoffAnchors[1]!]!, /handoff 2\/2 · at 900 tokens · soft cap/);
	const out = lines.join("\n");
	assert.equal(count(out, "TASK-SENTINEL"), 1);
	assert.equal(count(out, "LIVE-ONE-SENTINEL"), 1);
	assert.equal(count(out, "LIVE-TWO-SENTINEL"), 1);
});

test("render() output is identical to the plain Container walk", () => {
	const view = newView();
	view.replay([userEntry("A"), marker("B", { trigger: "soft" }), assistantEntry("C")]);
	const container = (view as unknown as { container: { render(w: number): string[] } }).container;
	assert.deepEqual(view.render(72), container.render(72));
});

test("handoffJumpTarget edge cases", () => {
	const far = 1000; // maxOffset beyond every anchor: all are reachable tops
	// No anchors.
	assert.equal(handoffJumpTarget([], 0, 1, far), "tail");
	assert.equal(handoffJumpTarget([], 5, -1, far), undefined);
	const anchors = [10, 20, 30];
	// Before the first anchor.
	assert.equal(handoffJumpTarget(anchors, 0, 1, far), 10);
	assert.equal(handoffJumpTarget(anchors, 0, -1, far), undefined);
	// Exactly on an anchor: strictly past it in both directions.
	assert.equal(handoffJumpTarget(anchors, 20, 1, far), 30);
	assert.equal(handoffJumpTarget(anchors, 20, -1, far), 10);
	assert.equal(handoffJumpTarget(anchors, 10, -1, far), undefined);
	// Between anchors.
	assert.equal(handoffJumpTarget(anchors, 15, 1, far), 20);
	assert.equal(handoffJumpTarget(anchors, 15, -1, far), 10);
	// On / after the last anchor: down follows the tail.
	assert.equal(handoffJumpTarget(anchors, 30, 1, far), "tail");
	assert.equal(handoffJumpTarget(anchors, 45, 1, far), "tail");
	// Up from beyond the last.
	assert.equal(handoffJumpTarget(anchors, 45, -1, far), 30);
});

test("handoffJumpTarget: an anchor on the final screen (> maxOffset) means tail", () => {
	const anchors = [10, 20, 30];
	// maxOffset 25: anchor 30 can never be the top line.
	assert.equal(handoffJumpTarget(anchors, 20, 1, 25), "tail");
	assert.equal(handoffJumpTarget(anchors, 25, 1, 25), "tail", "from the tail: no stuck re-target");
	// An anchor exactly at maxOffset is still a reachable top.
	assert.equal(handoffJumpTarget(anchors, 20, 1, 30), 30);
	assert.equal(handoffJumpTarget(anchors, 0, 1, 25), 10);
	// Up is unaffected: last anchor strictly above the top.
	assert.equal(handoffJumpTarget(anchors, 25, -1, 25), 20);
	// maxOffset 0 (body fits): every down is the tail.
	assert.equal(handoffJumpTarget([3], 0, 1, 0), "tail");
});

test("handoffViewContext: top line's context, last visible line's at the tail", () => {
	const anchors = [10, 20, 30];
	// Body 40 lines, viewport 12 → maxOffset 28.
	assert.equal(handoffViewContext(anchors, 0, 12, 40), 1);
	assert.equal(handoffViewContext(anchors, 20, 12, 40), 3, "top on anchor 2");
	assert.equal(handoffViewContext(anchors, 27, 12, 40), 3, "one above the tail: still the top line");
	assert.equal(handoffViewContext(anchors, 28, 12, 40), 4, "tail: last visible line (39) is past anchor 3");
	// Tail where the last visible line sits exactly on an anchor.
	assert.equal(handoffViewContext([10, 39], 28, 12, 40), 3);
	// Body shorter than the viewport: tail at 0, last line bounded by the body.
	assert.equal(handoffViewContext([2, 50], 0, 20, 5), 2);
	assert.equal(handoffViewContext([], 0, 20, 0), 1, "empty body");
});

test("liveElapsedMs adds the in-flight run only while running", () => {
	const now = 1_000_000;
	assert.equal(liveElapsedMs({ elapsedMs: 5000, running: true, runStartedAt: now - 2000 }, now), 7000);
	assert.equal(liveElapsedMs({ elapsedMs: 5000, running: false, runStartedAt: now - 2000 }, now), 5000);
	assert.equal(liveElapsedMs({ elapsedMs: 5000, running: true }, now), 5000, "reopen window: no start yet");
	assert.equal(liveElapsedMs({ elapsedMs: 5000, running: true, runStartedAt: now + 50 }, now), 5000, "clock skew");
});

test("handoffContextIndex counts anchors at or above the viewport top", () => {
	assert.equal(handoffContextIndex([], 99), 1);
	assert.equal(handoffContextIndex([10, 20], 0), 1);
	assert.equal(handoffContextIndex([10, 20], 10), 2);
	assert.equal(handoffContextIndex([10, 20], 19), 2);
	assert.equal(handoffContextIndex([10, 20], 25), 3);
});

test("handoffHeaderLine: handoff count, context k/N+1 and duration (no ctx/cost)", () => {
	assert.equal(handoffHeaderLine(2, 3, 754_000), "⇄ 2 handoffs · context 3/3 · 12m34s");
	assert.equal(handoffHeaderLine(1, 1, 754_000), "⇄ 1 handoff · context 1/2 · 12m34s");
	assert.equal(handoffHeaderLine(0, 1, 5_000), "⇄ no handoffs · 5s");
});

test("handoffDividerText truncates when the label is wider than the width", () => {
	// truncateToWidth may append an SGR reset; only the visible text matters.
	const text = stripTerminalSequences(handoffDividerText(1, 1, { tokensAtSwap: 162_000, trigger: "soft" }, 10));
	assert.equal([...text].length, 10);
	assert.ok(text.startsWith("── ⇄ hand"));
});

// --- real child: pi delivers the swap marker through whichever transport it uses.

/** Fake ExtensionContext with a scripted model runtime (context-cap-hard-jump.test.ts shape). */
async function makeCtx(script: ScriptedStep[]): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-handoffnav-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	let step = 0;
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any) => {
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
					totalTokens: scripted.contextTokens ?? 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(20);
			if (scripted.kind === "tool") {
				output.content = [{ type: "toolCall", id: scripted.id, name: scripted.name, arguments: scripted.args }];
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
	return {
		cwd: dir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
	} as unknown as ExtensionContext;
}

test("real child: a context-cap swap shows up as exactly one handoff anchor", async () => {
	const ctx = await makeCtx([
		toolStep("t1", "ls", { path: "." }, 60),
		toolStep("h1", CONTEXT_CAP_TOOL_NAME, { markdown: "## Current Task\nNAV-HANDOFF-SENTINEL" }, 60),
		textStep("post-swap report", 2),
	]);
	let childId: string | undefined;
	try {
		const result = await runChildTool(
			{ prompt: "explore something huge", description: "nav" },
			{
				kind: "explorer",
				busyGroup: "handoff-nav-test",
				tools: ["read", "ls", CONTEXT_CAP_TOOL_NAME],
				excludeTools: [],
			},
			undefined,
			undefined,
			ctx,
		);
		childId = (result.details as { id?: string }).id;
		assert.ok(childId);
		const view = liveChildren.get(childId)!.view;
		assert.equal(view.handoffCount, 1, "one swap → one divider, whichever transport pi used");
		const lines = plain(view.render(100));
		assert.equal(view.handoffAnchors.length, 1);
		assert.match(lines[view.handoffAnchors[0]!]!, /^── ⇄ handoff 1\/1 · at 60 tokens · soft cap ─+$/);
		assert.equal(count(lines.join("\n"), "NAV-HANDOFF-SENTINEL"), 1);
	} finally {
		if (childId) {
			const sessionId = liveChildren.get(childId)?.session.sessionManager.getSessionId();
			try {
				for (const n of readdirSync(contextCapDir())) {
					if (sessionId && n.startsWith(`${sessionId}-`)) rmSync(path.join(contextCapDir(), n), { force: true });
				}
			} catch {}
		}
		for (const record of liveChildren.values()) record.session.dispose();
		liveChildren.clear();
	}
});
