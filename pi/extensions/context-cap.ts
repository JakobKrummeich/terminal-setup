/**
 * context-cap — token-cap + graceful handoff via context-scrub (session ≠ context).
 *
 * Always on. Coexists with /handoff (manual). Mechanism:
 *  - soft cap (≤260k, model-aware — see "triggers" below): steer the agent mid-tool-use to call the `context_handoff`
 *    tool ("Current Task" section first — the next context sees ONLY this text)
 *  - silent-stop fallback: turn ends without tool calls above soft cap → followUp
 *  - turn-end verification on both paths: no handoff → bounded followUp reminders
 *  - swap = context-scrub: a persistent custom-message marker entry
 *    (customType SWAP_MARKER_TYPE = "context-cap-swap", content = preamble + handoff body, details =
 *    forensic metadata) is appended to the session, and a "context" event handler
 *    slices the LLM message array at the latest marker. The first post-swap LLM
 *    call sees ONLY the handoff (plus, if CONTEXT_CAP_TAIL_TOKENS > 0, the last
 *    complete turns before the marker — see "levers" below). No compaction, no run
 *    abort, no keepRecentTokens constraint. The session file keeps FULL history —
 *    the marker records exactly when/why the swap happened for later reconstruction.
 *  - hard cap (≤325k, model-aware): backstop. Before falling back to a stale file (or to no
 *    summary at all), ONE standalone LLM call drafts the handoff from the current
 *    context (lib/handoff-writer.ts): 325k against a ~1M window leaves ample room,
 *    and the alternative — re-injecting a minutes-old doc, or telling an unattended
 *    `pi -p` run to "ask the user" — was measured wrong in a 17-run study
 *    (~/context-cap-study, results/postmortem.md: one run re-injected a 6-minute-
 *    stale doc whose "gates are green" claim was already false; another had 16
 *    swaps and 15 docs). The drafted doc goes through the normal file path and is
 *    marked author "machine" in its frontmatter and in the marker details, so later
 *    reconstruction can tell it from an agent-written one. Any failure of that call
 *    (no model, provider error, rejection, timeout, empty text) returns null and the
 *    old stale/no-file behaviour runs unchanged — this path must never be worse
 *    than not having it.
 *    Sequencing: message_end/turn_end handlers are awaited all the way down
 *    (extensions/runner.js emit → agent-session `_handleAgentEvent` →
 *    pi-agent-core `processEvents`, which awaits each listener; turn_end runs
 *    via runner.js emitBoundary from the agent's awaited finishTurn hook; agent-loop.js
 *    awaits the message_end emit BEFORE executing that message's tool calls and
 *    the turn_end emit before draining the steering queue). So awaiting an LLM
 *    call inside message_end stalls the loop instead of racing it — there is no
 *    window where the agent keeps working. The user's ESC is not checked in that
 *    window either, hence the writer's own timeout plus ctx.signal.
 *    One grace turn per cycle when the handoff write is likely in flight (message_end
 *    fires before tool execution — observed live 2026-07-08).
 *  - one-jump crossing: a single message can cross BOTH caps (a grep of a
 *    sourcemap returned ~340k tokens — observed live 2026-08-11, child explorer
 *    wiped with no handoff ever requested). If that message ends in tool calls,
 *    another turn is guaranteed — same guarantee the soft steer rides — so the
 *    agent gets ONE emergency steer to write the handoff before the backstop wipes.
 *  - network-error hygiene (observed live on flaky networks): errored/aborted
 *    messages and turns are synthesized by pi's failure path, never agent
 *    decisions — both handlers skip them. Old behavior: errored turn_ends burned
 *    reminder retries (two blips → "exhausted" with the agent never seeing a
 *    reminder, stale reminders queued for later delivery), an errored
 *    message_end during a hard cycle bypassed the grace gate and fired the
 *    no-file backstop wipe mid-flake, and a reminder queued into an aborted run
 *    un-aborted it via pi's queued-message rescue. Additionally: a cycle whose
 *    window shrank far below the soft trigger (swap/compaction raced an error;
 *    ESC silently drops extension-queued steers) resets instead of demanding a
 *    handoff from a fresh window. Stale WARNINGS are handled structurally, not
 *    by instruction: pi's queues can deliver a cap message arbitrarily late, so
 *    the `context` handler scrubs every "[context-cap]" user message the model
 *    must not act on — any one behind the latest swap marker (its cycle is
 *    over; only reachable via the recency-tail lever) and, when no cycle is
 *    armed, the stranded ones too. A warning landing in a fresh post-swap
 *    window is thus invisible on the very first call (swap = marker + reset),
 *    and one stranded by a shrink is hidden from the call after the reset on.
 *    The session file keeps them all for forensics.
 *  - pi's threshold auto-compaction stays naturally quiet: it keys off provider-
 *    reported usage, which post-swap reflects only the scrubbed context. It can
 *    still fire when a single message overshoots everything (contextWindow -
 *    reserveTokens, default reserve 16384 — the ceiling our hard cap is derived
 *    from, so always above it) or on
 *    /compact. A `session_before_compact` handler then supplies a handoff-shaped
 *    summary via the same writer instead of a generic one; returning undefined on
 *    any failure hands the job back to pi's own summarizer. NOTE the semantic
 *    difference: our swap scrubs to the handoff alone, pi's compaction KEEPS the
 *    messages after firstKeptEntryId. Inside this hook pi's keep-recent semantics
 *    apply — deliberately not fought. Switch off with CONTEXT_CAP_COMPACT_HANDOFF=0.
 *
 * Handoff transport is a TOOL, not a file write by the agent: the agent passes
 * markdown, the EXTENSION writes the file host-side. This is deliberate — in
 * sandboxed setups (e.g. the podman "brain on host, hands in container" mode)
 * the agent's write tool executes somewhere else entirely, so a host path in a
 * prompt is unwritable (or, worse, silently writes into the sandbox) and the
 * handoff never materializes. A tool has no path contract to get wrong.
 *
 * Files (lib/context-cap-files.ts): <agent dir>/context-cap/<sessionId>-<seq>.md (contextCapDir(); agent dir =
 * PI_CODING_AGENT_DIR, else ~/.pi/agent — same dir pi puts the sessions in) — seq is disk-derived per
 * sessionId (sessionId never changes — swaps are entries, not new sessions, so one
 * session accumulates seq 1, 2, 3…). YAML frontmatter is written by the extension;
 * it is stripped before injection. No cleanup policy (v1).
 *
 * A/B levers (paid experiment; everything else is unchanged when they are off):
 *  - CONTEXT_CAP_SCHEMA=v1|v2 (default v2) picks the handoff document shape. The
 *    choice is made once in lib/env.ts and flows from there into the tool's
 *    `markdown` parameter description, the agent-facing CONTENT_SPEC and the
 *    machine writer's prompt — no second copy that could drift. v2 is path-heavy
 *    (forensics over 72 swaps: path recall 0.17, successors re-read files the
 *    handoff never named).
 *  - CONTEXT_CAP_TAIL_TOKENS=N (default 0) additionally keeps ~N tokens of raw
 *    transcript immediately before the marker, cut only at complete turns
 *    (lib/context-cap-view.ts selectContextTail). The handoff itself stays the LAST thing the model
 *    reads. 0 reproduces the pre-lever slice exactly.
 *
 * Triggers (lib/env.ts resolveTriggers, resolved FRESH on every check — never
 * cached): pi auto-compacts at `contextWindow - 16384`, so a fixed 325k hard cap
 * simply never fires on a 200k-window model and the extension is dead weight. Both
 * caps are therefore derived from the live window
 *   ceiling = contextWindow - 16384; hard = min(325k, 0.90*ceiling); soft = min(260k, 0.80*hard)
 * and re-read per check, because the model can change mid-session and pi has no
 * model-switch event. CONTEXT_CAP_SOFT / CONTEXT_CAP_HARD override a value
 * outright (the other stays dynamic). Unknown window ⇒ last known window, else the
 * static 260k/325k. A window too small to hold a cap disables the extension for
 * that check rather than swapping at a nonsensical threshold. The window, the two
 * values in force and their source are recorded in every swap marker and handoff
 * frontmatter (contextWindow / softCap / hardCap / capSource).
 *
 * Code layout: this file registers the handlers (in pi's dispatch order) and
 * runs each decision's side effects. The state machine's decisions (which
 * branch a message_end / turn_end takes) are pure functions over one CycleState
 * in lib/context-cap-decide.ts, table-tested per branch; the handlers here
 * gather input, call them and run the chosen action's side effects. One
 * CapSession (lib/context-cap-session.ts) carries the per-instance state and is
 * passed explicitly to the effect modules:
 *   lib/context-cap-view.ts      LLM view: warning scrub + tail cut (pure)
 *   lib/context-cap-messages.ts  the agent-facing cap warnings
 *   lib/context-cap-tool.ts      the context_handoff tool
 *   lib/context-cap-swap.ts      stage / commit the swap marker
 *   lib/context-cap-hard.ts      hard-cap backstop + machine-drafted handoff
 *   lib/context-cap-compact.ts   session_before_compact hook
 *   lib/context-cap-files.ts     handoff files + frontmatter
 *   lib/context-cap-resolver.ts  per-session cap resolution + warn-once
 *
 * Config: the levers above; CONTEXT_CAP_COMPACT_HANDOFF=0 disables the pi-compaction hook (default on).
 * Live-verified (compaction-hijack predecessor + this design's API surface) 2026-07-08.
 * Full soft-cap cycle (steer → handoff write → swap) live-tested with lowered caps 2026-07-09.
 */

