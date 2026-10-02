import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handoffLineBudget, handoffSections } from "./lib/handoff-writer.ts";
import { messageText } from "./lib/message-text.ts";
import { HANDOFF_PREAMBLE, HANDOFF_SUMMARY_TYPE } from "./lib/message-types.ts";

/**
 * Reply-mode variant of context-cap's handoff request. The section list and
 * line budget come from the SAME source (lib/handoff-writer.ts), so the
 * CONTEXT_CAP_SCHEMA lever governs /handoff and the caps alike — one schema,
 * two delivery mechanisms. The differences are deliberate:
 *  - the document is a normal assistant reply harvested from the transcript,
 *    not a context_handoff tool call (hence the explicit tool ban — the tool
 *    would be refused anyway with no cycle armed, but noisily);
 *  - the successor session is seeded with it and does NOT auto-continue
 *    (triggerTurn: false below): the user stays in the driver's seat, so no
 *    "Continue your work." suffix either.
 */
/**
 * Opening words of HANDOFF_PROMPT. The message_start handler below detects the
 * prompt entering a run by this text, so it is derived here, not re-typed there.
 */
const HANDOFF_PROMPT_OPENING = "Write the handoff document your successor session starts from";

export const HANDOFF_PROMPT = `${HANDOFF_PROMPT_OPENING}, as your reply. The next session sees this document and nothing else — no conversation history, no tool output. Anything you leave out is lost; be concrete (real paths, real commands, real state) and mark every unverified claim as unverified.

Plain markdown, ~${handoffLineBudget()} lines total:
${handoffSections()}

Reply with the document only — no preamble, no sign-off, no code fence around the whole document, and do NOT call any tools (not even context_handoff: this handoff is harvested from your reply, not from a file).`;

/** What the harvest found in the branch after the handoff run ended. */
export type SummaryExtraction = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Last assistant message of the branch, judged as a handoff document. Rejects
 * instead of seeding garbage (observed live: a timed-out request synthesizes an
 * assistant message with stopReason "error" — empty at best, a truncated
 * half-document at worst; seeding either silently would be strictly worse than
 * asking the user to run /handoff again). Pure; exported for tests.
 */
export function extractHandoffSummary(
	branch: ReadonlyArray<{ type: string; message?: HarvestedMessage }>,
): SummaryExtraction {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!; // i ∈ [0, branch.length): loop bound
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		return judgeHandoffReply(entry.message);
	}
	return { ok: false, reason: "no assistant message found" };
}

type HarvestedMessage = { role?: string; stopReason?: string; content?: unknown };

/** The newest assistant message as a handoff document: errored/aborted/empty replies are rejected. */
function judgeHandoffReply({ stopReason, content }: HarvestedMessage): SummaryExtraction {
	if (stopReason === "error" || stopReason === "aborted") {
		return { ok: false, reason: `handoff generation ${stopReason === "aborted" ? "was aborted" : "failed"} — run /handoff again` };
	}
	const text = messageText(content).trim();
	if (!text) return { ok: false, reason: "handoff reply was empty — run /handoff again" };
	return { ok: true, text };
}

export default function handoffExtension(pi: ExtensionAPI) {
	/**
	 * One in-flight /handoff. `delivered` is the evidence gate: when the command
	 * fires mid-stream the prompt is queued as followUp, and the CURRENT run's
	 * agent_end must not resolve the wait — harvesting then would seed the last
	 * pre-handoff reply as the summary. Only an agent_end after the prompt was
	 * observed entering a run (message_start) counts — same evidence pattern as
	 * timer.ts's wake-up release. resolve(false) = session shut down: skip the
	 * harvest — the branch may still end in the pre-handoff reply, and the old
	 * ctx is being torn down, so a newSession() from it would race the teardown.
	 */
	let pending: { resolve: (harvest: boolean) => void; delivered: boolean } | undefined;

	pi.on("message_start", (event) => {
		if (!pending || pending.delivered) return;
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "user") return;
		if (messageText(msg.content).includes(HANDOFF_PROMPT_OPENING)) {
			pending.delivered = true;
		}
	});

	pi.on("agent_end", () => {
		if (!pending?.delivered) return;
		pending.resolve(true);
		pending = undefined;
	});

	pi.on("session_shutdown", () => {
		pending?.resolve(false); // never leave the command handler hanging
		pending = undefined;
	});

	pi.registerCommand("handoff", {
		description: "Generate a session summary and start a new session with it",
		handler: async (_args, ctx) => {
			if (pending) {
				ctx.ui.notify("/handoff already in progress", "warning");
				return;
			}
			const agentDone = new Promise<boolean>((resolve) => {
				pending = { resolve, delivered: false };
			});

			// Inject handoff prompt — queue as followUp if streaming
			if (ctx.isIdle()) {
				pi.sendUserMessage(HANDOFF_PROMPT);
			} else {
				pi.sendUserMessage(HANDOFF_PROMPT, { deliverAs: "followUp" });
			}

			// Wait for the handoff run (not merely the current run) to complete
			if (!(await agentDone)) return;

			const summary = extractHandoffSummary(ctx.sessionManager.getBranch());
			if (!summary.ok) {
				ctx.ui.notify(`No summary generated — ${summary.reason}`, "error");
				return;
			}
			const summaryText = summary.text;

			// Create new session with summary injected
			await ctx.newSession({
				withSession: async (newCtx) => {
					await newCtx.sendMessage(
						{
							customType: HANDOFF_SUMMARY_TYPE,
							content: `${HANDOFF_PREAMBLE}\n\n${summaryText.trim()}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				},
			});
		},
	});
}
