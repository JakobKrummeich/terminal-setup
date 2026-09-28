/**
 * context-cap, the agent-facing cap warnings: the soft steer, the silent-stop
 * prompt, the one-jump emergency steer and the reminder (context-cap.ts sends
 * them). Every one starts with WARNING_PREFIX — the `context` handler's scrub
 * key (lib/context-cap-view.ts) — so none needs a "if this looks stale, ignore
 * it" clause: a stale one is never seen at all.
 *
 * CONTENT_SPEC is resolved once, at import, from the schema lever (lib/env.ts
 * CONTEXT_CAP_SCHEMA); the section list lives in lib/handoff-writer.ts. The
 * machine writer must produce the SAME document shape as the agent-written one,
 * so there is exactly one copy of it.
 */

import { MAX_RETRIES } from "./context-cap-decide.ts";
import { WARNING_PREFIX } from "./context-cap-view.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_TOOL_NAME, type ResolvedTriggers } from "./env.ts";
import { handoffLineBudget, handoffSections } from "./handoff-writer.ts";

const CONTENT_SPEC = `Call the \`${CONTEXT_CAP_TOOL_NAME}\` tool. Its \`markdown\` argument (plain markdown, NO YAML frontmatter, ~${handoffLineBudget(CONTEXT_CAP_SCHEMA)} lines total):
${handoffSections(CONTEXT_CAP_SCHEMA)}

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

export function reminderMessage(attempt: number): string {
	return `${WARNING_PREFIX} No handoff was recorded — the \`${CONTEXT_CAP_TOOL_NAME}\` tool was not called.

Call it now (see the earlier context-limit instructions), then end your turn. (reminder ${attempt}/${MAX_RETRIES})`;
}
