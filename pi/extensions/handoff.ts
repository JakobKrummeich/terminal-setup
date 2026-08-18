import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handoffLineBudget, handoffSections } from "./lib/handoff-writer.ts";

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
export const HANDOFF_PROMPT = `Write the handoff document your successor session starts from, as your reply. The next session sees this document and nothing else — no conversation history, no tool output. Anything you leave out is lost; be concrete (real paths, real commands, real state) and mark every unverified claim as unverified.

Plain markdown, ~${handoffLineBudget()} lines total:
${handoffSections()}

Reply with the document only — no preamble, no sign-off, no code fence around the whole document, and do NOT call any tools (not even context_handoff: this handoff is harvested from your reply, not from a file).`;

// Matches context-cap.ts's PREAMBLE byte for byte — successors read the same
// opening line whether the handoff came from a cap swap or from /handoff.
export const HANDOFF_PREAMBLE =
	"You are continuing work from a previous session. The agent before you left you this information:";

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
	branch: ReadonlyArray<{ type: string; message?: { role?: string; stopReason?: string; content?: unknown } }>,
): SummaryExtraction {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const { stopReason, content } = entry.message;
		if (stopReason === "error" || stopReason === "aborted") {
			return { ok: false, reason: `handoff generation ${stopReason === "aborted" ? "was aborted" : "failed"} — run /handoff again` };
		}
		const text = (
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n")
					: ""
		).trim();
		if (!text) return { ok: false, reason: "handoff reply was empty — run /handoff again" };
		return { ok: true, text };
	}
	return { ok: false, reason: "no assistant message found" };
}

export default function handoffExtension(pi: ExtensionAPI) {
	/**
	 * One in-flight /handoff. `delivered` is the evidence gate: when the command
	 * fires mid-stream the prompt is queued as followUp, and the CURRENT run's
	 * agent_end must not resolve the wait — harvesting then would seed the last
	 * pre-handoff reply as the summary. Only an agent_end after the prompt was
	 * observed entering a run (message_start) counts — same evidence pattern as
	 * timer.ts's wake-up release.
	 */
	let pending: { resolve: () => void; delivered: boolean } | undefined;

	pi.on("message_start", (event) => {
		if (!pending || pending.delivered) return;
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role !== "user") return;
		const text = Array.isArray(msg.content)
			? (msg.content as Array<{ type?: string; text?: string }>)
					.filter((c) => c?.type === "text")
					.map((c) => c.text ?? "")
					.join("\n")
			: String(msg.content ?? "");
		if (text.includes("Write the handoff document your successor session starts from")) {
			pending.delivered = true;
		}
	});

	pi.on("agent_end", () => {
		if (!pending?.delivered) return;
		pending.resolve();
		pending = undefined;
	});

	pi.on("session_shutdown", () => {
		pending?.resolve(); // never leave the command handler hanging
		pending = undefined;
	});

	pi.registerCommand("handoff", {
		description: "Generate a session summary and start a new session with it",
		handler: async (_args, ctx) => {
			if (pending) {
				ctx.ui.notify("/handoff already in progress", "warning");
				return;
			}
			const agentDone = new Promise<void>((resolve) => {
				pending = { resolve, delivered: false };
			});

			// Inject handoff prompt — queue as followUp if streaming
			if (ctx.isIdle()) {
				pi.sendUserMessage(HANDOFF_PROMPT);
			} else {
				pi.sendUserMessage(HANDOFF_PROMPT, { deliverAs: "followUp" });
			}

			// Wait for the handoff run (not merely the current run) to complete
			await agentDone;

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
							customType: "handoff-summary",
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
