/**
 * Timer extension: the two waiting strategies.
 *
 * Interactive (`mode: "tui"`) — async wake-up. Failure mode these tests pin down
 * (observed live): the expiry message was injected with `deliverAs: "followUp"`.
 * pi delivers follow-ups only when the whole agent run ends (no more tool calls).
 * During a long run the wake-up therefore never arrives; every expiry piles up in
 * the queue instead, and the stack is flushed as several stale wake-ups once the
 * run finally ends. Every test below that scripts a wake-up must therefore pass
 * `mode: "tui"` — without it pi's ExtensionRunner reports "print" and the tool
 * blocks instead.
 *
 * Headless (`mode: "print"`/"json"/"rpc") — blocking. Failure mode: `pi -p` awaits
 * one `session.prompt()` and disposes the runtime right after, so a timer armed for
 * after the turn can never wake anything; unattended runs exited 0 mid-task. The
 * tool must instead stay in flight for the wait and must never tell the agent to
 * end its turn.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hasPendingWork } from "../lib/pending-work.ts";
import { createTestSession, type ExtensionMode, sleep, textStep, toolStep } from "./harness.ts";

const TIMER_EXTENSION = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../timer.ts");

const LLM_DELAY_MS = 60;
const TIMER_SECONDS = 0.25;

const isExpiry = (text: string) => text.startsWith("Timer ") && text.includes("expired");

/** Text of every tool result recorded in the session, in order. */
function toolResultTexts(t: { session: { messages: unknown } }): string[] {
	return (t.session.messages as Array<{ role: string; content?: unknown }>)
		.filter((m) => m.role === "toolResult")
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text ?? "");
}

function headlessSession(mode: ExtensionMode, script: Parameters<typeof createTestSession>[0]["script"]) {
	return createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode,
		tools: ["timer"],
		llmDelayMs: LLM_DELAY_MS,
		script,
	});
}

/**
 * A long agent run: the agent sets a timer, then keeps calling tools for much
 * longer than the timer duration, sets a second timer, and only stops at the end.
 */
async function runBusyAgentWithTimers() {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer", "bash"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: TIMER_SECONDS }),
			toolStep("w1", "bash", { command: "sleep 0.05" }),
			toolStep("w2", "bash", { command: "sleep 0.05" }),
			toolStep("w3", "bash", { command: "sleep 0.05" }),
			toolStep("s2", "timer", { action: "set", name: "t2", seconds: TIMER_SECONDS }),
			toolStep("w4", "bash", { command: "sleep 0.05" }),
			toolStep("w5", "bash", { command: "sleep 0.05" }),
			toolStep("w6", "bash", { command: "sleep 0.05" }),
			textStep("all done"),
		],
	});

	await t.session.prompt("start the long task");
	await sleep(300); // let any straggling queued message be delivered
	return t;
}

test("expiry wakes the agent at the next turn boundary, not at the end of the run", async () => {
	const t = await runBusyAgentWithTimers();
	try {
		const expiry = t.queueSnapshots.find((s) =>
			[...s.steering, ...s.followUp].some((m) => isExpiry(m) && m.includes('"t1"')),
		);
		assert.ok(expiry, "t1 expiry message was never queued");

		const delivery = t.deliveredUserMessages.find((m) => isExpiry(m.text) && m.text.includes('"t1"'));
		assert.ok(delivery, "t1 expiry message was never delivered to the agent");

		// The wake-up must land at the first turn boundary after expiry. Allow one
		// boundary (the one that delivers it); more means it waited for the run to end.
		const boundariesWaited = t.turnEnds.filter(
			(at) => at >= expiry.atMs && at <= delivery.atMs,
		).length;
		assert.ok(
			boundariesWaited <= 1,
			`expiry message waited ${boundariesWaited} turn boundaries (queued ${expiry.atMs}ms, delivered ${delivery.atMs}ms) — it should be delivered at the next turn boundary`,
		);
	} finally {
		t.dispose();
	}
});

