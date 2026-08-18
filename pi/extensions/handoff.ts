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

export default function handoffExtension(pi: ExtensionAPI) {
	// Resolve when agent finishes after handoff prompt
	let onAgentEnd: (() => void) | undefined;

	pi.on("agent_end", () => {
		if (onAgentEnd) {
			onAgentEnd();
			onAgentEnd = undefined;
		}
	});

	pi.registerCommand("handoff", {
		description: "Generate a session summary and start a new session with it",
		handler: async (_args, ctx) => {
			// Set up promise that resolves on next agent_end
			const agentDone = new Promise<void>((resolve) => {
				onAgentEnd = resolve;
			});

			// Inject handoff prompt — queue as followUp if streaming
			if (ctx.isIdle()) {
				pi.sendUserMessage(HANDOFF_PROMPT);
			} else {
				pi.sendUserMessage(HANDOFF_PROMPT, { deliverAs: "followUp" });
			}

			// Wait for summary generation to complete
			await agentDone;

			// Extract summary from last assistant message
			const branch = ctx.sessionManager.getBranch();
			let summaryText: string | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const content = entry.message.content;
					if (Array.isArray(content)) {
						summaryText = content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("\n");
					} else if (typeof content === "string") {
						summaryText = content;
					}
					break;
				}
			}

			if (!summaryText) {
				ctx.ui.notify("No summary generated — no assistant message found", "error");
				return;
			}

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