import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { compactAsHandoff } from "./lib/context-cap-compact.ts";
import {
	decideMessageEnd,
	decideTurnEnd,
	decideTurnGate,
	type MessageEndAction,
	type TurnEndAction,
} from "./lib/context-cap-decide.ts";
import { hardCap } from "./lib/context-cap-hard.ts";
import { hardSteerMessage, reminderMessage, silentStopMessage, steerMessage } from "./lib/context-cap-messages.ts";
import {
	type CapSession,
	capsFrom,
	createCapSession,
	openCycle,
	resetCycle,
	updateStatus,
} from "./lib/context-cap-session.ts";
import { commitStagedSwap, stageSwap } from "./lib/context-cap-swap.ts";
import { registerHandoffTool } from "./lib/context-cap-tool.ts";
import { llmView } from "./lib/context-cap-view.ts";
import { CONTEXT_CAP_TAIL_TOKENS, type ResolvedTriggers } from "./lib/env.ts";
import { formatTokenCount } from "./lib/format.ts";

// Child done-detection needs nothing from this extension: every handoff
// continuation — the steered swap marker, followUp reminders, the post-swap turns —
// is drained inside the same `_runAgentPrompt` loop, so a caller awaiting
// `session.prompt()` (lib/child-session.ts) already sees the whole cycle.
// Regression-tested in test/context-cap.test.ts.

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Registration order is pi's dispatch order among this extension's handlers —
// keep it: tool, context, session_start, message_end, turn_end, session_before_compact.
export default function contextCapExtension(pi: ExtensionAPI) {
	const s = createCapSession(pi);
	registerHandoffTool(pi, s);
	pi.on("context", (event) => onContext(s, event));
	pi.on("session_start", (_event, ctx) => onSessionStart(s, ctx));
	pi.on("message_end", (event, ctx) => onMessageEnd(s, event, ctx));
	pi.on("turn_end", (event, ctx) => onTurnEnd(s, event, ctx));
	pi.on("session_before_compact", (event, ctx) => compactAsHandoff(event, ctx));
}

