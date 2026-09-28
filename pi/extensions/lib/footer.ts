// Footer layout (renderFooterLines) shared by the main session's footer extension
// and the F2 child watch view, which renders each child's footer with it.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CONTEXT_CAP_STATUS_KEY } from "./env.ts";

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
	return [theme.fg("dim", footerLine1(width, data)), footerLine2(width, theme, data)];
}

// --- line 1: pwd (git branch, session name) left, cost right-aligned ----------

function footerLine1(width: number, data: FooterData): string {
	// Context usage lives in the context-cap status on line 2, not here.
	const costStr = `$${data.cost.toFixed(3)}${data.usingSubscription ? " (sub)" : ""}`;
	// Leave room for cost + one separating space when truncating pwd
	const pwdMax = Math.max(1, width - costStr.length - 1);
	const pwd = truncateMiddle(pwdLabel(data), pwdMax);
	const gap = Math.max(1, width - pwd.length - costStr.length);
	return pwd + " ".repeat(gap) + costStr;
}

function pwdLabel(data: FooterData): string {
	let pwd = data.cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) {
		pwd = `~${pwd.slice(home.length)}`;
	}
	if (data.branch) pwd = `${pwd} (${data.branch})`;
	if (data.sessionName) pwd = `${pwd} • ${data.sessionName}`;
	return pwd;
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2) - 2;
	if (half > 1) return `${text.slice(0, half)}...${text.slice(-(half - 1))}`;
	return text.slice(0, max);
}

// --- line 2: extension statuses left, model + thinking level right -----------
// Status has priority — never truncated; model truncates instead.
// context-cap (context size) gets prominent color; other statuses stay dim.

function footerLine2(width: number, theme: Theme, data: FooterData): string {
	const { capStatus, otherStatuses } = statusTexts(data.statuses);
	// Plain-text layout math first; colors applied at assembly.
	const statusPlain = [capStatus, otherStatuses].filter(Boolean).join(" ");
	const modelMax = width - statusPlain.length - (statusPlain ? 1 : 0);
	const modelDisplay = fitModel(modelLabel(data), modelMax);
	if (!statusPlain) return theme.fg("dim", modelDisplay);
	const statusColored = [
		capStatus ? theme.fg("accent", capStatus) : "",
		otherStatuses ? theme.fg("dim", otherStatuses) : "",
	]
		.filter(Boolean)
		.join(" ");
	if (!modelDisplay) return statusColored;
	const gap = Math.max(1, width - statusPlain.length - modelDisplay.length);
	return statusColored + " ".repeat(gap) + theme.fg("dim", modelDisplay);
}

function cleanStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** The context-cap status, and every other status sorted by extension name. */
function statusTexts(statuses: ReadonlyMap<string, string>): { capStatus: string; otherStatuses: string } {
	const capStatus = cleanStatus(statuses.get(CONTEXT_CAP_STATUS_KEY) ?? "");
	const otherStatuses = Array.from(statuses.entries())
		.filter(([name]) => name !== CONTEXT_CAP_STATUS_KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => cleanStatus(text))
		.join(" ");
	return { capStatus, otherStatuses };
}

function modelLabel(data: FooterData): string {
	const modelName = data.modelId || "no-model";
	if (!data.reasoning) return modelName;
	return data.thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${data.thinkingLevel}`;
}

function fitModel(model: string, max: number): string {
	if (model.length <= max) return model;
	return max >= 4 ? truncateToWidth(model, max, "...") : "";
}
