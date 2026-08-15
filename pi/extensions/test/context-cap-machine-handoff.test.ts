/**
 * Machine-written handoffs: lib/handoff-writer.ts plus its two callers in
 * context-cap.ts.
 *
 * Why this exists (17-run study, ~/context-cap-study/results/postmortem.md): at
 * the hard cap the extension swapped in whatever file happened to be on disk —
 * one run re-injected a 6-minute-stale doc whose "gates are green" claim was
 * already false — or, with no file at all, a "your context is gone, ask the
 * user" note, which in an unattended `pi -p` run means nobody answers. The hard
 * cap is 200k of a ~1M window, so there is room for ONE more LLM call.
 *
 * The load-bearing property is negative: the writer must never make things
 * worse. Every failure mode (no model, provider error, rejection, timeout,
 * abort, empty text) must leave both callers doing exactly what they did
 * before — hard-cap swap with the stale/no-file fallback, and pi's own
 * summarizer for compaction.
 */

// Must be set before createTestSession loads the extension (env is read at module load).
process.env.CONTEXT_CAP_SOFT = "5";
process.env.CONTEXT_CAP_HARD = "50";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
	draftHandoff,
	HANDOFF_SECTIONS,
	HANDOFF_SYSTEM_PROMPT,
	type HandoffCompleter,
	type HandoffMessage,
} from "../lib/handoff-writer.ts";
import { createTestSession, textStep, toolStep, type TestSession } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTEXT_CAP_EXTENSION = path.join(EXT_DIR, "context-cap.ts");
const TIMER_EXTENSION = path.join(EXT_DIR, "timer.ts");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");
const COMPACT_FLAG = "CONTEXT_CAP_COMPACT_HANDOFF";

const MACHINE_DRAFT = "## Current Task\nMACHINE-DRAFT-SENTINEL — finish the refactor in lib/foo.ts.";
const COMPACT_DRAFT = "## Current Task\nCOMPACT-DRAFT-SENTINEL — keep going.";

// ---------------------------------------------------------------------------
// Writer unit tests (no session: the writer is a pure-ish function over a registry)
// ---------------------------------------------------------------------------

const MODEL = { id: "writer-model", provider: "test" } as unknown as Model<any>;

const MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "USER-TURN-SENTINEL" }], timestamp: 1 },
] as unknown as HandoffMessage[];

interface RecordedCall {
	context: { systemPrompt?: string; messages: { content: { type: string; text: string }[] }[] };
	options: { maxTokens?: number; cacheRetention?: string; sessionId?: string; signal?: AbortSignal };
}

/** A `Pick<ModelRegistry, "complete">` stub that records what the writer sent. */
function completer(impl: (call: RecordedCall) => Promise<unknown>, calls: RecordedCall[] = []): HandoffCompleter {
	return {
		complete: (async (_model: unknown, context: unknown, options: unknown) => {
			const call = { context, options } as RecordedCall;
			calls.push(call);
			return await impl(call);
		}) as unknown as HandoffCompleter["complete"],
	};
}

