/**
 * /handoff and the token caps are ONE handoff cycle (lib/context-cap-manual.ts).
 * Regression tests for the races two independent machines produced, run in a
 * real pi session with a scripted LLM:
 *  A  the /handoff reply itself crossed the soft cap → the cap demanded a second
 *     handoff, swapped, said "Continue your work.", and the reply harvest seeded
 *     the new session with the post-swap chatter;
 *  B  /handoff typed while a cap demand was in flight → the swap won and the
 *     /handoff prompt was answered from the scrubbed window (summary of a summary);
 *  D3 every demand travelled through pi's steer/followUp queues (ESC restored
 *     them into the editor) — now no queue is ever used;
 *  D4 an aborted /handoff stranded the command ("already in progress" forever);
 *  D5 a demand queued at message_end landed in the fresh post-swap window;
 *  D6 a context_handoff call in the very message that crossed the cap was taken
 *     although the model had never seen a demand.
 * The texts per origin (D7) are pinned in handoff.test.ts.
 */

process.env.CONTEXT_CAP_SOFT = "100";
process.env.CONTEXT_CAP_HARD = "1000";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contextCapDir } from "../lib/agent-dir.ts";
import { HANDOFF_PREAMBLE, HANDOFF_SUMMARY_TYPE, SWAP_MARKER_TYPE } from "../lib/message-types.ts";
import {
	abortedStep,
	batchStep,
	createTestSession,
	errorStep,
	type ScriptedStep,
	sleep,
	type TestSession,
	type TestSessionOptions,
	textStep,
	toolStep,
} from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LONG_DOC = "## Current Task\nthe long, real handoff document";
/**
 * customType of demand/reminder entries. Spelled out (pinned against
 * lib/message-types.ts DEMAND_TYPE in handoff.test.ts) so this file
 * also runs against the code from before the fix, where it must fail.
 */
const DEMAND_TYPE = "handoff-demand";

function session(
	script: ScriptedStep[],
	onLlmCall?: (call: number) => void,
	extra: Partial<TestSessionOptions> = {},
): Promise<TestSession> {
	let calls = 0;
	return createTestSession({
		extensionPaths: ["context-cap.ts", "builtin-tools.ts"].map((f) => path.join(EXT_DIR, f)),
		tools: ["context_handoff", "ls"],
		commands: true,
		llmDelayMs: 20,
		script,
		onLlmCall: () => onLlmCall?.(++calls),
		...extra,
	});
}

function branch(t: TestSession): any[] {
	return t.session.sessionManager.getBranch();
}

function customEntries(t: TestSession, customType: string): any[] {
	return branch(t).filter((e) => e.type === "custom_message" && e.customType === customType);
}

function toolResultTexts(t: TestSession): string[] {
	return branch(t)
		.filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "context_handoff")
		.map((e) => e.message.content.map((c: any) => c.text).join(""));
}

/** D3: nothing — demand, reminder or /handoff — ever went through pi's queues. */
function assertNothingQueued(t: TestSession): void {
	for (const q of t.queueSnapshots) {
		assert.deepEqual([q.steering, q.followUp], [[], []], "no steer/followUp may ever be queued");
	}
}

/** The successor seed: preamble + exactly the tool-recorded document, user stays in charge. */
function assertSeeded(t: TestSession, doc: string): void {
	assert.deepEqual(t.seeds, [
		{ customType: HANDOFF_SUMMARY_TYPE, content: `${HANDOFF_PREAMBLE}\n\n${doc}`, display: true, triggerTurn: false },
	]);
}

