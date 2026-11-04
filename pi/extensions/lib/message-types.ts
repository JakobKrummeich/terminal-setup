/**
 * Custom-message contracts shared across files: the customType strings pi
 * persists in session JSONL, and the swap-trigger vocabulary stored on the
 * swap marker's `details`. The writer (context-cap.ts and its lib/context-cap-*
 * modules) and the readers (lib/child-view.ts, lib/child-view-divider.ts,
 * lib/session-transcript.ts, lib/context-cap-view.ts)
 * all import from here, so a rename cannot silently break one side.
 *
 * Must stay free of pi imports: lib/session-transcript.ts is also loaded by
 * pi/dashboard-daemon.mjs outside pi. Constants and types only (see AGENTS.md:
 * lib files are re-imported per extension, so no mutable module state).
 */

/** customType of the context-cap swap marker (lib/context-cap-swap.ts stageSwap). */
export const SWAP_MARKER_TYPE = "context-cap-swap";

/** customType of the message /handoff seeds the successor session with (lib/context-cap-manual.ts). */
export const HANDOFF_SUMMARY_TYPE = "handoff-summary";

/**
 * customType of a handoff demand or reminder (lib/context-cap-demand.ts): the
 * cap warnings and the /handoff request, committed as turn_end /
 * agent_before_settle boundary entries — never through pi's steer/followUp
 * queues. The `context` handler scrubs them behind the latest swap marker.
 */
export const HANDOFF_DEMAND_TYPE = "handoff-demand";

/** Why a context-cap swap happened; persisted as the swap marker's `details.trigger`. */
export type SwapTrigger = "soft" | "hard" | "hard-no-file";

/**
 * Opening line of every handoff seed, whether it ends in a cap swap or in the
 * new session /handoff starts — successors read the same text.
 */
export const HANDOFF_PREAMBLE =
	"You are continuing work from a previous session. The agent before you left you this information:";