// -- context scrub ----------------------------------------------------------

// Slice the LLM context at the latest swap marker: the first post-swap call
// sees ONLY the handoff (converted to a user message by pi), later calls see
// handoff + post-swap turns. The session file always keeps full history.
//
// This handler runs before EVERY LLM call — the last gate between the session
// and the model — which makes it the place where stale cap warnings become
// structurally invisible (they stay in the session file for forensics):
//  1. Warnings behind the latest marker belong to a swapped-away cycle —
//     only reachable via the recency-tail lever — and are always scrubbed.
//  2. With no cycle armed, ANY warning is a stranded delivery (pi's queues
//     can deliver steers arbitrarily late, e.g. after an errored run; a committed
//     swap and the shrink guard in message_end reset the cycle): scrubbed. The
//     clause-bearing case — a warning landing in a fresh post-swap window —
//     is covered structurally: post-swap means marker present and phase
//     reset, so the warning is invisible on the very first call.
//     While a cycle IS armed, its post-marker warnings stand.
// No token-estimate freshness check here, deliberately: the estimator only
// sees the message array while provider-reported usage also counts the system
// prompt and tools — comparing the two mis-fires (observed as a spurious
// mid-cycle reset in the model-switch test). Shrink detection stays in
// message_end, where real usage is authoritative.
function onContext(s: CapSession, event: ContextEvent): ContextEventResult | undefined {
	const { messages, changed } = llmView(event.messages, s.cycle.phase !== "idle", CONTEXT_CAP_TAIL_TOKENS);
	// Cache what the model actually sees — the machine writer hands off the
	// live context, not the full session history behind the last marker.
	s.lastContextMessages = messages;
	return changed ? { messages: [...messages] } : undefined;
}

