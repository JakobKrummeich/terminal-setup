/**
 * context-cap hard-cap backstop: arm the cycle, prefer this cycle's fresh agent
 * handoff, else spend ONE LLM call drafting one from the live context
 * (lib/handoff-writer.ts, frontmatter author "machine"), else fall back to the
 * latest older file, else swap with no summary. Any failure of the draft
 * returns to the pre-draft behaviour — this path must never be worse than not
 * having it. Why and how it is sequenced (message_end awaits all the way down,
 * so awaiting the draft stalls the loop instead of racing it): header of
 * context-cap.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hardFallbackSwap } from "./context-cap-decide.ts";
import { latestPath } from "./context-cap-files.ts";
import {
	type CapSession,
	sessionId,
	stampCaps,
	startCycle,
	updateStatus,
	writeCycleHandoff,
} from "./context-cap-session.ts";
import { stageSwap } from "./context-cap-swap.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_STATUS_KEY, type ResolvedTriggers } from "./env.ts";
import { formatTokenCount } from "./format.ts";
import { draftHandoff, type HandoffMessage } from "./handoff-writer.ts";

export async function hardCap(
	s: CapSession,
	ctx: ExtensionContext,
	tokens: number,
	capsNow: ResolvedTriggers,
	lastMessage: unknown,
): Promise<void> {
	armHardCycle(s, ctx, tokens, capsNow);
	const fresh = s.cycle.expectedPath && s.cycle.handoffWritten ? s.cycle.expectedPath : undefined;
	ctx.ui.notify(`context-cap: hard cap (${formatTokenCount(tokens)}) — forcing handoff`, "warning");
	// No handoff from this cycle: rather than re-injecting a possibly minutes-old
	// file (or nothing at all), spend one LLM call on a current one.
	if (!fresh && (await machineSwap(s, ctx, tokens, lastMessage))) return;
	const fallback = fresh ?? latestPath(sessionId(ctx));
	const { stale, trigger } = hardFallbackSwap(fresh, fallback);
	stageSwap(s, ctx, { filePath: fallback, stale, trigger, author: "agent" }, lastMessage);
}

/**
 * Hard crossed without a rescuable next turn: arm the cycle's path context (a
 * fresh one when no cycle is in flight — the one-jump toolUse case is steered in
 * message_end instead), or, with a cycle already in flight from the soft
 * trigger, record the hard-cap reading so the marker's forensic tokensAtSwap
 * reflects swap time. Leaves `phase` as it is.
 */
function armHardCycle(s: CapSession, ctx: ExtensionContext, tokens: number, capsNow: ResolvedTriggers): void {
	if (!s.cycle.expectedPath) startCycle(s, ctx, tokens, capsNow);
	else s.cycle.tokensAtTrigger = tokens;
}

/** Draft + stage a machine handoff. true = handled (staged, or deferred on abort); false = fall back. */
async function machineSwap(s: CapSession, ctx: ExtensionContext, tokens: number, lastMessage: unknown): Promise<boolean> {
	const written = await machineHandoff(s, ctx, lastMessage);
	if (written) {
		stageSwap(s, ctx, { filePath: written, stale: false, trigger: "hard", author: "machine" }, lastMessage);
		return true;
	}
	// The draft failed because the user hit ESC mid-call — a window that only
	// exists because we now await here. Wiping the context on an abort would be
	// strictly worse than before: skip, leave the cycle armed, and let the next
	// real message above the cap re-fire the backstop (the marker would be
	// dropped by the aborting run anyway).
	if (ctx.signal?.aborted) {
		ctx.ui.notify("context-cap: aborted while writing the handoff — swap deferred", "warning");
		updateStatus(s, ctx, tokens);
		return true;
	}
	return false;
}

/**
 * Last resort before the backstop wipes: draft the handoff ourselves from the
 * context the agent still has, and write it through the normal file path
 * (same <sessionId>-<seq>.md mechanism, frontmatter author "machine").
 * Returns the file path, or undefined on ANY failure — the caller then does
 * exactly what it did before this path existed.
 */
async function machineHandoff(s: CapSession, ctx: ExtensionContext, lastMessage: unknown): Promise<string | undefined> {
	const messages = [...s.lastContextMessages];
	// message_end fires before the message is in the next context event, so the
	// message that crossed the cap must be appended by hand.
	if (lastMessage) messages.push(lastMessage as HandoffMessage);
	if (messages.length === 0 || !s.cycle.expectedPath) return undefined;
	ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, `writing handoff/${formatTokenCount(stampCaps(s, ctx).soft)}`);
	ctx.ui.notify("context-cap: no fresh handoff — writing one from the context (one LLM call)", "warning");
	// Never throws (lib/handoff-writer.ts contract); honors the run's abort signal.
	const draft = await draftHandoff({
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		messages,
		signal: ctx.signal,
		schema: CONTEXT_CAP_SCHEMA,
	});
	if (!draft) {
		ctx.ui.notify("context-cap: could not write a handoff — falling back to the previous file", "warning");
		return undefined;
	}
	try {
		writeCycleHandoff(s, ctx, s.cycle.expectedPath, draft.text, "machine");
	} catch (e) {
		ctx.ui.notify(`context-cap: writing the machine handoff failed: ${e instanceof Error ? e.message : e}`, "error");
		return undefined;
	}
	return s.cycle.expectedPath;
}
