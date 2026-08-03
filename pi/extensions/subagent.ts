import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_TOOL,
	inChildSession,
	liveChildren,
	openChildView,
	renderChildResult,
	runChildTool,
	WATCH_KEY,
	watchTarget,
} from "./lib/child-session.ts";

const TOOL_DESCRIPTION = `Delegate a task to a fresh agent session that works autonomously and reports back.

The agent starts with no memory of this conversation, so the prompt must be self-contained.
It has the same tools, skills and project context you do, and runs in the same working directory.
Only its final message comes back to you, so ask for whatever you need in that one reply.

Use this proactively, without being asked, for:
- Implementation of a defined task, especially multi-file work or edit/test/fix loops.
- Verification and review of work that is already done.
- Long mechanical grind: migrations, renames, repetitive fixes across many files.

Keep for yourself:
- Planning and spec work. Delegate the legwork that feeds a plan; write the plan yourself.
- Synthesis. Never delegate understanding — do not write "based on your findings, fix the bug".
  Digest the results and hand over concrete paths, lines and changes.
- Single known-file edits and targeted greps. Just do them.

The agent may come back with a clarifying question instead of a result. That is normal: answer
it yourself by calling this tool again with resume_id set to the id in the result, which
continues the same session with its context intact. You stand in for the user.`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: AGENT_TOOL,
		label: "Agent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The self-contained brief for the agent — or, with resume_id, your answer to its question.",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Short 3-5 word label for this task, shown in the UI. Always pass it for a new agent; on resume it is optional.",
				}),
			),
			resume_id: Type.Optional(
				Type.String({
					description:
						"Continue an existing agent session (id from a previous result) instead of starting a new one.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Agents may not spawn agents, but they keep Explorer: exploration stays
			// available at every depth, full delegation does not.
			return runChildTool(
				params,
				{ kind: "agent", excludeTools: [AGENT_TOOL] },
				signal,
				onUpdate,
				ctx,
			);
		},
		renderResult(result, _options, theme, context) {
			return renderChildResult(result, theme, context);
		},
	});

	if (inChildSession()) return;

	pi.registerShortcut(WATCH_KEY, {
		description: "Watch the running agent or explorer",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const record = watchTarget();
			if (!record) {
				ctx.ui.notify("No agent or explorer has run yet in this session.", "info");
				return;
			}
			await openChildView(ctx, record);
		},
	});

	pi.on("session_shutdown", () => {
		liveChildren.clear();
	});
}
