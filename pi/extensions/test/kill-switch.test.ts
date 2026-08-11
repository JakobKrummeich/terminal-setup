/**
 * Kill-switch env vars for the context-cap impact study (~/context-cap-study/plan.html,
 * work item 1): a non-empty PI_SUBAGENT_DISABLE / PI_EXPLORE_DISABLE makes the
 * subagent / explore extension register NOTHING — no tool, no shortcut, no event
 * handlers — in main and child sessions alike (the bail precedes the child-session
 * branches, so one code path covers both).
 *
 * The extensions read the env inside their default export (call time, not module
 * load), so these tests import the modules once and toggle process.env per call
 * against a stub ExtensionAPI that records every registration.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as exploreModule from "../explore.ts";
import * as subagentModule from "../subagent.ts";
import { AGENT_TOOL, EXPLORE_TOOL } from "../lib/child-session.ts";

/** Stub ExtensionAPI: records registrations, ignores everything else. */
interface StubPi {
	registerTool: (tool: { name: string }) => void;
	registerShortcut: (key: unknown, options: unknown) => void;
	registerCommand: (name: string, options: unknown) => void;
	on: (event: string, handler: unknown) => void;
}

interface Recorded {
	pi: StubPi;
	tools: string[];
	shortcuts: unknown[];
	commands: string[];
	events: string[];
}

function recordingPi(): Recorded {
	const tools: string[] = [];
	const shortcuts: unknown[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	return {
		pi: {
			registerTool: (tool) => tools.push(tool.name),
			registerShortcut: (key) => shortcuts.push(key),
			registerCommand: (name) => commands.push(name),
			on: (event) => events.push(event),
		},
		tools,
		shortcuts,
		commands,
		events,
	};
}

type ExtensionFn = (pi: StubPi) => void;

// This test dir is ESM ("type": "module") but the extensions are checked as CJS,
// so tsc sees the default export behind an interop wrapper while node's ESM
// runtime hands it over directly. Unwrap whichever shape shows up (same pattern
// as explore.test.ts).
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

const subagentExtension = defaultExport(subagentModule);
const exploreExtension = defaultExport(exploreModule);

/**
 * Run fn with one env var forced to a value (undefined = unset), restoring the
 * prior value afterwards — the suite shares one process.env with other tests.
 */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const prior = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (prior === undefined) delete process.env[name];
		else process.env[name] = prior;
	}
}

test("PI_SUBAGENT_DISABLE set → subagent extension registers nothing", () => {
	withEnv("PI_SUBAGENT_DISABLE", "1", () => {
		const recorded = recordingPi();
		subagentExtension(recorded.pi);
		assert.deepEqual(recorded.tools, []);
		assert.deepEqual(recorded.shortcuts, []);
		assert.deepEqual(recorded.commands, []);
		assert.deepEqual(recorded.events, []);
	});
});

test("PI_SUBAGENT_DISABLE unset → subagent extension registers Agent tool + watch shortcut", () => {
	withEnv("PI_SUBAGENT_DISABLE", undefined, () => {
		const recorded = recordingPi();
		subagentExtension(recorded.pi);
		assert.deepEqual(recorded.tools, [AGENT_TOOL]);
		assert.equal(recorded.shortcuts.length, 1, "watch shortcut registered");
	});
});

test("PI_SUBAGENT_DISABLE empty string counts as unset (non-empty semantics)", () => {
	withEnv("PI_SUBAGENT_DISABLE", "", () => {
		const recorded = recordingPi();
		subagentExtension(recorded.pi);
		assert.deepEqual(recorded.tools, [AGENT_TOOL]);
	});
});

test("PI_EXPLORE_DISABLE set → explore extension registers nothing", () => {
	withEnv("PI_EXPLORE_DISABLE", "1", () => {
		const recorded = recordingPi();
		exploreExtension(recorded.pi);
		assert.deepEqual(recorded.tools, []);
		assert.deepEqual(recorded.shortcuts, []);
		assert.deepEqual(recorded.commands, []);
		assert.deepEqual(recorded.events, []);
	});
});

test("PI_EXPLORE_DISABLE unset → explore extension registers Explore tool", () => {
	withEnv("PI_EXPLORE_DISABLE", undefined, () => {
		const recorded = recordingPi();
		exploreExtension(recorded.pi);
		assert.deepEqual(recorded.tools, [EXPLORE_TOOL]);
	});
});
