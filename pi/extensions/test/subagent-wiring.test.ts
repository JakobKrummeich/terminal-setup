/**
 * subagent.ts's main-session wiring, driven through its registrations on a stub
 * ExtensionAPI (kill-switch.test.ts only pins THAT they register):
 *   - the F2 watch shortcut: no UI → nothing; no child yet → a notice; one child
 *     → straight into its view; several → the picker;
 *   - session_shutdown: drops the children, the busy latch and the watch cursor.
 *     The latch reset is a past fix (862a6c4): an Agent call still hanging at
 *     shutdown must not leave the Agent tool permanently "already running".
 *
 * Children are fake records driven through the real Agent tool (resume_id
 * path), so no model or session is needed. Each test file runs in its own
 * process, so the shared child state starts empty.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import * as subagentModule from "../subagent.ts";
import { AGENT_TOOL, liveChildren } from "../lib/child-session.ts";
import type { ChildRecord } from "../lib/child-types.ts";
import { ChildView } from "../lib/child-view.ts";
import { watchTarget } from "../lib/child-watch.ts";

initTheme(undefined, false); // ChildView renders with pi's theme

type Handler = (...args: unknown[]) => unknown;
type ToolResult = { content: Array<{ text?: string }>; details?: { error?: string } };
type AgentTool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

/** Load subagent.ts against a stub API; hand back the shortcut, the Agent tool and the event handlers. */
function loadSubagent() {
	const events = new Map<string, Handler>();
	const tools = new Map<string, AgentTool>();
	let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		registerTool: (tool: AgentTool) => void tools.set(tool.name, tool),
		registerShortcut: (_key: unknown, options: { handler: typeof shortcut }) => void (shortcut = options.handler),
		registerToolRenderer: () => undefined,
		on: (event: string, handler: Handler) => void events.set(event, handler),
	};
	// ESM/CJS default-export unwrap, as in kill-switch.test.ts.
	const d = (subagentModule as unknown as { default: Handler | { default: Handler } }).default;
	(typeof d === "function" ? d : d.default)(pi);
	assert.ok(shortcut, "watch shortcut registered");
	const agent = tools.get(AGENT_TOOL);
	assert.ok(agent, "Agent tool registered");
	return { shortcut, agent, events };
}

/** A finished, idle agent child in liveChildren; `prompt` decides how its next run goes. */
function addChild(id: string, prompt: () => Promise<void> = async () => {}, running = false): ChildRecord {
	const session = {
		isIdle: true,
		pendingMessageCount: 0,
		messages: [],
		prompt,
		waitForIdle: async () => {},
		subscribe: () => () => {},
		abort: async () => {},
		getSessionStats: () => ({ cost: 0 }),
		getContextUsage: () => undefined,
		sessionName: `agent#${id}`,
		// Empty session dir: agent-runs rows are skipped (appendEvent no-ops).
		sessionManager: { getEntries: () => [], getSessionDir: () => "" },
	};
	const view = new ChildView({ getToolDefinition: () => undefined } as never, tmpdir());
	const record = { id, kind: "agent", sid: `sid-${id}`, rootSid: "root", session, view, description: id };
	const child = { ...record, turns: 0, elapsedMs: 0, running } as unknown as ChildRecord;
	liveChildren.set(id, child);
	return child;
}

/** What one F2 press did: notices shown, and the first line of each overlay it opened. */
async function pressWatch(shortcut: (ctx: ExtensionContext) => Promise<void>, hasUI = true) {
	const notices: string[] = [];
	const opened: string[] = [];
	const ctx = {
		hasUI,
		cwd: tmpdir(),
		modelRegistry: { isUsingOAuth: () => false },
		ui: {
			notify: (message: string) => notices.push(message),
			custom(factory: Handler) {
				// Fullscreen mode: no alt-screen/mouse escapes on stdout. The overlay is
				// built for real; its first line tells the picker from a child's view.
				const tui = { mode: "fullscreen", terminal: { rows: 20, columns: 80 }, requestRender() {} };
				const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
				const overlay = factory(tui, theme, {}, () => {}) as { render(w: number): string[]; dispose(): void };
				opened.push(overlay.render(80)[0] ?? "");
				overlay.dispose(); // its 1s ticker would keep the process alive
				return Promise.resolve();
			},
		},
	} as unknown as ExtensionContext;
	await shortcut(ctx);
	return { notices, opened };
}

test("F2: no UI → nothing; no child → notice; one child → its view; several → the picker", async () => {
	const { shortcut } = loadSubagent();
	assert.deepEqual(await pressWatch(shortcut, false), { notices: [], opened: [] });
	assert.deepEqual(await pressWatch(shortcut), { notices: ["No agent has run yet in this session."], opened: [] });

	addChild("solo");
	const one = await pressWatch(shortcut);
	assert.deepEqual(one.opened, ["■ agent#solo · solo · 0 turns · finished"], "the only child's view header");

	addChild("second");
	assert.deepEqual((await pressWatch(shortcut)).opened, ["Agent sessions (2)"], "picker header");
	liveChildren.clear();
});

test("session_shutdown frees the Agent slot of a call still hanging, drops children and the F2 cursor", async () => {
	const { shortcut, agent, events } = loadSubagent();
	const run = (id: string) => agent.execute("call", { prompt: "go", resume_id: id }, undefined, undefined, {});
	addChild("hung", () => new Promise<void>(() => {})); // prompt() never returns
	void run("hung"); // holds the Agent slot for good
	addChild("next");
	assert.equal((await run("next")).details?.error, "child_busy", "precondition: the hung call holds the slot");
	liveChildren.delete("next");
	await pressWatch(shortcut); // one child → its view; the F2 cursor is now "hung"

	events.get("session_shutdown")!();

	assert.equal(liveChildren.size, 0, "children dropped");
	addChild("fresh");
	const result = await run("fresh");
	assert.equal(result.details?.error, undefined, "Agent tool usable again after shutdown");
	assert.match(result.content[0]?.text ?? "", /agent id: fresh/);
	// Cursor reset: with the old cursor ("hung") present again, F2 would move on to
	// the child after it ("done"); a fresh cursor starts at the first running child.
	liveChildren.clear();
	addChild("hung");
	addChild("done");
	addChild("live", undefined, true);
	assert.equal(watchTarget()?.id, "live");
	liveChildren.clear();
});
