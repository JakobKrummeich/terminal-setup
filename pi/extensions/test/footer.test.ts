/**
 * renderFooterLines: the two-line footer shared by the main session
 * (custom-footer.ts) and the F2 child watch view. Pins the layout rules: pwd
 * shortening/truncation, right-aligned cost, status-before-model priority on
 * line 2 (the model truncates, statuses never do).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type FooterData, renderFooterLines } from "../lib/footer.ts";

// Color tags instead of ANSI codes: the assertions show which segment got which color.
const theme = { fg: (color: string, text: string) => `[${color}]${text}[/]` } as unknown as Theme;

function footer(width: number, overrides: Partial<FooterData>): string[] {
	const data: FooterData = {
		cost: 0,
		usingSubscription: false,
		cwd: "/srv/app",
		branch: null,
		reasoning: false,
		thinkingLevel: "off",
		statuses: new Map(),
		...overrides,
	};
	const savedHome = process.env.HOME;
	process.env.HOME = "/home/u";
	try {
		return renderFooterLines(width, theme, data);
	} finally {
		process.env.HOME = savedHome;
	}
}

test("renderFooterLines: full data — ~ home, branch, session name, sub cost, sorted statuses", () => {
	const lines = footer(60, {
		cost: 0.1234,
		usingSubscription: true,
		cwd: "/home/u/proj",
		branch: "main",
		sessionName: "s1",
		modelId: "claude-x",
		reasoning: true,
		thinkingLevel: "high",
		statuses: new Map([
			["zeta", "Z  ok"],
			["context-cap", "12k/260k\n"],
			["alpha", "a\tb"],
		]),
	});
	assert.deepEqual(lines, [
		`[dim]~/proj (main) \u2022 s1${" ".repeat(30)}$0.123 (sub)[/]`,
		`[accent]12k/260k[/] [dim]a b Z ok[/]${" ".repeat(28)}[dim]claude-x \u2022 high[/]`,
	]);
});

test("renderFooterLines: minimal data — no model, no statuses, path outside HOME", () => {
	assert.deepEqual(footer(30, {}), [`[dim]/srv/app${" ".repeat(16)}$0.000[/]`, "[dim]no-model[/]"]);
});

test("renderFooterLines: reasoning model with thinking off", () => {
	assert.deepEqual(footer(30, { modelId: "m", reasoning: true })[1], "[dim]m \u2022 thinking off[/]");
});

test("renderFooterLines: long pwd is middle-truncated to leave room for the cost", () => {
	const lines = footer(30, { cost: 1.5, cwd: `/${"a".repeat(40)}`, branch: "br" });
	assert.equal(lines[0], `[dim]/aaaaaaaa...aaa (br)${" ".repeat(4)}$1.500[/]`);
});

test("renderFooterLines: very narrow width hard-cuts the pwd", () => {
	assert.equal(footer(10, {})[0], "[dim]/sr $0.000[/]");
});

test("renderFooterLines: statuses win over the model — model truncates, then disappears", () => {
	const statuses = new Map([["context-cap", "12k/260k"]]);
	// pi-tui's truncateToWidth emits SGR resets around the ellipsis.
	assert.equal(
		footer(20, { modelId: "claude-opus-4", statuses })[1],
		"[accent]12k/260k[/] [dim]claude-o\u001b[0m...\u001b[0m[/]",
	);
	assert.equal(footer(10, { modelId: "claude-opus-4", statuses })[1], "[accent]12k/260k[/]");
});

test("renderFooterLines: non-cap statuses alone stay dim", () => {
	assert.equal(
		footer(30, { modelId: "m", statuses: new Map([["timer", "2 timers"]]) })[1],
		`[dim]2 timers[/]${" ".repeat(21)}[dim]m[/]`,
	);
});
