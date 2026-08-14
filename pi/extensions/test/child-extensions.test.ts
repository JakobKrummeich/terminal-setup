/**
 * Which extensions a spawned child session loads (lib/child-session.ts,
 * childResourceLoader).
 *
 * createAgentSession does not inherit the parent process's CLI flags: called bare
 * it auto-discovers <agentDir>/extensions and <cwd>/.pi/extensions. That is wrong
 * wherever the parent deliberately ran with `-ne -e <paths>`: the podman-hands
 * devcontainer setup (devcontainer/start-devcontainer.sh) starts host pi that way
 * so every file/shell tool executes inside the container, and a bare child would
 * silently fall back to pi's builtin bash/read/write/edit and act on the HOST,
 * outside the sandbox. The launcher exports PI_CHILD_EXTENSIONS with the same
 * paths; the child must then load exactly those and nothing else.
 *
 * Observed through the real runChildTool: the child's LLM call carries the tool
 * list, so a marker tool registered by an extension proves which set was loaded.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Children resolve their agent dir and session dir from the environment; point
// both at temp dirs so tests never load the live ~/.pi/agent extensions.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-childext-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-childext-sessions-"));
// No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests
// and hang the test process.
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { sleep, textStep, type ResponseStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Registered by the extension the launcher lists in PI_CHILD_EXTENSIONS. */
const MARKER_EXPLICIT = "marker_explicit";
/** Registered by an extension sitting in the auto-discovered <agentDir>/extensions. */
const MARKER_DISCOVERED = "marker_discovered";

/**
 * Write an extension registering one no-op tool, and return its path. The tool's
 * presence in the child's tool list is the only thing under observation.
 */
function writeMarkerExtension(dir: string, toolName: string): string {
	mkdirSync(dir, { recursive: true });
	// Generated outside the repo, so the bare "typebox" import only resolves if a
	// node_modules is reachable by walking up from the file — test/run.sh builds
	// exactly such a symlink farm next to the extensions.
	try {
		symlinkSync(path.join(EXT_DIR, "node_modules"), path.join(dir, "node_modules"));
	} catch {} // already linked (second extension in the same dir)
	const file = path.join(dir, `${toolName}.ts`);
	writeFileSync(
		file,
		`import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: ${JSON.stringify(toolName)},
		label: ${JSON.stringify(toolName)},
		description: "test marker",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	});
}
`,
	);
	return file;
}

const explicitExtension = writeMarkerExtension(
	mkdtempSync(path.join(tmpdir(), "pi-childext-explicit-")),
	MARKER_EXPLICIT,
);
writeMarkerExtension(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), MARKER_DISCOVERED);

// The children's rendering path (ChildView) needs an initialized theme.
initTheme(undefined, false);

const CHILD_OPTIONS = {
	kind: "explorer",
	busyGroup: "child-extensions-test",
	// Extension tools are inactive unless allowlisted; both markers are listed so
	// the tool list reflects which extension actually registered its tool.
	tools: [MARKER_EXPLICIT, MARKER_DISCOVERED],
	excludeTools: [],
};

/**
 * Fake ExtensionContext whose model runtime answers with one scripted text reply
 * and records the tool names each LLM call was given.
 */
async function makeCtx(toolNames: string[][]): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-childext-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		toolNames.push((context?.tools ?? []).map((tool: { name: string }) => tool.name));
		const scripted = textStep("done") as ResponseStep;
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(20);
			output.content = [{ type: "text", text: (scripted as { text: string }).text }];
			output.stopReason = "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		})();
		return stream;
	};
	return {
		cwd: dir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
		// A failed extension load would otherwise only be notified and swallowed,
		// leaving a missing marker tool to look like the behaviour under test.
		ui: {
			notify: (message: string) => {
				throw new Error(message);
			},
		},
	} as unknown as ExtensionContext;
}

/** Tool names the freshly spawned child handed to the LLM on its first turn. */
async function spawnChildTools(): Promise<string[]> {
	const calls: string[][] = [];
	const ctx = await makeCtx(calls);
	try {
		await runChildTool({ prompt: "which extensions do you have?" }, CHILD_OPTIONS, undefined, undefined, ctx);
		return calls[0] ?? [];
	} finally {
		for (const record of liveChildren.values()) record.session.dispose();
		liveChildren.clear();
	}
}

test("PI_CHILD_EXTENSIONS set: the child loads exactly those extensions, discovery is off", async () => {
	// Read per createChildSession call, so setting it around the spawn is enough.
	process.env.PI_CHILD_EXTENSIONS = explicitExtension;
	let tools: string[];
	try {
		tools = await spawnChildTools();
	} finally {
		delete process.env.PI_CHILD_EXTENSIONS;
	}
	assert.ok(tools.includes(MARKER_EXPLICIT), `listed extension not loaded: ${tools.join(", ")}`);
	assert.ok(!tools.includes(MARKER_DISCOVERED), "auto-discovery must be off — this is the sandbox escape");
});

test("PI_CHILD_EXTENSIONS unset: the child keeps auto-discovering <agentDir>/extensions", async () => {
	delete process.env.PI_CHILD_EXTENSIONS;
	const tools = await spawnChildTools();
	assert.ok(tools.includes(MARKER_DISCOVERED), `discovered extension not loaded: ${tools.join(", ")}`);
});
