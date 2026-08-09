import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_TOOL,
	inChildSession,
	liveChildren,
	openChildPicker,
	openChildView,
	renderChildResult,
	resetChildState,
	runChildTool,
	WATCH_KEY,
	watchTarget,
} from "./lib/child-session.ts";

const TOOL_DESCRIPTION = `Delegate a task to a fresh agent session that works autonomously and reports back.

The agent has the same tools, skills and project context you do, in the same working directory,
but no memory of this conversation: the prompt must be self-contained. Only its final message
comes back, so ask for everything you need in that one reply. For cheap readonly lookups, use
the Explore tool instead (the agents you spawn have it too).

Agents run one at a time — a second call while one runs is rejected, so never emit two Agent
calls in one message, and do not split one modest job across several agents. Delegation is not
free; delegate work that is independent and large enough to justify a fresh context:
- Implementation of a defined task, especially multi-file work or edit/test/fix loops.
- Verification and review of finished work — a fresh agent catches what its author skims past.
- Long mechanical grind: migrations, renames, repetitive fixes across many files.

Do inline instead: small bounded jobs — a few reads, one search, a short edit.
Keep for yourself: planning and spec work; synthesis — never "based on your findings, fix the
bug", digest results yourself and hand over concrete paths, lines and changes; single
known-file edits and targeted greps.

You don't need the user's permission to delegate. Commit to the delegation: do not redo its
work while it runs or re-derive its findings after. Trust but verify — when the agent changed
code, check the actual changes before reporting the work done. Briefing: for lookups hand over
the exact command; for investigations hand over the question, not prescribed steps.

The agent may return a clarifying question instead of a result. Answer it yourself — you stand
in for the user — by calling this tool again with resume_id set to the id in the result, which
continues that session with its context intact.`;

// Prepended to the first prompt of a fresh child. Children are otherwise clones of the parent —
// same system prompt, same skills — so this is the only place they learn they are delegates and
// who reads their output.
const CHILD_CONTRACT = `You are a delegated agent. Your final message is the only thing the caller
sees, and the caller is another agent, not a human. Response-length limits from the system prompt
do not apply to that final message.

- Report findings in the final message itself — never in .md report files. (Files written as
  input to another tool are fine.)
- Use absolute paths. Include code snippets only when the exact text is load-bearing — a bug you
  found, a signature the caller needs. Do not recap code you merely read.
- Complete the task fully. Don't gold-plate, don't leave it half-done.
- You may use the timer tool and end your turn while waiting; the caller keeps waiting and gets
  your message after the wake-up. Cancel timers you no longer need before you finish.
- Stay in scope. Note anything out of scope in one sentence; don't fix it.
- Report truthfully: if tests fail, say so with the output; if you skipped a step, say that.
- If you committed, list the paths and commit hashes.
- Ambiguity you can settle from the repo, settle. Details cheap to revise: assume, state the
  assumption. Scope, approach, or anything hard to undo: ask the caller one question instead —
  never guess; it can answer and resume you.

Structure the final message as:
1. What you did or found — specific: file paths, line numbers, snippets.
2. Summary: one sentence the caller can relay.`;

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
			// Agents may not spawn agents: nesting is capped at one layer, structurally.
			return runChildTool(
				params,
				{ kind: "agent", busyGroup: "agent", excludeTools: [AGENT_TOOL], promptPrefix: CHILD_CONTRACT },
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
		description: "Watch agent sessions (picker when several; running and finished)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			// Several children: open the picker dashboard; one child: jump straight in.
			if (liveChildren.size > 1) {
				await openChildPicker(ctx);
				return;
			}
			const record = watchTarget();
			if (!record) {
				ctx.ui.notify("No agent has run yet in this session.", "info");
				return;
			}
			await openChildView(ctx, record);
		},
	});

	pi.on("session_shutdown", () => {
		// Counters too, not just records: the busy latch is normally released by each
		// tool call's finally, but a shutdown mid-call must not strand a slot forever.
		resetChildState();
	});
}