function assistantResponse(text: string, overrides: Record<string, unknown> = {}): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "writer-model",
		usage: {
			input: 11,
			output: 22,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

test("draftHandoff: success returns the markdown, the shared spec and the standalone-call options", async () => {
	const calls: RecordedCall[] = [];
	const draft = await draftHandoff({
		modelRegistry: completer(async () => assistantResponse(`  ${MACHINE_DRAFT}  `), calls),
		model: MODEL,
		messages: MESSAGES,
	});

	assert.ok(draft, "a draft must be returned");
	assert.equal(draft.text, MACHINE_DRAFT, "text is trimmed");
	assert.equal(draft.usage?.output, 22, "usage is forwarded (pi stores it in session totals)");

	assert.equal(calls.length, 1, "exactly one LLM call");
	assert.equal(calls[0].context.systemPrompt, HANDOFF_SYSTEM_PROMPT);
	const sent = calls[0].context.messages[0].content[0].text;
	assert.ok(sent.includes(HANDOFF_SECTIONS), "the agent-facing section list is reused verbatim");
	assert.ok(sent.includes("USER-TURN-SENTINEL"), "history is serialized into the prompt");
	assert.ok(sent.includes("[User]:"), "history goes through serializeConversation, not raw messages");
	assert.equal(calls[0].options.cacheRetention, "none", "standalone call must not touch the prompt cache");
	assert.ok(calls[0].options.sessionId, "standalone call uses a fresh routing session id");
	assert.ok((calls[0].options.maxTokens ?? 0) > 0, "the call is token-bounded");
	assert.ok(calls[0].options.signal, "the call is abortable");
});

test("draftHandoff: previousSummary and extraInstructions reach the prompt", async () => {
	const calls: RecordedCall[] = [];
	await draftHandoff({
		modelRegistry: completer(async () => assistantResponse(MACHINE_DRAFT), calls),
		model: MODEL,
		messages: MESSAGES,
		previousSummary: "PREVIOUS-SUMMARY-SENTINEL",
		extraInstructions: "EXTRA-INSTRUCTION-SENTINEL",
	});
	const sent = calls[0].context.messages[0].content[0].text;
	assert.ok(sent.includes("PREVIOUS-SUMMARY-SENTINEL"));
	assert.ok(sent.includes("EXTRA-INSTRUCTION-SENTINEL"));
});

test("draftHandoff: stopReason 'error' is a failure even though the promise resolves", async () => {
	const draft = await draftHandoff({
		modelRegistry: completer(async () =>
			assistantResponse("", { stopReason: "error", errorMessage: "overloaded", content: [] }),
		),
		model: MODEL,
		messages: MESSAGES,
	});
	assert.equal(draft, null);
});

test("draftHandoff: a rejected completion promise returns null instead of throwing", async () => {
	const draft = await draftHandoff({
		modelRegistry: completer(async () => {
			throw new Error("ECONNRESET");
		}),
		model: MODEL,
		messages: MESSAGES,
	});
	assert.equal(draft, null);
});

test("draftHandoff: a call that outlives its timeout is aborted and returns null", async () => {
	const started = Date.now();
	let sawAbort = false;
	const draft = await draftHandoff({
		modelRegistry: completer(
			(call) =>
				new Promise((resolve) => {
					call.options.signal?.addEventListener("abort", () => {
						sawAbort = true;
						resolve(assistantResponse("too late", { stopReason: "aborted" }));
					});
				}),
		),
		model: MODEL,
		messages: MESSAGES,
		timeoutMs: 20,
	});
	assert.equal(draft, null);
	assert.equal(sawAbort, true, "the writer's own AbortController fires on timeout");
	assert.ok(Date.now() - started < 5000, "the caller is not blocked past the timeout");
});

test("draftHandoff: an already-aborted caller signal makes no call at all", async () => {
	const calls: RecordedCall[] = [];
	const controller = new AbortController();
	controller.abort();
	const draft = await draftHandoff({
		modelRegistry: completer(async () => assistantResponse(MACHINE_DRAFT), calls),
		model: MODEL,
		messages: MESSAGES,
		signal: controller.signal,
	});
	assert.equal(draft, null);
	assert.equal(calls.length, 0);
});

test("draftHandoff: no model, no registry, no messages, empty text — all null, no call", async () => {
	const calls: RecordedCall[] = [];
	const registry = completer(async () => assistantResponse(MACHINE_DRAFT), calls);

	assert.equal(await draftHandoff({ modelRegistry: registry, model: undefined, messages: MESSAGES }), null);
	assert.equal(await draftHandoff({ modelRegistry: undefined, model: MODEL, messages: MESSAGES }), null);
	assert.equal(await draftHandoff({ modelRegistry: registry, model: MODEL, messages: [] }), null);
	assert.equal(calls.length, 0, "none of these may reach the provider");

	const empty = await draftHandoff({
		modelRegistry: completer(async () => assistantResponse("   \n  ")),
		model: MODEL,
		messages: MESSAGES,
	});
	assert.equal(empty, null, "an empty completion is a failure, not a handoff");
});

// ---------------------------------------------------------------------------
// Caller 1: our hard cap
// ---------------------------------------------------------------------------

interface SwapMarker {
	role: string;
	customType?: string;
	content?: unknown;
	details?: { trigger?: string; handoffPath?: string | null; stale?: boolean; author?: string | null };
}

function swapMarkers(t: TestSession): SwapMarker[] {
	return (t.session.messages as SwapMarker[]).filter(
		(m) => m.role === "custom" && m.customType === "context-cap-swap",
	);
}

function capFiles(sessionId: string): string[] {
	try {
		return fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
	} catch {
		return [];
	}
}

function cleanup(t: TestSession, sessionId: string) {
	for (const n of capFiles(sessionId)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
	t.dispose();
}

/**
 * Drives a session past the hard cap with no agent handoff ever written:
 * one-jump crossing (emergency steer) → ignored (grace turn) → ignored again,
 * which is where the backstop fires.
 */
async function hardCapSession(): Promise<TestSession> {
	return await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION, TIMER_EXTENSION],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 10,
		script: [
			toolStep("t1", "timer", { action: "cancel" }, 60),
			toolStep("t2", "timer", { action: "cancel" }, 60),
			toolStep("t3", "timer", { action: "cancel" }, 60),
			textStep("post-swap answer", 2),
		],
	});
}

