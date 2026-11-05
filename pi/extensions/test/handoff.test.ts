/**
 * The handoff texts, one row per cycle origin (lib/context-cap-messages.ts — the
 * "prompt matrix"), and the persisted wire format. /handoff and the caps ask for
 * the SAME `context_handoff` call with the same document spec (sections + line
 * budget from lib/handoff-writer.ts, so the CONTEXT_CAP_SCHEMA lever governs
 * both); only the words around it differ. D7: the old /handoff prompt banned the
 * very tool a cap demand asked for in the same window — no text may ban it now.
 * The flows themselves are pinned in context-cap-manual.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as contextCapModule from "../context-cap.ts";
import {
	demandMessage,
	MANUAL_DEMAND,
	recordedMessage,
	reminderMessage,
} from "../lib/context-cap-messages.ts";
import type { CycleOrigin } from "../lib/context-cap-decide.ts";
import { CONTEXT_CAP_TOOL_NAME, type ResolvedTriggers } from "../lib/env.ts";
import { handoffLineBudget, handoffSections } from "../lib/handoff-writer.ts";
import {
	HANDOFF_DEMAND_TYPE,
	HANDOFF_PREAMBLE,
	HANDOFF_SUMMARY_TYPE,
	SWAP_MARKER_TYPE,
} from "../lib/message-types.ts";

// ESM/CJS interop unwrap, same pattern as kill-switch.test.ts.
type ExtensionFn = (pi: unknown) => void;
function defaultExport(module: unknown): ExtensionFn {
	const d = (module as { default: ExtensionFn | { default: ExtensionFn } }).default;
	return typeof d === "function" ? d : d.default;
}

const CAPS = { soft: 1234, hard: 5678 } as ResolvedTriggers;
const CAP_ORIGINS: CycleOrigin[] = ["soft", "silent", "hard-jump"];

test("every demand asks for the tool with the shared document spec — and none bans it (D7)", () => {
	for (const origin of [...CAP_ORIGINS, "manual"] as CycleOrigin[]) {
		const text = demandMessage(origin, 999, CAPS);
		assert.ok(text.includes(`Call the \`${CONTEXT_CAP_TOOL_NAME}\` tool`), `${origin}: names the tool`);
		assert.ok(text.includes(handoffSections()), `${origin}: the shared section list, verbatim`);
		assert.ok(text.includes(`~${handoffLineBudget()} lines`), `${origin}: the shared line budget`);
		assert.doesNotMatch(text, /do NOT call any tools|not even context_handoff|as your reply/, origin);
	}
});

test("cap demands carry the [context-cap] prefix and the numbers; /handoff carries neither", () => {
	for (const origin of CAP_ORIGINS) {
		const text = demandMessage(origin, 999, CAPS);
		assert.ok(text.startsWith("[context-cap] "), origin);
		assert.ok(text.includes("999") && text.includes("5678"), `${origin}: quotes the reading and the hard cap`);
	}
	assert.equal(demandMessage("manual", 999, CAPS), MANUAL_DEMAND);
	assert.ok(!MANUAL_DEMAND.includes("[context-cap]"));
	assert.ok(!/\d{3,}/.test(MANUAL_DEMAND.replace(handoffSections(), "")), "no cap numbers, no time pressure");
	assert.match(MANUAL_DEMAND, /A new session then starts from this document\.$/);
	assert.ok(!MANUAL_DEMAND.includes("Continue your work."), "the successor of /handoff does not auto-continue");
});

test("the three cap demands keep their own urgency", () => {
	assert.match(demandMessage("soft", 1, CAPS), /Finish your current logical unit of work first/);
	assert.match(demandMessage("silent", 1, CAPS), /This is your last turn before handoff/);
	assert.match(demandMessage("hard-jump", 1, CAPS), /EMERGENCY.*Do NOT start any new work/s);
});

test("reminders: [context-cap] prefix only for cap origins", () => {
	for (const origin of CAP_ORIGINS) {
		assert.ok(reminderMessage(origin, 1).startsWith("[context-cap] No handoff was recorded"), origin);
	}
	const manual = reminderMessage("manual", 2);
	assert.ok(manual.startsWith("No handoff was recorded"));
	assert.match(manual, /see the handoff instructions above.*\(reminder 2\/2\)/s);
});

test("tool result per ending: swap vs new session", () => {
	assert.match(recordedMessage("swap"), /your context is replaced immediately afterwards/);
	assert.match(recordedMessage("new-session"), /a new session starts from it/);
});

test("handoff wire format is pinned: preamble text and persisted customTypes", () => {
	// All writers/readers import these from lib/message-types.ts; the literals here
	// pin the persisted format itself. Session files on disk carry these strings —
	// renaming one orphans the handoff entries of every existing session.
	assert.equal(SWAP_MARKER_TYPE, "context-cap-swap");
	assert.equal(HANDOFF_SUMMARY_TYPE, "handoff-summary");
	assert.equal(HANDOFF_DEMAND_TYPE, "handoff-demand");
	assert.equal(
		HANDOFF_PREAMBLE,
		"You are continuing work from a previous session. The agent before you left you this information:",
	);
});

test("context-cap owns /handoff: the command and the tool register together", () => {
	const commands: string[] = [];
	const tools: string[] = [];
	const events: string[] = [];
	defaultExport(contextCapModule)({
		on: (name: string) => events.push(name),
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerToolRenderer: () => {},
		sendMessage: () => {},
	});
	assert.deepEqual(commands, ["handoff"]);
	assert.deepEqual(tools, [CONTEXT_CAP_TOOL_NAME]);
	for (const name of ["agent_before_settle", "agent_settled", "session_shutdown"]) {
		assert.ok(events.includes(name), `${name} handler registered`);
	}
});
