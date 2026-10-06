/**
 * Compact call rows (lib/tool-call-render.ts): Explore, Agent, timer and
 * context_handoff each register a tool renderer resolver, because pi otherwise
 * prints every argument as key=value — the full prompt / handoff body on the
 * call row. The rows must stay one short line whatever the arguments hold, cope
 * with partial arguments while the call is still streaming, and apply whether
 * or not the tool is registered (resolvers also draw unregistered tools).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as exploreModule from "../explore.ts";
import * as subagentModule from "../subagent.ts";
import * as timerModule from "../timer.ts";
import { AGENT_TOOL, EXPLORE_TOOL } from "../lib/child-session.ts";
import { createCapSession } from "../lib/context-cap-session.ts";
import { handoffCallSummary, registerHandoffTool } from "../lib/context-cap-tool.ts";
import { CONTEXT_CAP_TOOL_NAME } from "../lib/env.ts";
import {
	CALL_SUMMARY_MAX,
	childCallSummary,
	oneLine,
	registerCompactCallRenderer,
	renderCompactCall,
} from "../lib/tool-call-render.ts";

type Tool = ToolRenderers & { name: string };
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

/** What an extension registered: its tools and its renderer resolvers. */
interface Registered {
	tools: Map<string, Tool>;
	resolvers: ToolRendererResolver[];
}

function stubPi(): Registered & { pi: Record<string, unknown> } {
	const tools = new Map<string, Tool>();
	const resolvers: ToolRendererResolver[] = [];
	const pi = {
		registerTool: (tool: Tool) => void tools.set(tool.name, tool),
		registerToolRenderer: (resolver: ToolRendererResolver) => void resolvers.push(resolver),
		registerShortcut: () => undefined,
		registerCommand: () => undefined,
		on: () => undefined,
	};
	return { pi, tools, resolvers };
}

function registered(extension: ExtensionFn): Registered {
	const stub = stubPi();
	extension(stub.pi);
	return stub;
}

/** pi's ExtensionRunner.resolveToolRenderers: resolvers in order, then `base`. */
function resolve(resolvers: ToolRendererResolver[], name: string, base: () => ToolRenderers | undefined) {
	const at = (i: number): ToolRenderers | undefined =>
		i < resolvers.length ? resolvers[i]!(name, () => at(i + 1)) : base();
	return at(0);
}

/** The call row pi would draw for `name`, the registered tool as the base like pi's own lookup. */
function renderCallOf({ tools, resolvers }: Registered, name: string): (args: unknown) => string {
	const renderCall = resolve(resolvers, name, () => tools.get(name))?.renderCall;
	assert.ok(renderCall, `${name} must resolve to a renderCall`);
	return (args) => renderCall(args, theme, {} as never).render(200).join("\n").trimEnd();
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
		const render = renderCallOf(registered(defaultExport(module)), name);
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
	const render = renderCallOf(registered(defaultExport(timerModule)), "timer");
	assert.equal(render({ action: "set", seconds: 300, name: "build" }), "<toolTitle>*timer*</> <muted>set 300s · build</>");
	assert.equal(render({ action: "set", seconds: 45 }), "<toolTitle>*timer*</> <muted>set 45s</>");
	assert.equal(render({ action: "cancel" }), "<toolTitle>*timer*</> <muted>cancel</>");
	assert.equal(render({}), "<toolTitle>*timer*</>");
});

test("context_handoff call row: line count, never the handoff body", () => {
	const stub = stubPi();
	registerHandoffTool(stub.pi as never, createCapSession({ sendUserMessage: () => undefined }));
	const render = renderCallOf(stub, CONTEXT_CAP_TOOL_NAME);
	assert.equal(
		render({ markdown: "## Current Task\nBODY-SENTINEL\n\n## Next\n- x\n" }),
		`<toolTitle>*${CONTEXT_CAP_TOOL_NAME}*</> <muted>(5 lines)</>`,
	);
	assert.equal(handoffCallSummary("one"), "(1 line)");
	assert.equal(handoffCallSummary("   "), "");
	assert.equal(handoffCallSummary(undefined), "");
});

test("the tools carry no renderCall of their own: the row comes from the resolver", () => {
	for (const module of [exploreModule, subagentModule, timerModule]) {
		const { tools } = registered(defaultExport(module));
		for (const tool of tools.values()) assert.equal(tool.renderCall, undefined, tool.name);
	}
});

test("resolver keeps the registered tool's other renderers (Explore renderResult)", () => {
	const explore = registered(defaultExport(exploreModule));
	const tool = explore.tools.get(EXPLORE_TOOL);
	assert.ok(tool?.renderResult);
	const resolved = resolve(explore.resolvers, EXPLORE_TOOL, () => tool);
	assert.equal(resolved?.renderResult, tool.renderResult);
	assert.ok(resolved?.renderCall);
});

test("resolver draws the row when the tool is not registered (resumed session, kill switch)", () => {
	const prior = process.env.PI_EXPLORE_DISABLE;
	process.env.PI_EXPLORE_DISABLE = "1";
	try {
		const explore = registered(defaultExport(exploreModule));
		assert.equal(explore.tools.size, 0, "kill switch: no tool");
		const render = renderCallOf({ tools: new Map(), resolvers: explore.resolvers }, EXPLORE_TOOL);
		assert.equal(render({ description: "old call" }), `<toolTitle>*${EXPLORE_TOOL}*</> <muted>old call</>`);
	} finally {
		if (prior === undefined) delete process.env.PI_EXPLORE_DISABLE;
		else process.env.PI_EXPLORE_DISABLE = prior;
	}
});

test("registerCompactCallRenderer: other names fall through to next(); an existing renderCall wins", () => {
	const stub = stubPi();
	registerCompactCallRenderer(stub.pi as never, "mine", () => "summary");
	const other: ToolRenderers = { renderShell: "self" };
	assert.equal(resolve(stub.resolvers, "read", () => other), other, "non-matching name: next() untouched");
	assert.equal(resolve(stub.resolvers, "read", () => undefined), undefined);
	const theirs: ToolRenderers["renderCall"] = () => {
		throw new Error("not called");
	};
	const filled = resolve(stub.resolvers, "mine", () => ({ renderShell: "self", renderCall: theirs }));
	assert.equal(filled?.renderCall, theirs, "fills in only");
	assert.equal(filled?.renderShell, "self");
});
