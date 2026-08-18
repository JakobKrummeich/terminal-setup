/**
 * CONTEXT_CAP_TAIL_TOKENS > 0: the successor gets the last complete turns of raw
 * transcript in FRONT of the handoff, within a token budget.
 *
 * What must hold end to end:
 *  - the handoff stays the LAST thing the model reads (it is the instruction),
 *  - the kept region is pairing-safe: no tool result without its call, no call
 *    without its result — a broken pair is a provider error, i.e. worse than the
 *    empty context this lever replaces,
 *  - the budget actually cuts: an oversized older turn must be dropped,
 *  - the marker records what was kept, so an experiment can tell whether the
 *    lever fired at all.
 *
 * The unit-level cases (budget arithmetic, degenerate "keep nothing" paths) live
 * in context-cap-defaults.test.ts; this file only proves the wiring.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_TAIL_TOKENS = "2000";
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

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

const TAIL_BUDGET = 2000;
/** ~5000 estimated tokens: far over the budget, so this turn MUST be cut away. */
const HUGE_PROMPT = `OLD-PROMPT-SENTINEL ${"x".repeat(20_000)}`;
/** Small second-run prompt: the earliest safe cut boundary inside the budget. */
const SMALL_PROMPT = "NEW-TURN-SENTINEL — wrap up and hand off.";
const HANDOFF_BODY = "## Current Task\nHANDOFF-SENTINEL — finish the demo.";

interface CapturedContext {
	messages: { role: string; content?: unknown; toolCallId?: string }[];
}

function captureContexts(t: TestSession): CapturedContext[] {
	const seen: CapturedContext[] = [];
	const inner = t.session.agent.streamFunction;
	t.session.agent.streamFunction = ((model: unknown, llmContext: any, options: unknown) => {
		seen.push({ messages: llmContext?.messages ?? [] });
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

/** Provider-side pairing rules, re-checked on what actually went out. */
function pairingErrors(msgs: readonly { role: string; content?: unknown; toolCallId?: string }[]): string[] {
	const errors: string[] = [];
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of msgs) {
		if (m.role === "assistant") {
			for (const c of (Array.isArray(m.content) ? m.content : []) as { type?: string; id?: string }[]) {
				if (c.type === "toolCall" && typeof c.id === "string") calls.add(c.id);
			}
		} else if (m.role === "toolResult") {
			if (!m.toolCallId || !calls.has(m.toolCallId)) errors.push(`orphan tool result ${m.toolCallId}`);
			else results.add(m.toolCallId);
		}
	}
	for (const id of calls) if (!results.has(id)) errors.push(`dangling tool call ${id}`);
	return errors;
}

function cleanup(t: TestSession, sessionId: string) {
	try {
		for (const n of fs.readdirSync(CAP_DIR)) {
			if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
		}
	} catch {}
	t.dispose();
}

test("the swapped-in context is [recent turns …, handoff], pairing-safe and inside budget", async () => {
	const t = await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 10,
		script: [
			// Run 1 (the oversized old turn): stays below the soft cap.
			toolStep("sA", "timer", { action: "cancel" }, 2),
			textStep("old work done", 2),
			// Run 2: 10 >= soft cap 5 with stopReason toolUse -> steer requesting a handoff.
			toolStep("s1", "timer", { action: "cancel" }, 10),
			toolStep("h1", "context_handoff", { markdown: HANDOFF_BODY }, 10),
			textStep("continued after swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();
	const contexts = captureContexts(t);

	try {
		await t.session.prompt(HUGE_PROMPT);
		await t.session.prompt(SMALL_PROMPT);
		assert.equal(t.session.isIdle, true);

		const postSwap = contexts.find((c) =>
			textOf(c.messages[c.messages.length - 1] ?? {}).includes("HANDOFF-SENTINEL"),
		);
		assert.ok(postSwap, "a post-swap LLM call must have happened");

		// The handoff is last: it is the instruction the successor acts on.
		const last = postSwap.messages[postSwap.messages.length - 1];
		assert.equal(last.role, "user");
		assert.ok(textOf(last).startsWith("You are continuing work from a previous session"));

		// …and it is no longer alone: the tail carried real transcript in front of it.
		assert.ok(postSwap.messages.length > 1, "the tail lever must keep something");
		assert.deepEqual(pairingErrors(postSwap.messages), [], "the kept tail must be pairing-safe");

		// The over-budget first turn was dropped; the cut landed on a turn boundary.
		const all = postSwap.messages.map(textOf).join("\n");
		assert.ok(!all.includes("OLD-PROMPT-SENTINEL"), "the oversized older turn must not fit the budget");
		assert.equal(postSwap.messages[0].role, "user", "the tail starts at a complete turn");
		assert.ok(textOf(postSwap.messages[0]).includes("NEW-TURN-SENTINEL"), "…here, the second run's prompt");
		// Structural staleness guarantee: the steer that opened the cycle sits in
		// the kept region of the session, but its cycle is over (marker behind it)
		// — the scrub must keep it away from the model, clause or no clause.
		assert.ok(!all.includes("CONTEXT LIMIT WARNING"), "a swapped-away cycle's steer must be scrubbed from the tail");

		// Forensics: the marker says the lever fired and how much it kept.
		const marker = (t.session.messages as { role: string; customType?: string; details?: any }[]).find(
			(m) => m.role === "custom" && m.customType === "context-cap-swap",
		);
		assert.ok(marker, "swap marker must exist");
		assert.equal(marker.details?.tailTokens, TAIL_BUDGET);
		assert.ok(marker.details?.tailKeptTokens > 0, "a fired tail must be counted");
		assert.ok(
			marker.details?.tailKeptTokens <= TAIL_BUDGET,
			`kept ${marker.details?.tailKeptTokens} tokens > budget ${TAIL_BUDGET}`,
		);
		assert.equal(marker.details?.trigger, "soft", "existing fields survive");

		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1);
		const doc = fs.readFileSync(path.join(CAP_DIR, files[0]), "utf8");
		assert.ok(doc.includes(`\ntailTokens: ${TAIL_BUDGET}\n`), `frontmatter must record the lever:\n${doc}`);
		assert.match(doc, /\ntailKeptTokens: [1-9][0-9]*\n/);
		// Frontmatter is host-written and never sent to the model.
		assert.ok(!all.includes("tailKeptTokens"), "frontmatter must not reach the model");
	} finally {
		cleanup(t, sessionId);
	}
});
