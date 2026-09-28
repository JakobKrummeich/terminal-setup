import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderFooterLines } from "./lib/footer.ts";

/** Cumulative cost from all session entries' assistant messages. */
function cumulativeCost(entries: readonly SessionEntry[]): number {
	let cost = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			cost += message.usage.cost.total;
		}
	}
	return cost;
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
						cost: cumulativeCost(ctx.sessionManager.getEntries()),
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