test("expiry while the agent is idle starts a new turn", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "idle-check", seconds: TIMER_SECONDS }),
			textStep("waiting"),
			textStep("woken up"),
		],
	});
	try {
		await t.session.prompt("start"); // run ends well before the timer expires
		const runEndedAt = t.now();
		await sleep(TIMER_SECONDS * 1000 + 400);

		const delivery = t.deliveredUserMessages.find((m) => isExpiry(m.text));
		assert.ok(delivery, "expiry message was never delivered while idle");
		assert.ok(
			delivery.atMs > runEndedAt,
			"expiry should arrive after the run ended, starting a fresh turn",
		);
	} finally {
		t.dispose();
	}
});

test("expiry messages never stack up in the queue", async () => {
	const t = await runBusyAgentWithTimers();
	try {
		const worst = t.queueSnapshots.reduce((max, s) => {
			const pending = [...s.steering, ...s.followUp].filter(isExpiry).length;
			return Math.max(max, pending);
		}, 0);
		assert.ok(
			worst <= 1,
			`${worst} timer expiry messages were queued at the same time — expiries must be delivered before the next one can be queued`,
		);

		const delivered = t.deliveredUserMessages.filter((m) => isExpiry(m.text)).map((m) => m.text);
		assert.equal(delivered.length, 2, `expected both expiries delivered once, got ${JSON.stringify(delivered)}`);
	} finally {
		t.dispose();
	}
});

// ---------------------------------------------------------------------------
// Headless (pi -p): the tool blocks; nothing may be promised for after the turn.
// ---------------------------------------------------------------------------

for (const mode of ["print", "json", "rpc"] as const) {
	test(`headless (${mode}): the tool blocks until the wait is over instead of promising a wake-up`, async () => {
		const t = await headlessSession(mode, [
			toolStep("s1", "timer", { action: "set", name: "build", seconds: TIMER_SECONDS }),
			textStep("build finished"),
		]);
		try {
			const startedAt = Date.now();
			await t.session.prompt("start the build");
			const elapsedMs = Date.now() - startedAt;

			const results = toolResultTexts(t);
			assert.ok(
				results.some((text) => /^Timer "build" fired after \d+s\. Continue your task\.$/.test(text)),
				`blocking result missing, got: ${JSON.stringify(results)}`,
			);
			assert.ok(
				elapsedMs >= TIMER_SECONDS * 1000,
				`run returned after ${elapsedMs}ms — the tool call must stay in flight for the whole ${TIMER_SECONDS * 1000}ms wait`,
			);
			assert.equal(
				t.deliveredUserMessages.filter((m) => isExpiry(m.text)).length,
				0,
				"headless must not inject a wake-up message — nothing would be alive to receive it",
			);
			assert.equal(
				hasPendingWork(t.session.sessionManager.getSessionId()),
				false,
				"a blocking wait outlives nothing, so it must not claim pending work",
			);
		} finally {
			t.dispose();
		}
	});
}

test("headless: the result never tells the agent to end its turn", async () => {
	const t = await headlessSession("print", [
		toolStep("s1", "timer", { action: "set", name: "t1", seconds: TIMER_SECONDS }),
		textStep("done"),
	]);
	try {
		await t.session.prompt("start");
		for (const text of toolResultTexts(t)) {
			assert.ok(
				!/end your turn/i.test(text) && !/wake you/i.test(text),
				`headless result must not promise a wake-up: ${JSON.stringify(text)}`,
			);
		}
	} finally {
		t.dispose();
	}
});

test("headless: aborting the tool call ends the wait promptly and leaves no timer", async () => {
	const t = await headlessSession("print", [
		toolStep("s1", "timer", { action: "set", name: "long", seconds: 300 }),
		textStep("never reached"),
	]);
	try {
		const startedAt = Date.now();
		const run = t.session.prompt("start");
		await sleep(LLM_DELAY_MS + 120); // let the tool call get into its wait
		await t.session.abort();
		await run;
		const elapsedMs = Date.now() - startedAt;
		assert.ok(elapsedMs < 5000, `abort took ${elapsedMs}ms — the wait must be cut short, not run to 300s`);

		const results = toolResultTexts(t);
		assert.ok(
			results.some((text) => text.includes('Timer "long" wait aborted after')),
			`aborted result missing, got: ${JSON.stringify(results)}`,
		);
		assert.equal(hasPendingWork(t.session.sessionManager.getSessionId()), false, "abort must leave no claim");

		// Nothing may remain scheduled: the aborted wait must not deliver anything later.
		await sleep(300);
		assert.equal(
			t.deliveredUserMessages.filter((m) => isExpiry(m.text)).length,
			0,
			"an aborted wait must leave no timer behind",
		);
	} finally {
		t.dispose();
	}
});

