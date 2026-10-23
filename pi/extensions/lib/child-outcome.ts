// How one child run ended, as the parent's tool result must report it: the
// child's final text, and whether the run ended on a provider failure that pi's
// auto-retry could not recover (then the result is an error, not an answer) —
// plus the F2 transcript line of each of those retries.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { messageText } from "./message-text.ts";

export interface RunOutcome {
	/** The last assistant message with non-blank text, WHOLE (all its text blocks). */
	text: string;
	/**
	 * errorMessage of the run's last assistant message if that message failed
	 * (stopReason "error"); undefined once a later message ends normally. pi
	 * retries inside prompt(), so a recovered run ends with this cleared.
	 */
	error: string | undefined;
	/** Retries pi spent since the last good message (auto_retry_start attempt). */
	retries: number;
}

export function newRunOutcome(): RunOutcome {
	return { text: "", error: undefined, retries: 0 };
}

/** Fold one child event into `outcome`. */
export function trackOutcome(outcome: RunOutcome, event: AgentSessionEvent): void {
	if (event.type === "auto_retry_start") outcome.retries = event.attempt;
	else if (event.type === "message_end") trackMessageEnd(outcome, event.message);
}

function trackMessageEnd(outcome: RunOutcome, message: { role: string }): void {
	if (message.role !== "assistant") return;
	outcome.text = assistantText(message) || outcome.text;
	if (isFailedAttempt(message)) {
		outcome.error = (message as { errorMessage?: string }).errorMessage || "unknown error";
	} else {
		outcome.error = undefined;
		outcome.retries = 0;
	}
}

/**
 * An assistant message of a failed provider call (stopReason "error"). pi still
 * fires turn_end for it, but it is no turn of the child's work — and pi retries
 * it in place, so counting it would inflate the turn count per attempt.
 */
export function isFailedAttempt(message: { role: string }): boolean {
	return message.role === "assistant" && (message as { stopReason?: string }).stopReason === "error";
}

/** The trimmed text of an assistant message ("" for other roles or no text). */
function assistantText(message: { role: string }): string {
	if (message.role !== "assistant") return "";
	return messageText((message as { content?: unknown }).content).trim();
}

/**
 * Result body of a run that ended on a failure: the error first, so the parent
 * cannot mistake earlier interim text for the child's final answer.
 */
export function failureText(kind: string, error: string, outcome: RunOutcome): string {
	const retries = outcome.retries > 0 ? ` (after ${outcome.retries} ${outcome.retries === 1 ? "retry" : "retries"})` : "";
	const head = `${kind} failed: ${error}${retries}`;
	if (!outcome.text) return head;
	return `${head}\n\nPartial output (the last text before the failure, not a final answer):\n\n${outcome.text}`;
}

type RetryEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>;

/** F2 transcript line of a pi auto-retry event (pi's wording); undefined for a successful retry's end. */
export function retryLineText(event: RetryEvent): string | undefined {
	if (event.type === "auto_retry_start") {
		return `Retrying ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1000)}s: ${event.errorMessage}`;
	}
	return event.success ? undefined : `Retry failed after ${event.attempt} attempts: ${event.finalError ?? "unknown error"}`;
}
