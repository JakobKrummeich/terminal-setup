/**
 * caveman-prompt cuts pi's assembled system prompt at the start of the tool list
 * and drops the pi-documentation block. pi changed that prompt's shape in 0.86
 * (flat prose -> ordered XML sections), which silently disabled the extension:
 * the old "Available tools:" marker was gone, the handler returned undefined and
 * no caveman rules reached the model.
 *
 * So both shapes are pinned here as fixtures, plus a live check against whatever
 * pi is installed — that one fails loudly if a future pi changes the shape again.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as cavemanModule from "../caveman-prompt.ts";
import { cavemanize, findToolsMarker } from "../caveman-prompt.ts";

/**
 * This test dir is ESM ("type": "module") but ../caveman-prompt.ts is checked as
 * CJS, so tsc sees the default export behind an interop wrapper while node's ESM
 * runtime hands it over directly. Unwrap whichever shape shows up (same dance as
 * explore.test.ts).
 */
type ExtensionFn = (pi: unknown) => void;
const defaultExport = (cavemanModule as unknown as { default: ExtensionFn | { default: ExtensionFn } }).default;
const cavemanExtension: ExtensionFn = typeof defaultExport === "function" ? defaultExport : defaultExport.default;

const PREAMBLE_START = "# RULE HOW TO RESPOND — ALWAYS ACTIVE";

/** pi <= 0.85: one flat string. */
const FLAT_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read the contents of a file.
- bash: Execute a bash command.

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /pi/README.md
- Additional docs: /pi/docs
- Examples: /pi/examples (extensions, custom tools, SDK)

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/repo/AGENTS.md">
rules go here
</project_instructions>

</project_context>

Current working directory: /repo`;

/** pi >= 0.86: untagged preamble + tagged sections joined by blank lines. */
const SECTIONED_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read: Read the contents of a file.
- bash: Execute a bash command.

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Be concise in your responses
</rules>

<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /pi/README.md
- Additional docs: /pi/docs
- Examples: /pi/examples (extensions, custom tools, SDK)
</docs>

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/repo/AGENTS.md">
rules go here
</project_instructions>
</project_context>

<cwd>
/repo
</cwd>`;

for (const [shape, prompt, toolsMarker] of [
	["flat (pi <= 0.85)", FLAT_PROMPT, "Available tools:"],
	["sectioned (pi >= 0.86)", SECTIONED_PROMPT, "<tools>"],
] as const) {
	test(`${shape}: intro replaced, dynamic sections kept, pi docs dropped`, () => {
		const result = cavemanize(prompt);
		assert.ok(result, "prompt shape must be recognized");
		assert.ok(result.startsWith(PREAMBLE_START), "caveman rules must lead the prompt");
		assert.ok(!result.includes("You are an expert coding assistant"), "pi intro must be gone");
		assert.ok(!result.includes("Pi documentation"), "pi docs block must be stripped");
		assert.ok(!result.includes("<docs>"), "no dangling docs section tag");
		assert.ok(result.includes(toolsMarker), "tool list must survive");
		assert.ok(result.includes("- read: Read the contents of a file."), "tool entries must survive");
		assert.ok(result.includes("- Be concise in your responses"), "rules must survive");
		assert.ok(result.includes("/repo/AGENTS.md"), "project context must survive");
		assert.ok(result.includes("/repo"), "cwd must survive");
	});

	test(`${shape}: transform is idempotent`, () => {
		const once = cavemanize(prompt);
		assert.ok(once);
		assert.equal(cavemanize(once), once, "re-running over a cavemanized prompt must not change it");
	});
}

test("unrecognized prompt shape is left alone", () => {
	assert.equal(findToolsMarker("You are a helpful assistant."), -1);
	assert.equal(cavemanize("You are a helpful assistant."), undefined);
});

test("earliest marker wins, so quoted markers in context files cannot move the cut", () => {
	// A sectioned prompt whose project context happens to quote the old marker.
	const prompt = SECTIONED_PROMPT.replace("rules go here", "we document Available tools: like this");
	const result = cavemanize(prompt);
	assert.ok(result, "prompt shape must be recognized");
	assert.ok(result.startsWith(PREAMBLE_START));
	assert.ok(result.includes("<tools>\n- read:"), "cut must land on the tools section");
});

test("extension registers a before_agent_start handler that forces the prompt", async () => {
	const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
	cavemanExtension({
		on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => {
			handlers[event] = handler;
			return () => {}; // pi >= 0.86 hands back an unsubscribe function
		},
	} as any);

	const handler = handlers.before_agent_start;
	assert.ok(handler, "before_agent_start must be registered");

	const result: any = await handler({ type: "before_agent_start", systemPrompt: SECTIONED_PROMPT }, {});
	assert.ok(result.systemPrompt.startsWith(PREAMBLE_START));

	// Unknown shape: return nothing at all rather than an empty override.
	assert.equal(await handler({ type: "before_agent_start", systemPrompt: "custom prompt" }, {}), undefined);
});

test("the installed pi's real system prompt is still recognized", async () => {
	// Deep import by absolute path: pi's exports map hides dist/core, and this is
	// the check that catches the next prompt-shape change instead of shipping a
	// silently disabled extension.
	const modulePath = fileURLToPath(
		new URL("./node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url),
	);
	if (!existsSync(modulePath)) {
		// run.sh builds the symlink farm; a bare `node --test` run has no pi to check against.
		test.skip("pi package not linked (run ./run.sh)");
		return;
	}
	const { buildSystemPrompt } = await import(modulePath);
	const prompt: string = buildSystemPrompt({
		cwd: "/repo",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read the contents of a file.", bash: "Execute a bash command." },
	});

	assert.ok(prompt.includes("Pi documentation"), "fixture assumption: pi still ships a docs block");
	const result = cavemanize(prompt);
	assert.ok(result, "installed pi's prompt shape must be recognized — update TOOLS_MARKERS");
	assert.ok(result.startsWith(PREAMBLE_START));
	assert.ok(!result.includes("Pi documentation"), "docs block must be stripped — update PI_DOCS_RES");
	assert.ok(!result.includes("You are an expert coding assistant"), "pi intro must be gone");
	assert.ok(result.includes("- bash: Execute a bash command."), "tool list must survive");
});