// -- events ---------------------------------------------------------------

function onSessionStart(s: CapSession, ctx: ExtensionContext): void {
	resetCycle(s);
	updateStatus(s, ctx, ctx.getContextUsage()?.tokens);
}

// Async on purpose: the hard-cap path may await one LLM call. Verified safe —
// pi-agent-core awaits every listener and awaits the message_end emit BEFORE
// executing that message's tool calls, so this stalls the loop rather than
// racing it (see the header). Every other path stays synchronous.
async function onMessageEnd(s: CapSession, event: MessageEndEvent, ctx: ExtensionContext): Promise<void> {
	const msg = event.message as { role: string; stopReason?: string; usage?: { totalTokens?: unknown } };
	if (msg.role !== "assistant") return;
	// Re-read per check: the model (and with it the window) can change mid-session
	// and pi has no model-switch event.
	const usage = ctx.getContextUsage();
	// Pi persists the assistant after message_end listeners, so context usage
	// can still describe the pre-response marker. Prefer this event's provider
	// usage; getContextUsage() is the fallback when the message carries none.
	const messageTokens = msg.usage?.totalTokens;
	const tokens = typeof messageTokens === "number" && Number.isFinite(messageTokens) ? messageTokens : usage?.tokens;
	const capsNow = capsFrom(s, ctx, usage);
	// Before the decision, so even a skipped (errored) message refreshes the footer.
	updateStatus(s, ctx, tokens, capsNow);
	const action = decideMessageEnd(s.cycle, { stopReason: msg.stopReason, tokens, caps: capsNow });
	return applyMessageEnd(s, ctx, action, capsNow, event.message);
}