test("hard cap without a fresh handoff: one LLM call writes the handoff that is swapped in", async () => {
	const t = await hardCapSession();
	const sessionId = t.session.sessionManager.getSessionId();
	const calls: RecordedCall[] = [];
	t.modelRuntime.complete = async (_model: unknown, context: unknown, options: unknown) => {
		calls.push({ context, options } as RecordedCall);
		return assistantResponse(MACHINE_DRAFT);
	};

	try {
		await t.session.prompt("start");
		assert.equal(t.session.isIdle, true);
		assert.equal(calls.length, 1, "exactly one writer call — not one per message_end");

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1, "one swap");
		assert.equal(markers[0].details?.trigger, "hard");
		assert.equal(markers[0].details?.author, "machine", "forensics must distinguish machine from agent");
		assert.equal(markers[0].details?.stale, false, "a freshly written handoff is not stale");
		const content = String(markers[0].content);
		assert.ok(content.includes("MACHINE-DRAFT-SENTINEL"), "the drafted handoff is what gets injected");
		assert.ok(content.includes("reconstructed automatically"), "the next session is told it is second-hand");
		assert.ok(!content.includes("Ask the user for direction"), "the no-context fallback must not appear");

		const files = capFiles(sessionId);
		assert.equal(files.length, 1, "written through the normal <sessionId>-<seq>.md path");
		const doc = fs.readFileSync(path.join(CAP_DIR, files[0]), "utf8");
		assert.ok(doc.includes("author: machine"), `frontmatter must record the author, got: ${doc.slice(0, 200)}`);
		assert.ok(doc.includes("MACHINE-DRAFT-SENTINEL"));
	} finally {
		cleanup(t, sessionId);
	}
});

test("a failing writer leaves the hard cap doing exactly what it did before (no file)", async () => {
	const t = await hardCapSession();
	const sessionId = t.session.sessionManager.getSessionId();
	let attempts = 0;
	t.modelRuntime.complete = async () => {
		attempts++;
		throw new Error("provider down");
	};

	try {
		await t.session.prompt("start");
		assert.equal(t.session.isIdle, true);
		assert.equal(attempts, 1, "the writer was tried");

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1, "the swap still happens — the backstop must not depend on the writer");
		assert.equal(markers[0].details?.trigger, "hard-no-file", "today's trigger, unchanged");
		assert.equal(markers[0].details?.author, null, "no document ⇒ no author");
		assert.equal(markers[0].details?.handoffPath, null);
		assert.ok(String(markers[0].content).includes("Ask the user for direction"), "today's fallback text");
		assert.equal(capFiles(sessionId).length, 0, "a failed draft must not leave a file behind");
	} finally {
		cleanup(t, sessionId);
	}
});

test("a failing writer still falls back to the stale file, staleness noted, as before", async () => {
	const t = await hardCapSession();
	const sessionId = t.session.sessionManager.getSessionId();
	fs.mkdirSync(CAP_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(CAP_DIR, `${sessionId}-1.md`),
		`---\nsessionId: ${sessionId}\nseq: 1\nauthor: agent\n---\n\n## Current Task\nSTALE-DOC-SENTINEL\n`,
	);
	t.modelRuntime.complete = async () => assistantResponse("", { stopReason: "error", errorMessage: "nope", content: [] });

	try {
		await t.session.prompt("start");

		const markers = swapMarkers(t);
		assert.equal(markers.length, 1);
		assert.equal(markers[0].details?.trigger, "hard");
		assert.equal(markers[0].details?.stale, true, "the substituted older file is still flagged stale");
		assert.equal(markers[0].details?.author, "agent");
		const content = String(markers[0].content);
		assert.ok(content.includes("STALE-DOC-SENTINEL"));
		assert.ok(content.includes("may not reflect the very latest work"), "today's stale note");
		assert.equal(capFiles(sessionId).length, 1, "no new file was written");
	} finally {
		cleanup(t, sessionId);
	}
});

test("ESC during the writer call defers the swap instead of wiping the context", async () => {
	const t = await hardCapSession();
	const sessionId = t.session.sessionManager.getSessionId();
	let attempts = 0;
	t.modelRuntime.complete = async () => {
		attempts++;
		// The user hits ESC while the handoff is being written — a window that only
		// exists because message_end now awaits an LLM call. abort() is synchronous
		// on the agent's controller, so ctx.signal is aborted by the time we throw.
		void t.session.abort();
		throw new Error("aborted");
	};

	try {
		await t.session.prompt("start");
		assert.equal(t.session.isIdle, true);
		assert.equal(attempts, 1, "the writer was tried");

		assert.equal(swapMarkers(t).length, 0, "an aborted write must not trigger the no-file backstop wipe");
		assert.equal(capFiles(sessionId).length, 0, "nothing written");
	} finally {
		cleanup(t, sessionId);
	}
});

