/**
 * CONTEXT_CAP_SCHEMA=v1 with no recency tail = the pre-lever extension. This
 * file is the control arm of the A/B: every string the MODEL can see is pinned
 * to a golden literal copied from the pre-lever code, and the post-swap context
 * is asserted to be the handoff and nothing else.
 *
 * The goldens are written out by hand on purpose — deriving them from
 * HANDOFF_SECTIONS_V1 would make the test pass no matter how the text drifts.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SCHEMA = "v1";
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

// lib/handoff-writer.ts resolves the schema at module load, and ESM hoists every
// static import above the assignments at the top of this file — so it must be
// imported dynamically, after CONTEXT_CAP_SCHEMA is set. (The extension itself is
// fine: the session loads it through jiti, later still.)
const writer = () => import("../lib/handoff-writer.ts");

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

// --- goldens (pre-lever text, byte for byte) --------------------------------

const V1_SECTIONS = `1. "## Current Task" — FIRST section: what you are working on right now and the overall goal. The next session sees ONLY this text; nobody will restate the task.
2. A brief summary of this session and current status
3. Key file paths that were worked on
4. Information you found surprising or where you struggled
5. What the next session needs to know to continue`;

const V1_CONTENT_SPEC = `Call the \`context_handoff\` tool. Its \`markdown\` argument (plain markdown, NO YAML frontmatter, ~30 lines total):
${V1_SECTIONS}

After the tool returns, end your turn. Your context will then be replaced by this handoff.`;

const V1_TOOL_PARAM_DESCRIPTION =
	"Handoff body, plain markdown, no YAML frontmatter. First section must be '## Current Task'. ~30 lines.";

const V1_WRITER_PROMPT = `The conversation below is the session being handed off, serialized (roles in brackets, tool results truncated).

<conversation>
CONVERSATION-SENTINEL
</conversation>

Write the handoff document now (plain markdown, NO YAML frontmatter, ~30 lines total):
${V1_SECTIONS}

Output the document only.`;

const HANDOFF_BODY = "## Current Task\nFinish the demo.";
const SWAPPED_IN_TEXT = `You are continuing work from a previous session. The agent before you left you this information:

${HANDOFF_BODY}

Continue your work.`;

// --- helpers ----------------------------------------------------------------

interface CapturedContext {
	messages: { role: string; content?: unknown }[];
	tools: unknown[];
}

/** Record the exact llmContext handed to the provider (post `context` handler). */
function captureContexts(t: TestSession): CapturedContext[] {
	const seen: CapturedContext[] = [];
	const inner = t.session.agent.streamFunction;
	t.session.agent.streamFunction = ((model: unknown, llmContext: any, options: unknown) => {
		seen.push({ messages: llmContext?.messages ?? [], tools: llmContext?.tools ?? [] });
		return inner(model, llmContext, options);
	}) as any;
	return seen;
}

function textOf(message: { content?: unknown }): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((part: { type?: string }) => part?.type === "text")
		.map((part: { text?: string }) => part.text ?? "")
		.join("\n");
}

function cleanup(t: TestSession, sessionId: string) {
	try {
		for (const n of fs.readdirSync(CAP_DIR)) {
			if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
		}
	} catch {}
	t.dispose();
}

// --- tests ------------------------------------------------------------------

test("v1: the schema lever picks the frozen section list and its 30-line budget", async () => {
	const { handoffSections, handoffLineBudget } = await writer();
	assert.equal(handoffSections(), V1_SECTIONS);
	assert.equal(handoffLineBudget(), 30);
});

test("v1: the machine writer's prompt is byte-identical to the pre-lever one", async () => {
	const { handoffUserPrompt } = await writer();
	assert.equal(handoffUserPrompt("CONVERSATION-SENTINEL"), V1_WRITER_PROMPT);
});

test("v1 + no tail: agent instructions, tool spec and post-swap context are unchanged", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 10,
		script: [
			toolStep("s1", "timer", { action: "cancel" }, 10),
			toolStep("h1", "context_handoff", { markdown: HANDOFF_BODY }, 10),
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();
	const contexts = captureContexts(t);

	try {
		await t.session.prompt("start");
		assert.equal(t.session.isIdle, true);

		// Consumer 1: the tool spec the model reads (parameter description).
		const toolSpec = JSON.stringify(contexts[0].tools);
		assert.ok(
			toolSpec.includes(JSON.stringify(V1_TOOL_PARAM_DESCRIPTION).slice(1, -1)),
			`the context_handoff parameter description must be the v1 golden, got: ${toolSpec.slice(0, 400)}`,
		);

		// Consumer 2: the agent-facing instructions (CONTENT_SPEC inside the steer).
		const steer = t.deliveredUserMessages.map((m) => m.text).find((text) => text.includes("CONTEXT LIMIT WARNING"));
		assert.ok(steer, "the soft cap must steer");
		assert.ok(steer.includes(V1_CONTENT_SPEC), `steer must carry the v1 spec verbatim, got:\n${steer}`);
		assert.ok(steer.includes("soft cap 5, hard cap 50"), "trigger numbers still come from the env overrides");

		// The swap itself: the model sees the handoff and NOTHING else.
		const postSwap = contexts.find((c) => textOf(c.messages[c.messages.length - 1]).includes(SWAPPED_IN_TEXT));
		assert.ok(postSwap, "a post-swap LLM call must have happened");
		assert.equal(postSwap.messages.length, 1, "no tail: the handoff is the entire context");
		assert.equal(postSwap.messages[0].role, "user");
		assert.equal(textOf(postSwap.messages[0]), SWAPPED_IN_TEXT, "swapped-in text is byte-identical");

		// New forensic fields only — the swap decision itself is unchanged.
		const marker = (t.session.messages as { role: string; customType?: string; details?: any }[]).find(
			(m) => m.role === "custom" && m.customType === "context-cap-swap",
		);
		assert.ok(marker, "swap marker must exist");
		assert.equal(marker.details?.trigger, "soft");
		assert.equal(marker.details?.schema, "v1");
		assert.equal(marker.details?.tailTokens, 0);
		assert.equal(marker.details?.tailKeptTokens, 0);

		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1);
		const doc = fs.readFileSync(path.join(CAP_DIR, files[0]), "utf8");
		assert.ok(doc.includes("\nschema: v1\n"), `frontmatter must record the schema, got:\n${doc}`);
		assert.ok(doc.includes("\ntailTokens: 0\n"));
		assert.ok(doc.includes("\ntailKeptTokens: 0\n"));
		// Frontmatter is host-written and must never reach the model.
		assert.ok(!textOf(postSwap.messages[0]).includes("schema:"), "frontmatter must be stripped before injection");
		assert.ok(!textOf(postSwap.messages[0]).includes("tailKeptTokens"));
	} finally {
		cleanup(t, sessionId);
	}
});
