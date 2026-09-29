/**
 * Compact call rows (lib/tool-call-render.ts): Explore, Agent, timer and
 * context_handoff each bring a renderCall, because pi >= 0.99 otherwise prints
 * every argument as key=value — the full prompt / handoff body on the call row.
 * The rows must stay one short line whatever the arguments hold, and cope with
 * partial arguments while the call is still streaming.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import * as exploreModule from "../explore.ts";
import * as subagentModule from "../subagent.ts";
import * as timerModule from "../timer.ts";
import { AGENT_TOOL, EXPLORE_TOOL } from "../lib/child-session.ts";
import { createCapSession } from "../lib/context-cap-session.ts";
import { handoffCallSummary, registerHandoffTool } from "../lib/context-cap-tool.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";
import { CALL_SUMMARY_MAX, childCallSummary, oneLine, renderCompactCall } from "../lib/tool-call-render.ts";

type RenderCall = (args: unknown, theme: Theme, context: { lastComponent?: unknown }) => Text;
interface Tool {
	name: string;
	renderCall?: RenderCall;
}
type ExtensionFn = (pi: unknown) => void;

// Marks colour + bold so the assertions see which part got which style.
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

// Same ESM/CJS default-export unwrap as kill-switch.test.ts.
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

function registeredTools(extension: ExtensionFn): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	extension({
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerShortcut: () => undefined,
		registerCommand: () => undefined,
		on: () => undefined,
	});
	return tools;
}

function renderCallOf(extension: ExtensionFn, name: string): (args: unknown) => string {
	const renderCall = registeredTools(extension).get(name)?.renderCall;
	assert.ok(renderCall, `${name} must register a renderCall`);
	return (args) => renderCall(args, theme, {}).render(200).join("\n").trimEnd();
}

const LONG_PROMPT = `Investigate the whole thing.\n\n${"very long brief line ".repeat(40)}\nSECRET-TAIL`;

test("oneLine collapses whitespace and truncates with an ellipsis", () => {
	assert.equal(oneLine("  a\n\tb   c "), "a b c");
	const long = oneLine("x".repeat(200));
	assert.equal(long.length, CALL_SUMMARY_MAX);
	assert.ok(long.endsWith("…"));
	assert.equal(oneLine("abcdef", 4), "abc…");
});

test("renderCompactCall: bold title, muted summary, reuses the slot's component", () => {
	const first = renderCompactCall("Explore", "where is X", theme, {});
	assert.equal(first.render(200)[0]!.trimEnd(), "<toolTitle>*Explore*</> <muted>where is X</>");
	const again = renderCompactCall("Explore", "", theme, { lastComponent: first });
	assert.equal(again, first);
	assert.equal(again.render(200)[0]!.trimEnd(), "<toolTitle>*Explore*</>");
});

test("childCallSummary: description, else prompt start; resume marked; partial args tolerated", () => {
	assert.equal(childCallSummary({ prompt: "p", description: "find the bug" }), "find the bug");
	assert.equal(childCallSummary({ prompt: "  what calls foo?\nmore" }), "what calls foo?\nmore");
	assert.equal(childCallSummary({ prompt: "yes", resume_id: "explorer#3" }), "↻ explorer#3 · yes");
	assert.equal(childCallSummary({ resume_id: "agent#1" }), "↻ agent#1");
	assert.equal(childCallSummary({}), "");
	assert.equal(childCallSummary(undefined), "");
	assert.equal(childCallSummary({ prompt: 42 }), "");
});

for (const [label, module, name] of [
	["Explore", exploreModule, EXPLORE_TOOL],
	["Agent", subagentModule, AGENT_TOOL],
] as const) {
	test(`${label} call row: one line, label only — never the whole prompt`, () => {
		const render = renderCallOf(defaultExport(module), name);
		assert.equal(
			render({ prompt: LONG_PROMPT, description: "map the render path" }),
			`<toolTitle>*${name}*</> <muted>map the render path</>`,
		);
		const noLabel = render({ prompt: LONG_PROMPT });
		assert.equal(noLabel.split("\n").length, 1);
		assert.ok(!noLabel.includes("SECRET-TAIL"), "prompt must be truncated");
		assert.equal(render({}), `<toolTitle>*${name}*</>`, "streaming start: title only");
	});
}

test("timer call row: action, seconds and name", () => {
	const render = renderCallOf(defaultExport(timerModule), "timer");
	assert.equal(render({ action: "set", seconds: 300, name: "build" }), "<toolTitle>*timer*</> <muted>set 300s · build</>");
	assert.equal(render({ action: "set", seconds: 45 }), "<toolTitle>*timer*</> <muted>set 45s</>");
	assert.equal(render({ action: "cancel" }), "<toolTitle>*timer*</> <muted>cancel</>");
	assert.equal(render({}), "<toolTitle>*timer*</>");
});

test("context_handoff call row: line count, never the handoff body", () => {
	const tools = new Map<string, Tool>();
	registerHandoffTool({ registerTool: (tool) => void tools.set(tool.name, tool as Tool) }, createCapSession({
		sendUserMessage: () => undefined,
	}));
	const renderCall = tools.get(CONTEXT_CAP_TOOL_NAME)?.renderCall;
	assert.ok(renderCall);
	const row = renderCall({ markdown: "## Current Task\nBODY-SENTINEL\n\n## Next\n- x\n" }, theme, {})
		.render(200)
		.join("\n")
		.trimEnd();
	assert.equal(row, `<toolTitle>*${CONTEXT_CAP_TOOL_NAME}*</> <muted>(5 lines)</>`);
	assert.equal(handoffCallSummary("one"), "(1 line)");
	assert.equal(handoffCallSummary("   "), "");
	assert.equal(handoffCallSummary(undefined), "");
});
