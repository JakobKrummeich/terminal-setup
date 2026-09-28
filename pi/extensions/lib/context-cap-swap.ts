/**
 * context-cap swap: staging the persistent swap marker (a custom-message entry,
 * customType SWAP_MARKER_TYPE, content = preamble + handoff body, details =
 * forensic metadata) and committing it as a boundary entry of the imminent
 * turn_end. The `context` handler then slices the LLM view at the latest marker
 * (lib/context-cap-view.ts llmView). Mechanism: header of context-cap.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./agent-runs.ts";
import type { HandoffAuthor, SwapDetails } from "./context-cap-decide.ts";
import { fileSeq, stripFrontmatter } from "./context-cap-files.ts";
import {
	type CapSession,
	resetCycle,
	sessionId,
	stampCaps,
	tailKeptEstimate,
	updateStatus,
} from "./context-cap-session.ts";
import { CONTEXT_CAP_SCHEMA, CONTEXT_CAP_STATUS_KEY, CONTEXT_CAP_TAIL_TOKENS, type ResolvedTriggers } from "./env.ts";
import { formatTokenCount } from "./format.ts";
import { HANDOFF_PREAMBLE, SWAP_MARKER_TYPE, type SwapTrigger } from "./message-types.ts";

/** Machine-written handoff (hard-cap backstop): say so — its claims were never agent-verified. */
const MACHINE_PREAMBLE =
	"You are continuing work from a previous session. It hit its hard context limit before writing its own handoff, so the summary below was reconstructed automatically from its context by a single model call — it is second-hand: verify load-bearing claims (test/gate results, file state) before relying on them.";

const STALE_NOTE =
	"(Note: this handoff file was written earlier and may not reflect the very latest work — the session hit its hard context cap before a fresh handoff was written.)";

const NO_FILE_SUMMARY =
	"You are continuing work from a previous session that hit its hard context limit before a handoff summary could be written. The previous context has been cleared and cannot be recovered here. Ask the user for direction before doing anything.";

const CONTINUE_SUFFIX = "Continue your work.";

function buildSummary(filePath: string, stale: boolean, author: HandoffAuthor): string {
	const body = stripFrontmatter(fs.readFileSync(filePath, "utf8")).trim();
	const staleNote = stale ? `\n\n${STALE_NOTE}` : "";
	const preamble = author === "machine" ? MACHINE_PREAMBLE : HANDOFF_PREAMBLE;
	return `${preamble}\n\n${body}${staleNote}\n\n${CONTINUE_SUFFIX}`;
}

/** What the marker should say, if the swap is possible. */
interface SwapPlan {
	/** The handoff document; undefined = none at all (hard-no-file). */
	filePath: string | undefined;
	stale: boolean;
	trigger: SwapTrigger;
	author: HandoffAuthor;
}

/**
 * Prepare a persistent marker for the imminent turn_end. The marker is committed
 * as a boundary entry of that turn_end (commitStagedSwap), not injected as a
 * steer: sending a message from inside the boundary loops.
 */
export function stageSwap(s: CapSession, ctx: ExtensionContext, plan: SwapPlan, sourceMessage: unknown): void {
	const content = swapContent(s, ctx, plan);
	if (content === undefined) return;
	const swapCaps = stampCaps(s, ctx);
	s.cycle.stagedSwap = { content, swapCaps, sourceMessage, details: swapDetails(s, ctx, plan, swapCaps) };
}

/** Marker content; undefined after a failed file read (the cycle is then reset and the user told). */
function swapContent(s: CapSession, ctx: ExtensionContext, plan: SwapPlan): string | undefined {
	if (!plan.filePath) return NO_FILE_SUMMARY;
	try {
		return buildSummary(plan.filePath, plan.stale, plan.author);
	} catch (e) {
		resetCycle(s);
		updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
		ctx.ui.notify(`context-cap: failed to read handoff file: ${e instanceof Error ? e.message : e}`, "error");
		return undefined;
	}
}

function swapDetails(s: CapSession, ctx: ExtensionContext, plan: SwapPlan, swapCaps: ResolvedTriggers): SwapDetails {
	const { filePath } = plan;
	return {
		seq: filePath ? fileSeq(sessionId(ctx), path.basename(filePath)) ?? null : null,
		trigger: plan.trigger,
		tokensAtSwap: s.cycle.tokensAtTrigger,
		handoffPath: filePath ?? null,
		stale: plan.stale,
		author: filePath ? plan.author : null,
		schema: CONTEXT_CAP_SCHEMA,
		tailTokens: CONTEXT_CAP_TAIL_TOKENS,
		tailKeptTokens: tailKeptEstimate(s),
		contextWindow: swapCaps.contextWindow,
		softCap: swapCaps.soft,
		hardCap: swapCaps.hard,
		capSource: swapCaps.source,
	};
}

/** turn_end boundary: append the staged marker, reset the cycle and report the swap. */
export function commitStagedSwap(
	s: CapSession,
	ctx: ExtensionContext,
	event: TurnEndEvent,
): TurnEndEventResult | undefined {
	if (!s.cycle.stagedSwap) return undefined;
	const swap = s.cycle.stagedSwap;
	s.cycle.stagedSwap = null;
	resetCycle(s);

	const boundaryResult: TurnEndEventResult = {
		entries: [
			...event.entries,
			{
				type: "custom_message",
				customType: SWAP_MARKER_TYPE,
				content: swap.content,
				display: true,
				details: swap.details,
			},
		],
		continue: true,
	};

	// These effects belong to the commit, not preparation: exactly one reset is
	// reported even when a hard-cap message stages before its tools finish.
	if (swap.details.trigger === "hard-no-file") {
		ctx.ui.notify("context-cap: hard cap hit with no handoff file — swapping without summary", "warning");
	}
	appendEvent(ctx.sessionManager.getSessionDir(), { ts: Date.now(), event: "reset", sid: sessionId(ctx) });
	ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, `swapped/${formatTokenCount(swap.swapCaps.soft)}`);
	ctx.ui.notify(
		`context-cap: context swapped (${swap.details.trigger}, ${formatTokenCount(swap.details.tokensAtSwap)} tokens)`,
		"info",
	);
	return boundaryResult;
}