/** Side effects of a decideMessageEnd action (lib/context-cap-decide.ts has the WHY of each). */
function applyMessageEnd(
	s: CapSession,
	ctx: ExtensionContext,
	action: MessageEndAction,
	capsNow: ResolvedTriggers,
	message: unknown,
): Promise<void> | undefined {
	switch (action.kind) {
		case "reset-shrunk":
			resetCycle(s);
			updateStatus(s, ctx, action.tokens, capsNow);
			ctx.ui.notify("context-cap: context shrank mid-cycle — stale handoff cycle reset", "info");
			return undefined;
		case "steer-hard-jump":
			openCycle(s, ctx, action.tokens, capsNow, "steered");
			s.pi.sendUserMessage(hardSteerMessage(action.tokens, capsNow), { deliverAs: "steer" });
			ctx.ui.notify(
				`context-cap: hard cap (${formatTokenCount(action.tokens)}) crossed in one jump — emergency handoff requested`,
				"warning",
			);
			return undefined;
		case "hard-grace":
			s.cycle.hardGraceUsed = true;
			return undefined;
		case "hard-cap":
			return hardCap(s, ctx, action.tokens, capsNow, message);
		case "steer-soft":
			openCycle(s, ctx, action.tokens, capsNow, "steered");
			// stopReason "toolUse" ⇒ run is streaming, so steer is the live path;
			// deliverAs is ignored when idle (plain prompt), making one call safe for both.
			s.pi.sendUserMessage(steerMessage(action.tokens, capsNow), { deliverAs: "steer" });
			ctx.ui.notify(`context-cap: soft cap (${formatTokenCount(action.tokens)}) — handoff requested`, "info");
			return undefined;
		default: {
			// "skip" / "none": nothing to do. Typed so that a new action kind fails to
			// compile here instead of silently doing nothing.
			const _noEffect: Extract<MessageEndAction, { kind: "skip" | "none" }> = action;
			return undefined;
		}
	}
}

function onTurnEnd(s: CapSession, event: TurnEndEvent, ctx: ExtensionContext): TurnEndEventResult | undefined {
	const gate = decideTurnGate(s.cycle, {
		stopReason: (event.message as { stopReason?: string }).stopReason,
		outcome: event.outcome,
		aborted: ctx.signal?.aborted === true,
		message: event.message,
	});
	switch (gate.kind) {
		case "skip-failed":
		case "discard-stale-staged":
			// Drop only the staged draft: the armed cycle and any written handoff remain usable.
			s.cycle.stagedSwap = null;
			return undefined;
		case "commit-staged":
			return commitStagedSwap(s, ctx, event);
		case "evaluate":
			return evaluateTurnEnd(s, ctx, event);
	}
}

/** turn_end past the gate: verification of an in-flight cycle, else the silent-stop fallback. */
function evaluateTurnEnd(s: CapSession, ctx: ExtensionContext, event: TurnEndEvent): TurnEndEventResult | undefined {
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens;
	// Re-read per check (see message_end).
	const capsNow = capsFrom(s, ctx, usage);
	const action = decideTurnEnd(s.cycle, { tokens, hasToolCalls: event.toolResults.length > 0, caps: capsNow });
	switch (action.kind) {
		case "swap-soft":
			stageSwap(s, ctx, { filePath: action.path, stale: false, trigger: "soft", author: "agent" }, event.message);
			return commitStagedSwap(s, ctx, event);
		case "remind":
			s.cycle.retries = action.attempt;
			sendFollowUp(s, reminderMessage(action.attempt));
			return continueBoundary(event);
		case "exhaust":
			s.cycle.phase = "exhausted";
			updateStatus(s, ctx, tokens, capsNow);
			ctx.ui.notify("context-cap: handoff never recorded — waiting for hard cap backstop", "warning");
			return undefined;
		case "silent-stop":
			openCycle(s, ctx, action.tokens, capsNow, "prompted");
			sendFollowUp(s, silentStopMessage(action.tokens, capsNow));
			ctx.ui.notify(`context-cap: soft cap (${formatTokenCount(action.tokens)}) — last-turn handoff requested`, "info");
			return continueBoundary(event);
		default: {
			// "keep-waiting" / "none": nothing to do (typed like applyMessageEnd's default).
			const _noEffect: Extract<TurnEndAction, { kind: "keep-waiting" | "none" }> = action;
			return undefined;
		}
	}
}

// deliverAs is ignored when idle (agent-session.js: isStreaming ? streamingBehavior
// : undefined), so one followUp call is safe whether or not the run is streaming.
function sendFollowUp(s: CapSession, text: string): void {
	s.pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function continueBoundary(event: TurnEndEvent): TurnEndEventResult {
	return { entries: [...event.entries], continue: true };
}
