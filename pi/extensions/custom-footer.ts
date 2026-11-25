import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderFooterLines } from "./lib/footer.ts";

/**
 * Cumulative cost of the whole session. This footer REPLACES pi's built-in one,
 * so it sums the same entries pi's footer and AgentSession.getSessionStats() do
 * (the F2 child footer shows the latter): assistant messages alone missed
 * compaction summaries — context-cap-compact.ts records its writer's usage
 * there — cache warming (`usage` entries) and tools that bill their own calls.
 * Exported for tests.
 */
export function sessionCost(entries: readonly SessionEntry[]): number {
	let cost = 0;
	for (const entry of entries) cost += entryCost(entry);
	return cost;
}

function entryCost(entry: SessionEntry): number {
	switch (entry.type) {
		case "usage":
		case "compaction":
		case "branch_summary":
			return billed(entry.usage);
		case "message": {
			const { message } = entry;
			const billable = message.role === "assistant" || message.role === "toolResult";
			return billable ? billed(message.usage) : 0;
		}
		default:
			return 0;
	}
}

/** A usage's billed total; 0 where none was recorded (usage is optional on most kinds). */
function billed(usage: Usage | undefined): number {
	return usage?.cost.total ?? 0;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return renderFooterLines(width, theme, {
						cost: sessionCost(ctx.sessionManager.getEntries()),
						usingSubscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
						cwd: process.cwd(),
						branch: footerData.getGitBranch(),
						sessionName: ctx.sessionManager.getSessionName?.(),
						modelId: ctx.model?.id,
						reasoning: ctx.model?.reasoning === true,
						thinkingLevel: pi.getThinkingLevel(),
						statuses: footerData.getExtensionStatuses(),
					});
				},
			};
		});
	});
}
