/**
 * context-cap, ending a cycle: the successor text (preamble + this cycle's
 * document, built from `cycle.doc` — never re-read from the branch or the file),
 * staged during message_end or turn_end and delivered at the imminent turn_end
 * by the cycle's ending:
 *  - "swap": the persistent swap marker (a custom-message entry, customType
 *    SWAP_MARKER_TYPE, content = successor text + "Continue your work.", details
 *    = forensic metadata), committed as a boundary entry. The `context` handler
 *    then slices the LLM view at the latest marker (lib/context-cap-view.ts).
 *  - "new-session": the successor text, without the suffix, goes to the waiting
 *    /handoff command (lib/context-cap-manual.ts), which seeds a fresh session.
 * Mechanism: header of context-cap.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./agent-runs.ts";
import type { HandoffAuthor, RecordedDoc, StagedSwap, SwapDetails } from "./context-cap-decide.ts";
import { fileSeq, stripFrontmatter } from "./context-cap-files.ts";
import {
	type CapSession,
	resetCycle,
	sessionId,
	settleManual,
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

function summaryOf(body: string, stale: boolean, author: HandoffAuthor): string {
	const staleNote = stale ? `\n\n${STALE_NOTE}` : "";
	const preamble = author === "machine" ? MACHINE_PREAMBLE : HANDOFF_PREAMBLE;
	return `${preamble}\n\n${body}${staleNote}`;
}

/** The successor text of a recorded document, without any suffix (the new-session seed). */
export function docSummary(doc: RecordedDoc): string {
	return summaryOf(doc.body, false, doc.author);
}

/** What the successor should read, if the swap is possible. */
interface SwapPlan {
	/** This cycle's document; when absent, `filePath` is an older (stale) file or undefined (no file). */
	doc?: RecordedDoc;
	/** Where the document lives on disk; undefined = none at all (hard-no-file). */
	filePath: string | undefined;
	stale: boolean;
	trigger: SwapTrigger;
	author: HandoffAuthor;
}

/**
 * Prepare the successor text for the imminent turn_end. It is delivered as a
 * boundary entry of that turn_end (commitStagedSwap), never injected as a
 * message: sending a message from inside the boundary loops.
 */
export function stageSwap(s: CapSession, ctx: ExtensionContext, plan: SwapPlan, sourceMessage: unknown): void {
	const summary = swapSummary(s, ctx, plan);
	if (summary === undefined) return;
	const swapCaps = stampCaps(s, ctx);
	const details = swapDetails(s, ctx, plan, swapCaps);
	s.cycle.stagedSwap = { summary, continueSuffix: plan.filePath !== undefined, swapCaps, sourceMessage, details };
}

/** Successor text; undefined after a failed stale-file read (the cycle is then reset and the user told). */
function swapSummary(s: CapSession, ctx: ExtensionContext, plan: SwapPlan): string | undefined {
	if (plan.doc) return summaryOf(plan.doc.body, plan.stale, plan.doc.author);
	if (!plan.filePath) return NO_FILE_SUMMARY;
	try {
		return summaryOf(stripFrontmatter(fs.readFileSync(plan.filePath, "utf8")).trim(), plan.stale, plan.author);
	} catch (e) {
		const reason = `failed to read handoff file: ${e instanceof Error ? e.message : e}`;
		resetCycle(s, reason);
		updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
		ctx.ui.notify(`context-cap: ${reason}`, "error");
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

/** turn_end boundary: deliver the staged successor text by the cycle's ending. */
export function commitStagedSwap(
	s: CapSession,
	ctx: ExtensionContext,
	event: TurnEndEvent,
): TurnEndEventResult | undefined {
	const swap = s.cycle.stagedSwap;
	if (!swap) return undefined;
	s.cycle.stagedSwap = null;
	if (s.cycle.ending === "new-session") {
		handOver(s, ctx, swap.summary);
		// A hard-cap hand-over can land on a turn whose tools ran, so the loop would
		// call the model again in the over-cap window the user is leaving. Stop it.
		if (event.toolResults.length > 0) ctx.abort();
		return undefined;
	}
	return commitMarker(s, ctx, event, swap);
}

/**
 * New-session ending: hand the successor text to the waiting /handoff command
 * and close the cycle. No continuation: the run ends, and the command seeds the
 * new session once pi is idle.
 */
export function handOver(s: CapSession, ctx: ExtensionContext, seed: string): void {
	settleManual(s, { ok: true, seed });
	resetCycle(s);
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
	ctx.ui.notify("context-cap: handoff recorded — starting a new session from it", "info");
}

function commitMarker(s: CapSession, ctx: ExtensionContext, event: TurnEndEvent, swap: StagedSwap): TurnEndEventResult {
	resetCycle(s);
	const content = swap.continueSuffix ? `${swap.summary}\n\n${CONTINUE_SUFFIX}` : swap.summary;
	const boundaryResult: TurnEndEventResult = {
		entries: [
			...event.entries,
			{ type: "custom_message", customType: SWAP_MARKER_TYPE, content, display: true, details: swap.details },
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
