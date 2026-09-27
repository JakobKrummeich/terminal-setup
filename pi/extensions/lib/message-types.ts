/**
 * Custom-message contracts shared across files: the customType strings pi
 * persists in session JSONL, and the swap-trigger vocabulary stored on the
 * swap marker's `details`. Writers (context-cap.ts, handoff.ts) and readers
 * (lib/child-view.ts, lib/session-transcript.ts) all import from here, so a
 * rename cannot silently break one side.
 *
 * Must stay free of pi imports: lib/session-transcript.ts is also loaded by
 * pi/dashboard-daemon.mjs outside pi. Constants and types only (see AGENTS.md:
 * lib files are re-imported per extension, so no mutable module state).
 */

/** customType of the context-cap swap marker (context-cap.ts stageSwap). */
export const SWAP_MARKER_TYPE = "context-cap-swap";

/** customType of the message /handoff seeds the successor session with (handoff.ts). */
export const HANDOFF_SUMMARY_TYPE = "handoff-summary";

/** Why a context-cap swap happened; persisted as the swap marker's `details.trigger`. */
export type SwapTrigger = "soft" | "hard" | "hard-no-file";

/**
 * Opening line of every handoff seed, whether it came from a cap swap
 * (context-cap.ts) or from /handoff (handoff.ts) — successors read the same text.
 */
export const HANDOFF_PREAMBLE =
	"You are continuing work from a previous session. The agent before you left you this information:";