// ---------------------------------------------------------------------------
// Caller 2: pi's own compaction
// ---------------------------------------------------------------------------

interface CompactionEntryish {
	type: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	fromHook?: boolean;
	details?: { author?: string; writer?: string; reason?: string };
}

function compactionEntries(t: TestSession): CompactionEntryish[] {
	return (t.session.sessionManager.getEntries() as CompactionEntryish[]).filter((e) => e.type === "compaction");
}

/** A session with pi's own compaction enabled and a cut point that always exists. */
async function compactableSession(): Promise<TestSession> {
	return await createTestSession({
		extensionPaths: [CONTEXT_CAP_EXTENSION],
		tools: [],
		llmDelayMs: 5,
		compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 },
		script: [textStep("first answer", 2), textStep("second answer", 2), textStep("PI-OWN-SUMMARY-SENTINEL", 2)],
	});
}

test("pi's own compaction is answered with a handoff-shaped summary", async () => {
	const t = await compactableSession();
	const sessionId = t.session.sessionManager.getSessionId();
	const calls: RecordedCall[] = [];
	t.modelRuntime.complete = async (_model: unknown, context: unknown, options: unknown) => {
		calls.push({ context, options } as RecordedCall);
		return assistantResponse(COMPACT_DRAFT);
	};

	try {
		await t.session.prompt("do work");
		await t.session.prompt("more work");
		await t.session.compact();

		assert.equal(calls.length, 1, "the handoff writer ran once");
		const entries = compactionEntries(t);
		assert.equal(entries.length, 1, "one compaction entry");
		assert.ok(entries[0].summary.includes("COMPACT-DRAFT-SENTINEL"), "our summary won");
		assert.ok(
			entries[0].summary.includes("most recent messages follow it unchanged"),
			"pi keeps recent messages — the preamble must say so",
		);
		assert.ok(!entries[0].summary.includes("PI-OWN-SUMMARY-SENTINEL"), "pi's own summarizer must not have run");
		assert.equal(entries[0].fromHook, true);
		assert.equal(entries[0].details?.author, "machine");
		assert.equal(entries[0].details?.reason, "manual");

		// firstKeptEntryId / tokensBefore are echoed verbatim: pi forwards them to
		// appendCompaction unvalidated, and a wrong id desyncs the session on reload.
		const ids = new Set((t.session.sessionManager.getBranch() as { id: string }[]).map((e) => e.id));
		assert.ok(ids.has(entries[0].firstKeptEntryId), "firstKeptEntryId must be a real entry on the branch");
		assert.ok(entries[0].tokensBefore > 0, "tokensBefore must be echoed, not invented");
	} finally {
		cleanup(t, sessionId);
	}
});

test("a failing handoff writer lets pi's own compaction proceed", async () => {
	const t = await compactableSession();
	const sessionId = t.session.sessionManager.getSessionId();
	let attempts = 0;
	t.modelRuntime.complete = async () => {
		attempts++;
		throw new Error("provider down");
	};

	try {
		await t.session.prompt("do work");
		await t.session.prompt("more work");
		await t.session.compact();

		assert.equal(attempts, 1, "the writer was tried");
		const entries = compactionEntries(t);
		assert.equal(entries.length, 1, "compaction still happened");
		assert.ok(
			entries[0].summary.includes("PI-OWN-SUMMARY-SENTINEL"),
			`pi's own summarizer must have produced the summary, got: ${entries[0].summary.slice(0, 200)}`,
		);
		assert.notEqual(entries[0].fromHook, true, "the entry must not claim an extension summary");
	} finally {
		cleanup(t, sessionId);
	}
});

test(`${COMPACT_FLAG}=0 disables the compaction hook without touching the hard cap`, async () => {
	const t = await compactableSession();
	const sessionId = t.session.sessionManager.getSessionId();
	let attempts = 0;
	t.modelRuntime.complete = async () => {
		attempts++;
		return assistantResponse(COMPACT_DRAFT);
	};

	const previous = process.env[COMPACT_FLAG];
	process.env[COMPACT_FLAG] = "0";
	try {
		await t.session.prompt("do work");
		await t.session.prompt("more work");
		await t.session.compact();

		assert.equal(attempts, 0, "the flag is read at call time — no writer call at all");
		const entries = compactionEntries(t);
		assert.equal(entries.length, 1);
		assert.ok(entries[0].summary.includes("PI-OWN-SUMMARY-SENTINEL"), "pi's own compaction ran");
	} finally {
		if (previous === undefined) delete process.env[COMPACT_FLAG];
		else process.env[COMPACT_FLAG] = previous;
		cleanup(t, sessionId);
	}
});
