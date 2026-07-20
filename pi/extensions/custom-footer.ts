import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// Cumulative cost from all session entries
					let totalCost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const message = entry.message as AssistantMessage;
							totalCost += message.usage.cost.total;
						}
					}

					// Cost, right-aligned on line 1 (context usage lives in the context-cap status line)
					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;

					// Line 1: pwd with git branch, cost right-aligned
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// Leave room for cost + one separating space when truncating pwd
					const pwdMax = Math.max(1, width - costStr.length - 1);
					if (pwd.length > pwdMax) {
						const half = Math.floor(pwdMax / 2) - 2;
						if (half > 1) {
							pwd = `${pwd.slice(0, half)}...${pwd.slice(-(half - 1))}`;
						} else {
							pwd = pwd.slice(0, pwdMax);
						}
					}
					const gap = Math.max(1, width - pwd.length - costStr.length);
					const line1 = pwd + " ".repeat(gap) + costStr;

					// Line 2: model + thinking level
					const modelName = ctx.model?.id || "no-model";
					let modelDisplay = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel();
						modelDisplay =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					// Line 2: extension statuses (context size) left, model right.
					// Status has priority — never truncated; model truncates instead.
					// context-cap (context size) gets prominent color; other statuses stay dim.
					const clean = (text: string) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
					const extensionStatuses = footerData.getExtensionStatuses();
					const capStatus = clean(extensionStatuses.get("context-cap") ?? "");
					const otherStatuses = Array.from(extensionStatuses.entries())
						.filter(([name]) => name !== "context-cap")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => clean(text))
						.join(" ");
					// Plain-text layout math first; colors applied at assembly.
					const statusPlain = [capStatus, otherStatuses].filter(Boolean).join(" ");
					const modelMax = width - statusPlain.length - (statusPlain ? 1 : 0);
					if (modelDisplay.length > modelMax) {
						modelDisplay = modelMax >= 4 ? truncateToWidth(modelDisplay, modelMax, "...") : "";
					}
					let line2 = theme.fg("dim", modelDisplay);
					if (statusPlain) {
						const statusColored = [
							capStatus ? theme.fg("accent", capStatus) : "",
							otherStatuses ? theme.fg("dim", otherStatuses) : "",
						]
							.filter(Boolean)
							.join(" ");
						const gap2 = Math.max(1, width - statusPlain.length - modelDisplay.length);
						line2 = modelDisplay
							? statusColored + " ".repeat(gap2) + theme.fg("dim", modelDisplay)
							: statusColored;
					}

					return [theme.fg("dim", line1), line2];
				},
			};
		});
	});
}