test("headless: a wait longer than the cap returns after the cap and asks to be called again", async () => {
	const previous = process.env.PI_TIMER_MAX_WAIT_S;
	process.env.PI_TIMER_MAX_WAIT_S = "1"; // stand-in for the 600s default
	try {
		const t = await headlessSession("print", [
			toolStep("s1", "timer", { action: "set", name: "slow", seconds: 3 }),
			textStep("checked"),
		]);
		try {
			const startedAt = Date.now();
			await t.session.prompt("start");
			const elapsedMs = Date.now() - startedAt;
			assert.ok(elapsedMs < 3000, `waited ${elapsedMs}ms — the cap must cut the wait short`);

			const results = toolResultTexts(t);
			const capped = results.find((text) => text.startsWith('Timer "slow":'));
			assert.ok(capped, `capped result missing, got: ${JSON.stringify(results)}`);
			assert.match(capped, /waited 1s of the 3s requested/);
			assert.match(capped, /capped at 1s/);
			assert.match(capped, /call timer again with seconds: 2/);
			assert.ok(!/end your turn/i.test(capped), "the capped result must keep the agent in its turn");
		} finally {
			t.dispose();
		}
	} finally {
		if (previous === undefined) delete process.env.PI_TIMER_MAX_WAIT_S;
		else process.env.PI_TIMER_MAX_WAIT_S = previous;
	}
});

test("headless: cancel reports that there is nothing armed to cancel", async () => {
	const t = await headlessSession("print", [
		toolStep("c1", "timer", { action: "cancel" }),
		textStep("done"),
	]);
	try {
		await t.session.prompt("cancel it");
		const results = toolResultTexts(t);
		assert.ok(
			results.some((text) => text.startsWith("No timer to cancel:") && text.includes("aborting that tool call")),
			`headless cancel must explain itself, got: ${JSON.stringify(results)}`,
		);
	} finally {
		t.dispose();
	}
});

// ---------------------------------------------------------------------------
// Interactive: unchanged async behaviour.
// ---------------------------------------------------------------------------

test("interactive: set arms the async timer, claims pending work and hands the turn back", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: 300 }),
			textStep("waiting"),
		],
	});
	try {
		const startedAt = Date.now();
		await t.session.prompt("start");
		const elapsedMs = Date.now() - startedAt;
		assert.ok(elapsedMs < 5000, `run took ${elapsedMs}ms — the interactive tool must return immediately`);

		const results = toolResultTexts(t);
		assert.ok(
			results.some(
				(text) =>
					text.startsWith('Timer "t1" set — fires in 300s') &&
					text.includes("End your turn now; the expiry message will wake you."),
			),
			`interactive result changed, got: ${JSON.stringify(results)}`,
		);
		assert.equal(
			hasPendingWork(t.session.sessionManager.getSessionId()),
			true,
			"an armed timer must claim pending work so a supervising caller keeps waiting",
		);
	} finally {
		t.dispose(); // session_shutdown disarms the 300s timer and releases the claim
	}
});

test("interactive: cancel disarms the timer and releases the claim", async () => {
	const t = await createTestSession({
		extensionPaths: [TIMER_EXTENSION],
		mode: "tui",
		tools: ["timer"],
		llmDelayMs: LLM_DELAY_MS,
		script: [
			toolStep("s1", "timer", { action: "set", name: "t1", seconds: 300 }),
			toolStep("c1", "timer", { action: "cancel" }),
			toolStep("c2", "timer", { action: "cancel" }),
			textStep("done"),
		],
	});
	try {
		await t.session.prompt("start then cancel");
		const results = toolResultTexts(t);
		assert.ok(
			results.some((text) => /^Cancelled timer "t1" \(\d+s remaining\)\.$/.test(text)),
			`cancel result missing, got: ${JSON.stringify(results)}`,
		);
		assert.ok(results.includes("No active timer."), `second cancel should be a no-op, got: ${JSON.stringify(results)}`);
		assert.equal(hasPendingWork(t.session.sessionManager.getSessionId()), false, "cancel must release the claim");
	} finally {
		t.dispose();
	}
});
