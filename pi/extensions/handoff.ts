import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HANDOFF_PROMPT = `Write a handoff as assistant message for the next agent who continues your work. Plain markdown, ~30 lines total:
- A brief summary of this session and current status
- Key file paths that were worked on
- Information you found surprising or where you struggled
- Information that you think help the next agent`;

const HANDOFF_PREAMBLE =
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
