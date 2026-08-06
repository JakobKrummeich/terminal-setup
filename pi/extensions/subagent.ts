import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_TOOL,
	inChildSession,
	openChildView,
	renderChildResult,
	resetChildState,
	runChildTool,
	WATCH_KEY,
	watchTarget,
} from "./lib/child-session.ts";

const TOOL_DESCRIPTION = `Delegate a task to a fresh agent session that works autonomously and reports back.

The agent starts with no memory of this conversation, so the prompt must be self-contained.
It has the same tools, skills and project context you do, and runs in the same working directory.
Only its final message comes back to you, so ask for whatever you need in that one reply.
For cheap readonly lookups, both you and the agents you spawn can use the Explore tool
instead of burning context (yours or an Agent delegation) on them.

Agents run one at a time: a second call while one is running is rejected, so never emit two Agent
calls in the same message. Delegate one sizeable, self-contained track, wait for its result, then
decide what comes next.

You don't need the user's permission to delegate. But delegation is not free: the agent
re-establishes context, re-explores and reports back, and you then read its report. Delegate work
that is genuinely independent and large enough to justify a fresh context:
- Implementation of a defined task, especially multi-file work or edit/test/fix loops.
- Verification and review of work that is already done. Default to this generator-verifier split:
  a fresh agent that did not write the code catches what you would skim past.
- Long mechanical grind: migrations, renames, repetitive fixes across many files.

Before spawning, check:
- Small and bounded — a few reads, one search, a short edit? Do it inline.
- Do not split one modest job across several agents; they queue up and each pays full context cost.
- Keep spawn counts low: one well-briefed agent beats several loosely-briefed ones.
- Commit to the delegation. Do not redo its work while it runs, or re-derive its findings after.

Trust but verify: the agent's summary says what it meant to do, not necessarily what it did. When
it writes or edits code, check the actual changes before reporting the work as done.

Keep for yourself:
- Planning and spec work. Delegate the legwork that feeds a plan; write the plan yourself.
- Synthesis. Never delegate understanding — do not write "based on your findings, fix the bug".
  Digest the results and hand over concrete paths, lines and changes.
- Single known-file edits and targeted greps. Just do them.

Briefing: lookups — hand over the exact command. Investigations — hand over the question, since
prescribed steps become dead weight when the premise is wrong.

The agent may come back with a clarifying question instead of a result. That is normal: answer
it yourself by calling this tool again with resume_id set to the id in the result, which
continues the same session with its context intact. You stand in for the user.`;

// Prepended to the first prompt of a fresh child. Children are otherwise clones of the parent —
// same system prompt, same skills — so this is the only place they learn they are delegates and
// who reads their output.
const CHILD_CONTRACT = `You are a delegated agent. Your final message is the only thing the caller
sees — it goes to another agent, not to a human. The 10-line response limit does not apply to it.

- Never write findings, summaries or reports to .md files. Return them as your final message.
  (Files written as input to another tool are fine.)
- Use absolute paths. Include code snippets only when the exact text is load-bearing — a bug you
  found, a signature the caller needs. Do not recap code you merely read.
- Complete the task fully. Don't gold-plate, don't leave it half-done.
- You may use the timer tool and end your turn while waiting; the caller keeps waiting for you and
  gets your message after the wake-up. Cancel any timer you no longer need before you finish.
- Stay in scope. Note anything out of scope in one sentence; don't fix it.
- Report truthfully: if tests fail, say so with the output; if you skipped a step, say that.
- If you committed, list the paths and commit hashes.
- If the task is ambiguous, pick the most likely reading and state your assumption — or ask the
  caller a single question instead of guessing; it can answer and resume you.

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
		description: "Watch the running agent",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
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
