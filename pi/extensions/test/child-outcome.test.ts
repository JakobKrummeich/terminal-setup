/**
 * lib/child-outcome.ts in isolation: how a child run's end is reported to the
 * parent (Agent/Explore tool result) and in the F2 transcript.
 * child-retry.test.ts drives the timeout-retry paths end to end; these pin the
 * branches its scripted provider never reaches, each a silent misreport if a
 * refactor breaks it:
 *  - a non-retryable failure after an earlier RECOVERED retry must not claim
 *    "(after 1 retry)" — the good message in between resets the count;
 *  - a failure pi never retried carries no retry suffix at all; one retry is
 *    "1 retry", not "1 retries";
 *  - a failed message without errorMessage still reads as a failure;
 *  - non-assistant messages (the prompt's own user message) never become the
 *    child's answer or clear a standing error;
 *  - a failed retry end without finalError still renders a line.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { failureText, newRunOutcome, retryLineText, trackOutcome } from "../lib/child-outcome.ts";

function assistant(text: string, stopReason = "stop", errorMessage?: string): AgentSessionEvent {
	const message = { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage };
	return { type: "message_end", message } as unknown as AgentSessionEvent;
}

const failed = (errorMessage?: string) => assistant("", "error", errorMessage);

function retryStart(attempt: number): AgentSessionEvent {
	return { type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage: "Request timed out." };
}

/** The outcome after folding `events` in order. */
function fold(events: AgentSessionEvent[]) {
	const outcome = newRunOutcome();
	for (const event of events) trackOutcome(outcome, event);
	return outcome;
}

test("a recovered retry, then a non-retryable failure → error without a stale retry count", () => {
	const outcome = fold([failed("Request timed out."), retryStart(1), assistant("INTERIM"), failed("400 bad request")]);
	assert.equal(outcome.error, "400 bad request");
	assert.equal(outcome.retries, 0, "the good message in between resets the retry count");
	assert.equal(
		failureText("agent", outcome.error, outcome),
		"agent failed: 400 bad request\n\nPartial output (the last text before the failure, not a final answer):\n\nINTERIM",
	);
});

test("a later good message clears the error: the run is a success with the newest text", () => {
	const outcome = fold([failed("Request timed out."), retryStart(1), assistant("child done")]);
	assert.equal(outcome.error, undefined);
	assert.equal(outcome.text, "child done");
});

test("failureText: no retry suffix without retries, singular for one, plural for more", () => {
	const outcome = newRunOutcome();
	assert.equal(failureText("Explore", "boom", outcome), "Explore failed: boom");
	outcome.retries = 1;
	assert.equal(failureText("Explore", "boom", outcome), "Explore failed: boom (after 1 retry)");
	outcome.retries = 3;
	assert.equal(failureText("Explore", "boom", outcome), "Explore failed: boom (after 3 retries)");
});

test("a failed message with no (or empty) errorMessage still counts as a failure", () => {
	assert.equal(fold([failed()]).error, "unknown error");
	assert.equal(fold([failed("")]).error, "unknown error");
});

test("non-assistant messages neither become the answer nor clear a standing error", () => {
	const user = { type: "message_end", message: { role: "user", content: [{ type: "text", text: "the task" }] } };
	const outcome = fold([assistant("  answer  "), failed("overloaded"), user as unknown as AgentSessionEvent]);
	assert.equal(outcome.text, "answer", "trimmed, and the user message is not the child's text");
	assert.equal(outcome.error, "overloaded");
});

test("retryLineText: start line in pi's wording; nothing for a successful end; fallback for a missing finalError", () => {
	const start = { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4001, errorMessage: "429" } as const;
	assert.equal(retryLineText(start), "Retrying 2/3 in 5s: 429");
	assert.equal(retryLineText({ type: "auto_retry_end", success: true, attempt: 1 }), undefined);
	assert.equal(
		retryLineText({ type: "auto_retry_end", success: false, attempt: 3 }),
		"Retry failed after 3 attempts: unknown error",
	);
});
