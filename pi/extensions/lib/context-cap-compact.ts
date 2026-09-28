/**
 * context-cap, pi's own compaction as a last ditch (`session_before_compact`).
 *
 * Reached only when pi's threshold fires anyway (contextWindow - reserveTokens,
 * the ceiling our hard cap sits 10% under — a single monstrous message), or on
 * /compact, or when a degenerate window disabled us entirely. Supply a
 * handoff-shaped summary instead of a generic one, from the SAME writer.
 * Semantics differ from our swap and that is intended: pi keeps the messages
 * after firstKeptEntryId, so the summary replaces the older part only.
 * Switch off with CONTEXT_CAP_COMPACT_HANDOFF=0.
 */

import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { CONTEXT_CAP_SCHEMA, envFlag } from "./env.ts";
import { draftHandoff, type HandoffMessage } from "./handoff-writer.ts";

/** Read at call time (not import time) so it can be flipped per test / per run. */
const COMPACT_HANDOFF_ENV = "CONTEXT_CAP_COMPACT_HANDOFF";

/** Prepended to the summary handed to pi's own compaction (keep-recent semantics, not a scrub). */
const COMPACT_PREAMBLE =
	"The earlier part of this session was replaced by the handoff below (written automatically when the context window filled up). The most recent messages follow it unchanged.";

/** Writer instruction for the pi-compaction path, where recent messages survive. */
const COMPACT_EXTRA_INSTRUCTIONS =
	"Note: unlike a full context swap, the most recent messages of this conversation stay visible to the next session — this document replaces the older part only.";

export async function compactAsHandoff(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<SessionBeforeCompactResult | undefined> {
	if (!envFlag(COMPACT_HANDOFF_ENV, true)) return undefined;
	try {
		const { preparation, signal } = event;
		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages] as HandoffMessage[];
		const draft = await draftHandoff({
			modelRegistry: ctx.modelRegistry,
			model: ctx.model,
			messages,
			signal,
			previousSummary: preparation.previousSummary,
			extraInstructions: COMPACT_EXTRA_INSTRUCTIONS,
			schema: CONTEXT_CAP_SCHEMA,
		});
		// undefined ⇒ pi runs its own summarization. That is the fallback for every
		// failure here, including an abort we would otherwise race pi's own check on.
		if (!draft || signal.aborted) return undefined;
		ctx.ui.notify("context-cap: compaction summarized as a handoff", "info");
		return {
			compaction: {
				summary: `${COMPACT_PREAMBLE}\n\n${draft.text}`,
				// Echoed back VERBATIM: pi forwards both to sessionManager.appendCompaction
				// without validation, and a wrong entry id desyncs the session on reload.
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: draft.usage,
				details: { author: "machine", writer: "context-cap", reason: event.reason, schema: CONTEXT_CAP_SCHEMA },
			},
		};
	} catch {
		// The runner would log a throw as an extension error; falling through
		// silently to pi's own compaction is the quieter, identical outcome.
		return undefined;
	}
}