test("A: the /handoff document crossing the soft cap ends the manual cycle — no cap demand, no swap", async () => {
	const t = await session([
		textStep("did some work", 90),
		// The model answers the /handoff demand in prose first — above the soft cap.
		textStep("Here is my summary …", 110),
		toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 112),
		textStep("must never run: the window is being left", 113),
	]);
	try {
		await t.session.prompt("start");
		await t.session.prompt("/handoff");
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		const demands = customEntries(t, DEMAND_TYPE);
		assert.deepEqual(
			demands.map((d) => [d.details.origin, d.details.kind]),
			[
				["manual", "demand"],
				["manual", "reminder"],
			],
			"one manual demand, then a manual reminder — never a cap silent-stop demand",
		);
		assert.match(demands[0].content, /^Write the handoff document your successor session starts from\./, "the /handoff wording");
		for (const d of demands) assert.ok(!d.content.includes("[context-cap]"), "no cap wording in a manual cycle");
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), [], "a manual cycle never swaps");
		assert.match(toolResultTexts(t)[0]!, /a new session starts from it/);
		const last = branch(t).at(-1);
		assert.equal(last.message?.role, "toolResult", "the tool terminates the run — no turn after the handoff");
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("B: /handoff typed while a cap demand is out joins that cycle — one demand, the real doc, no swap", async () => {
	let handoff: Promise<unknown> | undefined;
	const t: TestSession = await session(
		[
			toolStep("w1", "ls", {}, 50),
			toolStep("w2", "ls", {}, 105), // crosses soft → demand committed at this turn_end
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 108),
			textStep("must never run", 6),
		],
		(call) => {
			// Third request: the cap demand is already in the agent's context.
			if (call === 3) handoff = t.session.prompt("/handoff");
		},
	);
	try {
		await t.session.prompt("start");
		await handoff;
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		const demands = customEntries(t, DEMAND_TYPE);
		assert.deepEqual(
			demands.map((d) => [d.details.origin, d.details.kind]),
			[["soft", "demand"]],
			"no second demand",
		);
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), [], "the ending switched to a new session: no swap");
		assert.ok(
			!branch(t).some((e) => JSON.stringify(e).includes("Continue your work.")),
			"no auto-continue anywhere",
		);
		assert.match(toolResultTexts(t)[0]!, /a new session starts from it/, "tool result follows the manual row");
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("B': /handoff typed mid-run, then the run crosses the soft cap → the manual demand moves forward, sent once", async () => {
	let handoff: Promise<unknown> | undefined;
	const t: TestSession = await session(
		[
			toolStep("w1", "ls", {}, 50),
			toolStep("w2", "ls", {}, 105), // crossing: the waiting /handoff demand goes out at this turn_end
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 108),
			textStep("must never run", 6),
		],
		(call) => {
			if (call === 1) handoff = t.session.prompt("/handoff");
		},
	);
	try {
		await t.session.prompt("start");
		await handoff;
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		const demands = customEntries(t, DEMAND_TYPE);
		assert.deepEqual(demands.map((d) => [d.details.origin, d.details.kind]), [["manual", "demand"]]);
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), []);
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("/handoff typed mid-run below the caps waits for the run to settle, then demands", async () => {
	let handoff: Promise<unknown> | undefined;
	const t: TestSession = await session(
		[
			toolStep("w1", "ls", {}, 20),
			textStep("work done", 30),
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 40),
		],
		(call) => {
			if (call === 1) handoff = t.session.prompt("/handoff");
		},
	);
	try {
		await t.session.prompt("start");
		await handoff;
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		const entries = branch(t);
		const demandAt = entries.findIndex((e) => e.type === "custom_message" && e.customType === DEMAND_TYPE);
		const workDone = entries.findIndex((e) => e.type === "message" && JSON.stringify(e.message.content).includes("work done"));
		assert.ok(workDone >= 0 && demandAt > workDone, "the demand follows the run's own final answer");
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("D4: an aborted /handoff fails the command; the next /handoff works", async () => {
	let first: Promise<unknown> | undefined;
	const t: TestSession = await session(
		[
			toolStep("w1", "ls", {}, 20),
			abortedStep(), // ESC while the run is still working
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 40),
		],
		(call) => {
			if (call === 1) first = t.session.prompt("/handoff");
		},
	);
	try {
		await t.session.prompt("start").catch(() => {});
		await first;
		assert.deepEqual(t.seeds, [], "nothing seeded from an aborted cycle");
		assert.ok(
			t.notices.some((n) => n.level === "error" && /\/handoff: no handoff recorded — aborted/.test(n.message)),
			JSON.stringify(t.notices),
		);
		await t.session.prompt("/handoff");
		await t.session.waitForIdle();
		assert.ok(!t.notices.some((n) => /already in progress/.test(n.message)), "the command was never stranded");
		assertSeeded(t, LONG_DOC);
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("D5/D6: a handoff call in the crossing message is refused; after the swap no demand reaches the model", async () => {
	const contexts: string[] = [];
	const t = await createTestSession({
		extensionPaths: [path.join(EXT_DIR, "context-cap.ts")],
		tools: ["context_handoff"],
		llmDelayMs: 5,
		// System messages carry the tool declarations, whose description names [context-cap].
		onLlmCall: (_m, context) =>
			void contexts.push(JSON.stringify(context.messages.filter((m: { role: string }) => m.role !== "system"))),
		script: [
			// Crosses the soft cap AND calls the tool — no demand was ever in context.
			toolStep("h0", "context_handoff", { markdown: "x" }, 105),
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 108),
			textStep("post-swap turn", 5),
		],
	});
	try {
		await t.session.prompt("start");
		await t.session.waitForIdle();
		const results = toolResultTexts(t);
		assert.match(results[0]!, /^Refused: no handoff was requested/, "D6: crossing-message call refused");
		assert.match(results[1]!, /^Handoff recorded/);
		const markers = customEntries(t, SWAP_MARKER_TYPE);
		assert.equal(markers.length, 1);
		assert.ok(markers[0].content.includes(LONG_DOC) && !markers[0].content.includes("\nx\n"), "the real document swapped in");
		const entries = branch(t);
		const markerAt = entries.indexOf(markers[0]);
		assert.ok(
			!entries.slice(markerAt).some((e) => e.type === "custom_message" && e.customType === DEMAND_TYPE),
			"D5: no demand after the marker",
		);
		assert.ok(contexts[1]!.includes("[context-cap]"), "the demand reached the model before the swap");
		const postSwap = contexts.at(-1)!;
		assert.ok(!postSwap.includes("[context-cap]"), "D5: the post-swap request carries no cap text");
		assert.equal(contexts.length, 3, "no extra LLM call for a late demand");
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("/handoff while another /handoff waits is rejected without touching the cycle", async () => {
	let second: Promise<unknown> | undefined;
	const t: TestSession = await session(
		[toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 40)],
		(call) => {
			if (call === 1) second = t.session.prompt("/handoff");
		},
	);
	try {
		await t.session.prompt("/handoff");
		await second;
		await t.session.waitForIdle();
		await sleep(10);
		assertSeeded(t, LONG_DOC);
		assert.ok(t.notices.some((n) => n.level === "warning" && n.message === "/handoff already in progress"));
		assert.equal(customEntries(t, DEMAND_TYPE).length, 1);
	} finally {
		t.dispose();
	}
});

test("session shutdown releases a waiting /handoff silently", async () => {
	let handoff: Promise<unknown> | undefined;
	const t: TestSession = await session([toolStep("w1", "ls", {}, 20), textStep("done", 30)], (call) => {
		if (call === 1) handoff = t.session.prompt("/handoff");
	});
	try {
		const run = t.session.prompt("start");
		while (!handoff) await sleep(5);
		await sleep(5);
		await t.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await handoff; // must settle: shutdown never leaves the command hanging
		assert.deepEqual(t.seeds, []);
		assert.ok(!t.notices.some((n) => n.message.startsWith("/handoff: no handoff")), "silent");
		await run;
	} finally {
		t.dispose();
	}
});

test("context_handoff batched with another tool ends the run: no model call in the window being left, no second cycle", async () => {
	let calls = 0;
	const t = await session(
		[
			batchStep(
				[
					{ id: "h1", name: "context_handoff", args: { markdown: LONG_DOC } },
					{ id: "l1", name: "ls", args: {} },
				],
				50,
			),
			// Above the soft cap without tool calls: would open a silent-stop cap cycle.
			textStep("must never run: the window is being left", 110),
		],
		(call) => void (calls = call),
	);
	try {
		await t.session.prompt("/handoff");
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		assert.equal(calls, 1, "no model call after the document was recorded");
		assert.deepEqual(
			customEntries(t, DEMAND_TYPE).map((d) => [d.details.origin, d.details.kind]),
			[["manual", "demand"]],
			"no second (cap) cycle",
		);
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), []);
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

/** Resolves "settled" if `p` settles within `ms`, else "stuck". */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "stuck"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"stuck">((resolve) => (timer = setTimeout(() => resolve("stuck"), ms)));
	try {
		return await Promise.race([p.then(() => "settled" as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** A standalone completion as the handoff writer (lib/handoff-writer.ts) receives it. */
function writerResponse(text: string, stopReason = "stop"): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "writer-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

test("/handoff typed during a manual compaction demands once the compaction is over — never stuck", async () => {
	let handoff: Promise<unknown> | undefined;
	const t = await session(
		[
			textStep("first answer", 20),
			textStep("second answer", 20),
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 30),
		],
		undefined,
		{ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } },
	);
	// The compaction hook's writer call: the user types /handoff while pi compacts.
	t.modelRuntime.complete = async () => {
		handoff ??= t.session.prompt("/handoff");
		await sleep(30);
		return writerResponse("## Current Task\ncompaction summary");
	};
	try {
		await t.session.prompt("do work");
		await t.session.prompt("more work");
		await t.session.compact();
		assert.ok(handoff, "/handoff was typed during the compaction");
		assert.equal(await settlesWithin(handoff, 3000), "settled", "the command must not wait for a settle that never comes");
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		assert.deepEqual(
			customEntries(t, DEMAND_TYPE).map((d) => [d.details.origin, d.details.kind]),
			[["manual", "demand"]],
		);
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("/handoff typed during a compaction joins a cap demand an errored run left behind — demands once idle, never stuck", async () => {
	let handoff: Promise<unknown> | undefined;
	const t = await session(
		[
			toolStep("w1", "ls", {}, 50),
			toolStep("w2", "ls", {}, 105), // crosses soft → the cap demand is committed
			errorStep(), // the next request fails: the cycle stays "demanded", no run left to serve it
			toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 108),
		],
		undefined,
		{ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } },
	);
	t.modelRuntime.complete = async () => {
		handoff ??= t.session.prompt("/handoff");
		await sleep(30);
		return writerResponse("## Current Task\ncompaction summary");
	};
	try {
		await t.session.prompt("start");
		assert.deepEqual(customEntries(t, DEMAND_TYPE).map((d) => d.details.origin), ["soft"], "a cap demand is out");
		await t.session.compact();
		assert.ok(handoff, "/handoff was typed during the compaction");
		assert.ok(t.notices.some((n) => n.message.startsWith("/handoff: a handoff is already requested")), "joined");
		assert.equal(await settlesWithin(handoff, 3000), "settled", "a join during a compaction must not wait for a run");
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), []);
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

const MACHINE_DOC = "## Current Task\nMACHINE-DOC-SENTINEL";
const NO_DOC_REASON = "/handoff: no handoff recorded — hard cap hit and no handoff could be written — the context was swapped in place";

/**
 * /handoff typed mid-run, then a reply without tool calls crosses the hard cap:
 * the backstop writes (or fails to write) the document of the /handoff cycle.
 */
async function hardCapDuringHandoff(
	writer: () => Promise<unknown>,
	staleDoc?: string,
): Promise<{ t: TestSession; llmCalls: number }> {
	let handoff: Promise<unknown> | undefined;
	let calls = 0;
	const t: TestSession = await session(
		[toolStep("w1", "ls", {}, 20), textStep("crosses the hard cap", 1200), textStep("post-swap turn", 5)],
		(call) => {
			calls = call;
			if (call === 1) handoff = t.session.prompt("/handoff");
		},
	);
	const sessionId = t.session.sessionManager.getSessionId();
	if (staleDoc !== undefined) {
		fs.mkdirSync(contextCapDir(), { recursive: true });
		fs.writeFileSync(path.join(contextCapDir(), `${sessionId}-1.md`), `---\nseq: 1\nauthor: agent\n---\n\n${staleDoc}\n`);
	}
	t.modelRuntime.complete = writer;
	await t.session.prompt("start");
	assert.ok(handoff, "/handoff was typed mid-run");
	assert.equal(await settlesWithin(handoff, 3000), "settled");
	await t.session.waitForIdle();
	return { t, llmCalls: calls };
}

test("hard cap during /handoff, machine-written document → new session from it, no swap", async () => {
	const { t, llmCalls } = await hardCapDuringHandoff(async () => writerResponse(MACHINE_DOC));
	try {
		assert.equal(t.seeds.length, 1);
		const seed = t.seeds[0]!;
		assert.equal(seed.triggerTurn, false);
		assert.ok(String(seed.content).includes("MACHINE-DOC-SENTINEL"), "this cycle's machine document seeds the session");
		assert.ok(String(seed.content).includes("reconstructed automatically"), "marked second-hand");
		assert.deepEqual(customEntries(t, SWAP_MARKER_TYPE), []);
		assert.equal(llmCalls, 2, "no post-swap turn");
	} finally {
		t.dispose();
	}
});

for (const [name, staleDoc, trigger] of [
	["stale file", "## Current Task\nSTALE-DOC-SENTINEL", "hard"],
	["no file", undefined, "hard-no-file"],
] as const) {
	test(`hard cap during /handoff, writer fails, ${name} → /handoff fails, the context is swapped in place`, async () => {
		const { t } = await hardCapDuringHandoff(async () => writerResponse("", "error"), staleDoc);
		try {
			assert.deepEqual(t.seeds, [], "no session seeded with a document from another cycle (or none)");
			assert.ok(
				t.notices.some((n) => n.level === "error" && n.message === NO_DOC_REASON),
				JSON.stringify(t.notices),
			);
			const markers = customEntries(t, SWAP_MARKER_TYPE);
			assert.equal(markers.length, 1, "the cap swap runs as it does without /handoff");
			assert.equal(markers[0].details.trigger, trigger);
			if (staleDoc) {
				assert.equal(markers[0].details.stale, true);
				assert.ok(markers[0].content.includes("STALE-DOC-SENTINEL"));
				assert.ok(markers[0].content.endsWith("Continue your work."), "the agent continues, as for the cap swap");
			} else {
				assert.ok(markers[0].content.includes("Ask the user for direction"));
			}
			const last = branch(t).at(-1);
			assert.match(JSON.stringify(last.message?.content), /post-swap turn/, "the run continued after the marker");
		} finally {
			t.dispose();
		}
	});
}

/**
 * A session whose first request fails with a retryable error: /handoff is typed
 * during pi's auto-retry backoff — busy, a run in flight, but no request out.
 */
async function retrySession(
	script: ScriptedStep[],
	duringBackoff: (t: TestSession) => void,
): Promise<{ t: TestSession; settles: boolean[] }> {
	const t = await session([errorStep("network error"), ...script], undefined, { retry: { enabled: true, baseDelayMs: 150 } });
	const settles: boolean[] = [];
	t.session.subscribe((event: any) => {
		if (event.type === "auto_retry_start") duringBackoff(t);
		else if (event.type === "agent_settled") settles.push(event.aborted);
	});
	return { t, settles };
}

const PARKED = "/handoff: handoff requested once the agent finishes";

test("/handoff typed during an auto-retry backoff is delivered at agent_before_settle of that same run", async () => {
	let handoff: Promise<unknown> | undefined;
	const { t, settles } = await retrySession(
		[textStep("work done", 30), toolStep("h1", "context_handoff", { markdown: LONG_DOC }, 40)],
		(s) => void (handoff ??= s.session.prompt("/handoff")),
	);
	try {
		await t.session.prompt("start");
		assert.ok(handoff, "/handoff was typed during the backoff");
		assert.equal(await settlesWithin(handoff, 3000), "settled");
		await t.session.waitForIdle();
		assertSeeded(t, LONG_DOC);
		assert.ok(t.notices.some((n) => n.message === PARKED), "armed at once, not after the run");
		assert.equal(settles.length, 1, "one run: the demand rode its settle boundary, no second run");
		const entries = branch(t);
		const demandAt = entries.findIndex((e) => e.type === "custom_message" && e.customType === DEMAND_TYPE);
		const workDone = entries.findIndex((e) => e.type === "message" && JSON.stringify(e.message.content).includes("work done"));
		assert.ok(workDone >= 0 && demandAt > workDone, "the demand follows the retried run's own answer");
		assertNothingQueued(t);
	} finally {
		t.dispose();
	}
});

test("ESC during an auto-retry backoff fails a waiting /handoff with 'aborted' — no demand run", async () => {
	let handoff: Promise<unknown> | undefined;
	const { t, settles } = await retrySession([textStep("must never run", 30)], (s) => {
		handoff ??= s.session.prompt("/handoff");
		void (async () => {
			for (let i = 0; i < 50 && !s.notices.some((n) => n.message === PARKED); i++) await sleep(2);
			await s.session.abort();
		})();
	});
	try {
		await t.session.prompt("start").catch(() => {});
		assert.ok(handoff, "/handoff was typed during the backoff");
		assert.equal(await settlesWithin(handoff, 3000), "settled");
		await t.session.waitForIdle();
		await sleep(20);
		assert.deepEqual(t.seeds, []);
		assert.ok(
			t.notices.some((n) => n.level === "error" && n.message === "/handoff: no handoff recorded — aborted"),
			JSON.stringify(t.notices),
		);
		assert.deepEqual(settles, [true], "the aborted run settled once; no demand run followed");
		assert.deepEqual(customEntries(t, DEMAND_TYPE), []);
	} finally {
		t.dispose();
	}
});
