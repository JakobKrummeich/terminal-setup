import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CONTEXT_CAP_STATUS_KEY } from "./lib/env.ts";

export interface FooterData {
	cost: number;
	usingSubscription: boolean;
	cwd: string;
	branch: string | null;
	sessionName?: string;
	modelId?: string;
	reasoning: boolean;
	thinkingLevel: string;
	statuses: ReadonlyMap<string, string>;
}

export function renderFooterLines(width: number, theme: Theme, data: FooterData): string[] {
	// Cost, right-aligned on line 1 (context usage lives in the context-cap status line)
	const costStr = `$${data.cost.toFixed(3)}${data.usingSubscription ? " (sub)" : ""}`;

	// Line 1: pwd with git branch, cost right-aligned
	let pwd = data.cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) {
		pwd = `~${pwd.slice(home.length)}`;
	}
	const branch = data.branch;
	if (branch) pwd = `${pwd} (${branch})`;

	const sessionName = data.sessionName;
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
	const modelName = data.modelId || "no-model";
	let modelDisplay = modelName;
	if (data.reasoning) {
		const thinkingLevel = data.thinkingLevel;
		modelDisplay =
			thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}

	// Line 2: extension statuses (context size) left, model right.
	// Status has priority — never truncated; model truncates instead.
	// context-cap (context size) gets prominent color; other statuses stay dim.
	const clean = (text: string) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	const extensionStatuses = data.statuses;
	const capStatus = clean(extensionStatuses.get(CONTEXT_CAP_STATUS_KEY) ?? "");
	const otherStatuses = Array.from(extensionStatuses.entries())
		.filter(([name]) => name !== CONTEXT_CAP_STATUS_KEY)
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
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// Cumulative cost from all session entries
					let cost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const message = entry.message as AssistantMessage;
							cost += message.usage.cost.total;
						}
					}
					return renderFooterLines(width, theme, {
						cost,
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
