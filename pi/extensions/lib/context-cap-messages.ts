/**
 * context-cap, the agent-facing handoff texts — one row per cycle origin
 * (the "prompt matrix"): the soft demand, the silent-stop demand, the one-jump
 * emergency demand, the /handoff demand, the reminders, and the tool result per
 * ending. lib/context-cap-demand.ts commits the demands and reminders as
 * boundary entries (customType HANDOFF_DEMAND_TYPE); the `context` handler
 * scrubs those behind the latest swap marker, so none needs a "if this looks
 * stale, ignore it" clause.
 *
 * Every text asks for the SAME thing: a `context_handoff` call whose markdown
 * follows the one document spec in lib/handoff-writer.ts (sections + line
 * budget, resolved once from the CONTEXT_CAP_SCHEMA lever) — the machine writer
 * produces that shape too. Only the words around it differ: cap origins carry
 * the WARNING_PREFIX and the cap numbers, /handoff carries neither and no time
 * pressure.
 */

import { type CycleEnding, type CycleOrigin, MAX_RETRIES } from "./context-cap-decide.ts";
import { WARNING_PREFIX } from "./context-cap-view.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_TOOL_NAME, type ResolvedTriggers } from "./env.ts";
import { handoffLineBudget, handoffSections } from "./handoff-writer.ts";

const DOC_SPEC = `Its \`markdown\` argument (plain markdown, NO YAML frontmatter, ~${handoffLineBudget(CONTEXT_CAP_SCHEMA)} lines total):
${handoffSections(CONTEXT_CAP_SCHEMA)}`;

const CONTENT_SPEC = `Call the \`${CONTEXT_CAP_TOOL_NAME}\` tool. ${DOC_SPEC}

After the tool returns, end your turn. Your context will then be replaced by this handoff.`;

export function steerMessage(tokens: number, caps: ResolvedTriggers): string {
	return `${WARNING_PREFIX} ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${caps.soft}, hard cap ${caps.hard}).

Finish your current logical unit of work first. Then: ${CONTENT_SPEC}`;
}

export function silentStopMessage(tokens: number, caps: ResolvedTriggers): string {
	return `${WARNING_PREFIX} ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${caps.soft}, hard cap ${caps.hard}). This is your last turn before handoff.

${CONTENT_SPEC}`;
}

/** One-jump crossing of the hard cap: demand the handoff NOW — no "finish your work first". */
export function hardSteerMessage(tokens: number, caps: ResolvedTriggers): string {
	return `${WARNING_PREFIX} ⚠️ CONTEXT LIMIT EMERGENCY: your context jumped to ${tokens} tokens, past the hard cap ${caps.hard}. Do NOT start any new work. ${CONTENT_SPEC}`;
}

/** /handoff: no cap numbers, no time pressure — the user asked for a fresh session. */
export const MANUAL_DEMAND = `Write the handoff document your successor session starts from. The next session sees this document and nothing else — no conversation history, no tool output. Anything you leave out is lost; be concrete (real paths, real commands, real state) and mark every unverified claim as unverified.

Call the \`${CONTEXT_CAP_TOOL_NAME}\` tool with the document. ${DOC_SPEC}

After the tool returns, end your turn. A new session then starts from this document.`;

/** The demand a cycle of `origin` sends (tokens/caps: the cycle's trigger reading and caps). */
export function demandMessage(origin: CycleOrigin, tokens: number, caps: ResolvedTriggers): string {
	switch (origin) {
		case "soft":
			return steerMessage(tokens, caps);
		case "silent":
			return silentStopMessage(tokens, caps);
		case "hard-jump":
			return hardSteerMessage(tokens, caps);
		case "manual":
		case "hard":
			// "hard" never demands (the backstop has no turn left); manual wording is the neutral one.
			return MANUAL_DEMAND;
	}
}

export function reminderMessage(origin: CycleOrigin, attempt: number): string {
	const prefix = origin === "manual" ? "" : `${WARNING_PREFIX} `;
	const earlier = origin === "manual" ? "the handoff instructions above" : "the earlier context-limit instructions";
	return `${prefix}No handoff was recorded — the \`${CONTEXT_CAP_TOOL_NAME}\` tool was not called.

Call it now (see ${earlier}), then end your turn. (reminder ${attempt}/${MAX_RETRIES})`;
}

/** The tool's success text: what happens once the turn ends. */
export function recordedMessage(ending: CycleEnding): string {
	const next =
		ending === "swap" ? "your context is replaced immediately afterwards" : "a new session starts from it";
	return `Handoff recorded. End your turn now (no further tool calls) — ${next}.`;
}
