/**
 * CONTEXT_CAP_SCHEMA=v2 (the default): one lever, three consumers. The schema is
 * chosen once in lib/env.ts and must reach ALL of
 *   1. the `context_handoff` tool's `markdown` parameter description,
 *   2. the agent-facing instructions (CONTENT_SPEC, carried by every cap message),
 *   3. the machine writer's user prompt (lib/handoff-writer.ts),
 * with no second copy that could drift. This test reads consumers 1 and 2 out of
 * the real LLM context and consumer 3 out of the real writer call.
 *
 * Rationale for v2 (forensics over 72 real swaps): successors kept re-reading
 * files the handoff never named — path recall 0.17, a "key file paths" section
 * present in 19/72 documents — so v2 makes "## Files" mandatory and exhaustive.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SCHEMA = "v2";
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";
delete process.env.CONTEXT_CAP_TAIL_TOKENS;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestSession, textStep, toolStep, type TestSession } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

// See context-cap-schema-v1.test.ts: static imports are hoisted above the env
// assignments above, so the writer lib must be loaded dynamically.
const writer = () => import("../lib/handoff-writer.ts");

const MACHINE_DRAFT = "## Current Task\nMACHINE-DRAFT-SENTINEL";
/** Load-bearing fragments of the v2 schema, spelled out rather than derived. */
const V2_FILES_LINE = '3. "## Files" — EVERY path you touched or read this session that still matters';
const V2_NEXT_STEP_LINE = '4. "## Next Step" — the exact next action as a runnable command or a precise edit';

interface CapturedContext {
	messages: { role: string; content?: unknown }[];
	tools: unknown[];
}

function captureContexts(t: TestSession): CapturedContext[] {
	const seen: CapturedContext[] = [];
	const inner = t.session.agent.streamFunction;
	t.session.agent.streamFunction = ((model: unknown, llmContext: any, options: unknown) => {
		seen.push({ messages: llmContext?.messages ?? [], tools: llmContext?.tools ?? [] });
		return inner(model, llmContext, options);
	}) as any;
	return seen;
}

function cleanup(t: TestSession, sessionId: string) {
	try {
		for (const n of fs.readdirSync(CAP_DIR)) {
			if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
		}
	} catch {}
	t.dispose();
}

test("v2: sections and line budget come from the lever, not from a copy", async () => {
	const { handoffSections, handoffLineBudget, HANDOFF_SECTIONS_V2 } = await writer();
	assert.equal(handoffSections(), HANDOFF_SECTIONS_V2);
	assert.equal(handoffLineBudget(), 60);
	assert.ok(HANDOFF_SECTIONS_V2.includes(V2_FILES_LINE));
});

test("v2 reaches the tool spec, the agent instructions and the machine writer", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 10,
		script: [
			// 60 tokens crosses BOTH caps in one jump -> emergency steer (CONTENT_SPEC).
			toolStep("t1", "timer", { action: "cancel" }, 60),
			// Ignored -> grace turn.
			toolStep("t2", "timer", { action: "cancel" }, 60),
			// Ignored again -> hard-cap backstop -> the machine writer runs.
			toolStep("t3", "timer", { action: "cancel" }, 60),
			textStep("post-swap answer", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();
	const contexts = captureContexts(t);
	const writerPrompts: string[] = [];
	t.modelRuntime.complete = async (_model: unknown, context: any) => {
		writerPrompts.push(String(context?.messages?.[0]?.content?.[0]?.text ?? ""));
		return {
			role: "assistant",
			content: [{ type: "text", text: MACHINE_DRAFT }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "writer-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	};

	try {
		await t.session.prompt("start");
		assert.equal(t.session.isIdle, true);

		// Consumer 1: the tool spec the model reads.
		const toolSpec = JSON.stringify(contexts[0].tools);
		assert.ok(toolSpec.includes("~60 lines."), `tool parameter description must carry the v2 budget: ${toolSpec.slice(0, 400)}`);

		// Consumer 2: the agent-facing instructions.
		const steer = t.deliveredUserMessages.map((m) => m.text).find((text) => text.includes("CONTEXT LIMIT"));
		assert.ok(steer, "the hard cap must steer");
		assert.ok(steer.includes("~60 lines total"), "instructions must quote the v2 line budget");
		assert.ok(steer.includes(V2_FILES_LINE), `instructions must carry the v2 Files section:\n${steer}`);
		assert.ok(steer.includes(V2_NEXT_STEP_LINE), "instructions must carry the v2 Next Step section");

		// Consumer 3: the machine writer's prompt.
		assert.equal(writerPrompts.length, 1, "exactly one writer call");
		assert.ok(writerPrompts[0].includes(V2_FILES_LINE), "the writer is asked for the same schema");
		assert.ok(writerPrompts[0].includes("~60 lines total"), "including its line budget");

		// Instrumentation: marker details and frontmatter.
		const marker = (t.session.messages as { role: string; customType?: string; details?: any }[]).find(
			(m) => m.role === "custom" && m.customType === "context-cap-swap",
		);
		assert.ok(marker, "the backstop must swap");
		assert.equal(marker.details?.schema, "v2");
		assert.equal(marker.details?.tailTokens, 0);
		assert.equal(marker.details?.tailKeptTokens, 0);
		assert.equal(marker.details?.author, "machine", "existing fields survive");
		assert.equal(marker.details?.trigger, "hard");

		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1);
		const doc = fs.readFileSync(path.join(CAP_DIR, files[0]), "utf8");
		assert.ok(doc.includes("\nauthor: machine\n"), `existing frontmatter survives:\n${doc}`);
		assert.ok(doc.includes("\nschema: v2\n"));
		assert.ok(doc.includes("\ntailTokens: 0\n"));
		assert.ok(doc.includes("\ntailKeptTokens: 0\n"));
	} finally {
		cleanup(t, sessionId);
	}
});
