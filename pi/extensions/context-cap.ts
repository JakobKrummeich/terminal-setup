/**
 * context-cap — token-cap + graceful handoff via context-scrub (session ≠ context).
 *
 * Always on. Coexists with /handoff (manual). Mechanism:
 *  - soft cap (≤260k, model-aware — see "triggers" below): steer the agent mid-tool-use to call the `context_handoff`
 *    tool ("Current Task" section first — the next context sees ONLY this text)
 *  - silent-stop fallback: turn ends without tool calls above soft cap → followUp
 *  - turn-end verification on both paths: no handoff → bounded followUp reminders
 *  - swap = context-scrub: a persistent custom-message marker entry
 *    (customType "context-cap-swap", content = preamble + handoff body, details =
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
 *    pi-agent-core `processEvents`, which awaits each listener; agent-loop.js
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
 *    handoff from a fresh window, and every cap message carries a stale-ignore
 *    clause because pi's queues can deliver it arbitrarily late.
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
 * Files: ~/.pi/agent/context-cap/<sessionId>-<seq>.md — seq is disk-derived per
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
 *    (selectContextTail below). The handoff itself stays the LAST thing the model
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
 * Config: the levers below; CONTEXT_CAP_COMPACT_HANDOFF=0 disables the pi-compaction hook (default on).
 * Live-verified (compaction-hijack predecessor + this design's API surface) 2026-07-08.
 * Full soft-cap cycle (steer → handoff write → swap) live-tested with lowered caps 2026-07-09.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "./lib/agent-runs.ts";
import {
	contextCapReserveTokens,
	CONTEXT_CAP_SCHEMA,
	CONTEXT_CAP_STATUS_KEY,
	CONTEXT_CAP_TAIL_TOKENS,
	CONTEXT_CAP_TOOL_NAME,
	envFlag,
	type HandoffSchema,
	resolveTriggers,
	type ResolvedTriggers,
	type TriggerSource,
} from "./lib/env.ts";
import { draftHandoff, handoffLineBudget, handoffSections, type HandoffMessage } from "./lib/handoff-writer.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A/B levers, resolved once in lib/env.ts (see the header). */
const SCHEMA: HandoffSchema = CONTEXT_CAP_SCHEMA;
const TAIL_TOKENS = CONTEXT_CAP_TAIL_TOKENS;
const MAX_RETRIES = 2;
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");
const MARKER_TYPE = "context-cap-swap";
const TOOL_NAME = CONTEXT_CAP_TOOL_NAME;
/** Read at call time (not import time) so it can be flipped per test / per run. */
const COMPACT_HANDOFF_ENV = "CONTEXT_CAP_COMPACT_HANDOFF";
// No pending-work claim here (unlike timer.ts): every handoff continuation — the
// steered swap marker, followUp reminders, the post-swap turns — is drained inside
// the same `_runAgentPrompt` loop, so a caller awaiting `session.prompt()` already
// sees the whole cycle. Regression-tested in test/context-cap.test.ts.

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Section list lives in lib/handoff-writer.ts, the schema choice in lib/env.ts: the
// machine writer must produce the SAME document shape as the agent-written one, so
// there is exactly one copy of it.
const CONTENT_SPEC = `Call the \`${TOOL_NAME}\` tool. Its \`markdown\` argument (plain markdown, NO YAML frontmatter, ~${handoffLineBudget(SCHEMA)} lines total):
${handoffSections(SCHEMA)}

After the tool returns, end your turn. Your context will then be replaced by this handoff.`;

// pi's steering/followUp queues can deliver a cap message arbitrarily late — a
// network-errored run strands it until the next prompt, which may be a fresh
// post-swap window where the demand is nonsense. Self-invalidate by instruction.
const STALE_CLAUSE =
	"(If your context looks fresh — a recent session-handoff summary, only a few messages — this warning is stale; ignore it and continue your work.)";

function steerMessage(tokens: number, caps: ResolvedTriggers): string {
	return `[context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${caps.soft}, hard cap ${caps.hard}).

Finish your current logical unit of work first. Then: ${CONTENT_SPEC}

${STALE_CLAUSE}`;
}

function silentStopMessage(tokens: number, caps: ResolvedTriggers): string {
	return `[context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${caps.soft}, hard cap ${caps.hard}). This is your last turn before handoff.

${CONTENT_SPEC}

${STALE_CLAUSE}`;
}

/** One-jump crossing of the hard cap: demand the handoff NOW — no "finish your work first". */
function hardSteerMessage(tokens: number, caps: ResolvedTriggers): string {
	return `[context-cap] ⚠️ CONTEXT LIMIT EMERGENCY: your context jumped to ${tokens} tokens, past the hard cap ${caps.hard}. Do NOT start any new work. ${CONTENT_SPEC}

${STALE_CLAUSE}`;
}

function reminderMessage(attempt: number): string {
	return `[context-cap] No handoff was recorded — the \`${TOOL_NAME}\` tool was not called.

Call it now (see the earlier context-limit instructions), then end your turn. (reminder ${attempt}/${MAX_RETRIES})

${STALE_CLAUSE}`;
}

const PREAMBLE =
	"You are continuing work from a previous session. The agent before you left you this information:";

/** Machine-written handoff (hard-cap backstop): say so — its claims were never agent-verified. */
const MACHINE_PREAMBLE =
	"You are continuing work from a previous session. It hit its hard context limit before writing its own handoff, so the summary below was reconstructed automatically from its context by a single model call — it is second-hand: verify load-bearing claims (test/gate results, file state) before relying on them.";

/** Prepended to the summary handed to pi's own compaction (keep-recent semantics, not a scrub). */
const COMPACT_PREAMBLE =
	"The earlier part of this session was replaced by the handoff below (written automatically when the context window filled up). The most recent messages follow it unchanged.";

/** Writer instruction for the pi-compaction path, where recent messages survive. */
const COMPACT_EXTRA_INSTRUCTIONS =
	"Note: unlike a full context swap, the most recent messages of this conversation stay visible to the next session — this document replaces the older part only.";

const STALE_NOTE =
	"(Note: this handoff file was written earlier and may not reflect the very latest work — the session hit its hard context cap before a fresh handoff was written.)";

const NO_FILE_SUMMARY =
	"You are continuing work from a previous session that hit its hard context limit before a handoff summary could be written. The previous context has been cleared and cannot be recovered here. Ask the user for direction before doing anything.";

const CONTINUE_SUFFIX = "Continue your work.";

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function fileSeq(sessionId: string, name: string): number | undefined {
	const m = name.match(/^(.+)-(\d+)\.md$/);
	if (!m || m[1] !== sessionId) return undefined;
	return Number.parseInt(m[2], 10);
}

function existingSeqs(sessionId: string): number[] {
	try {
		return fs
			.readdirSync(CAP_DIR)
			.map((n) => fileSeq(sessionId, n))
			.filter((s): s is number => s !== undefined)
			.sort((a, b) => a - b);
	} catch {
		return [];
	}
}

function nextPath(sessionId: string): { seq: number; filePath: string } {
	const seqs = existingSeqs(sessionId);
	const seq = (seqs[seqs.length - 1] ?? 0) + 1;
	return { seq, filePath: path.join(CAP_DIR, `${sessionId}-${seq}.md`) };
}

function latestPath(sessionId: string): string | undefined {
	const seqs = existingSeqs(sessionId);
	if (seqs.length === 0) return undefined;
	return path.join(CAP_DIR, `${sessionId}-${seqs[seqs.length - 1]}.md`);
}

/** Full frontmatter block only — a lone markdown hr (`---`) at the top must NOT match. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

function stripFrontmatter(text: string): string {
	const m = text.match(FRONTMATTER_RE);
	return m ? text.slice(m[0].length).replace(/^\s+/, "") : text;
}

/** Write the handoff with YAML frontmatter (tooling metadata only — never injected). */
function writeHandoff(
	filePath: string,
	body: string,
	meta: {
		sessionId: string;
		seq: number;
		tokens: number;
		author: HandoffAuthor;
		schema: HandoffSchema;
		tailTokens: number;
		tailKeptTokens: number;
		caps: ResolvedTriggers;
	},
): void {
	const fm = `---\nsessionId: ${meta.sessionId}\ntimestamp: ${new Date().toISOString()}\ntokens: ${meta.tokens}\nseq: ${meta.seq}\nauthor: ${meta.author}\nschema: ${meta.schema}\ntailTokens: ${meta.tailTokens}\ntailKeptTokens: ${meta.tailKeptTokens}\ncontextWindow: ${yamlNumber(meta.caps.contextWindow)}\nsoftCap: ${yamlNumber(meta.caps.soft)}\nhardCap: ${yamlNumber(meta.caps.hard)}\ncapSource: ${meta.caps.source}\n---\n\n`;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, fm + stripFrontmatter(body).trim() + "\n");
}

/** null / +Infinity (a disabled cap) are not YAML numbers — emit the null literal. */
function yamlNumber(n: number | null): string {
	return n != null && Number.isFinite(n) ? String(n) : "null";
}

function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "off";
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ---------------------------------------------------------------------------
// Trigger resolution (model-aware, per check)
// ---------------------------------------------------------------------------

/** What a cap check needs from ctx — `ctx.getContextUsage()`'s shape, minimally. */
type UsageLike = { contextWindow?: number | null } | null | undefined;
type Notify = (message: string, level: "info" | "warning" | "error") => void;

/**
 * Per-session cap resolution: the pure lib/env.ts `resolveTriggers` plus the two
 * things one session has to remember — the last context window it actually saw
 * (pi reports none before the first LLM call, and a stale-but-real window beats the
 * static fallback) and which warnings were already shown, so a degenerate window
 * does not notify on every single message.
 *
 * A factory, not module state: jiti hands each extension file its own module copy
 * (AGENTS.md), and tests want one resolver per case.
 *
 * Exported for tests.
 */
export function createCapResolver(): (usage: UsageLike, notify?: Notify) => ResolvedTriggers {
	let lastKnownWindow: number | null = null;
	let warnedDisabled = false;
	let warnedClamped = false;
	let warnedFallback = false;
	return (usage, notify) => {
		const observed = usage?.contextWindow;
		const live = typeof observed === "number" && Number.isFinite(observed) && observed > 0 ? observed : null;
		if (live != null) lastKnownWindow = live;
		const caps = resolveTriggers(live ?? lastKnownWindow);
		if (caps.disabled && !warnedDisabled) {
			warnedDisabled = true;
			notify?.(
				`context-cap: context window ${caps.contextWindow ?? "unknown"} cannot hold a cap below pi's own compaction (reserve ${contextCapReserveTokens()}) — cap disabled`,
				"warning",
			);
		}
		if (caps.clamped && !warnedClamped) {
			warnedClamped = true;
			notify?.(`context-cap: soft cap ≥ hard cap — soft clamped to ${caps.soft} (hard ${caps.hard})`, "warning");
		}
		if (caps.source === "fallback" && !warnedFallback) {
			warnedFallback = true;
			notify?.(`context-cap: context window unknown — using static caps ${caps.soft}/${caps.hard}`, "info");
		}
		return caps;
	};
}

// ---------------------------------------------------------------------------
// Recency tail (CONTEXT_CAP_TAIL_TOKENS)
// ---------------------------------------------------------------------------

/**
 * Token estimate: characters / 4, the usual BPE rule of thumb for English + code.
 * Deliberately local and allocation-light — this runs inside the synchronous
 * `context` handler before every LLM call, where loading a tokenizer would be
 * absurd. It is an APPROXIMATION: ±25% on prose, worse on dense JSON, and images
 * are counted as a flat guess. The lever it feeds is a budget, not a limit that
 * anything breaks on.
 */
const CHARS_PER_TOKEN = 4;
/** Role/id/envelope overhead the character count does not see. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Flat per-image guess (~1k tokens); exact size needs the provider's tiler. */
const IMAGE_CHARS = 4000;

/** The fields of an AgentMessage this file's estimator/pairing walk care about. */
type TailMessage = {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	summary?: string;
	command?: string;
	output?: string;
};

/** Cheap size estimate for one message. Pure; exported for tests. */
export function estimateMessageTokens(message: unknown): number {
	const m = (message ?? {}) as TailMessage;
	let chars = 0;
	if (typeof m.content === "string") chars += m.content.length;
	else if (Array.isArray(m.content)) {
		for (const raw of m.content) {
			const c = (raw ?? {}) as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (typeof c.text === "string") chars += c.text.length;
			if (typeof c.thinking === "string") chars += c.thinking.length;
			if (c.type === "image") chars += IMAGE_CHARS;
			if (c.type === "toolCall") {
				chars += c.name?.length ?? 0;
				try {
					chars += JSON.stringify(c.arguments ?? "").length;
				} catch {
					chars += 200; // unserializable arguments: guess rather than throw
				}
			}
		}
	}
	// bashExecution / branchSummary / compactionSummary carry their text outside `content`.
	for (const extra of [m.summary, m.command, m.output]) {
		if (typeof extra === "string") chars += extra.length;
	}
	return MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface TailSelection {
	/** Index of the first kept message. Equals `markerIndex` when nothing is kept. */
	start: number;
	/** Estimated tokens of messages[start … markerIndex). 0 when nothing is kept. */
	tokens: number;
}

/**
 * How much raw transcript directly before the swap marker may be kept.
 *
 * Pairing safety is the whole point: a tool result whose toolCall was cut, or an
 * assistant toolCall whose result was cut, is a provider error — strictly worse
 * than keeping nothing. So a cut is only allowed at a message that references
 * nothing earlier (anything that is not `assistant` and not `toolResult`; those
 * all convert to a standalone user message), and only when the walk from there
 * to the marker contains no orphan result and no dangling call.
 *
 * Walks backwards from the marker, accumulating the estimate, and returns the
 * EARLIEST safe boundary that still fits the budget. If none fits — budget too
 * small, a tool call whose result lands after the marker, no boundary at all —
 * it returns `start = markerIndex`, i.e. keep nothing: today's behaviour.
 *
 * Pure; exported for tests. O(n) over the messages it inspects.
 */
export function selectContextTail(
	messages: readonly unknown[],
	markerIndex: number,
	budgetTokens: number,
): TailSelection {
	const nothing: TailSelection = { start: markerIndex, tokens: 0 };
	if (!(budgetTokens > 0) || markerIndex <= 0) return nothing;

	/** Results already walked past whose toolCall has not been seen yet (calls precede results). */
	const unmatchedResults = new Set<string>();
	let danglingCalls = 0;
	let tokens = 0;
	let best = nothing;

	for (let i = markerIndex - 1; i >= 0; i--) {
		const m = (messages[i] ?? {}) as TailMessage;
		tokens += estimateMessageTokens(m);
		if (tokens > budgetTokens) break; // every earlier start is larger still
		if (m.role === "toolResult") {
			if (typeof m.toolCallId === "string") unmatchedResults.add(m.toolCallId);
		} else if (m.role === "assistant") {
			for (const raw of Array.isArray(m.content) ? m.content : []) {
				const c = (raw ?? {}) as { type?: string; id?: string };
				if (c.type !== "toolCall" || typeof c.id !== "string") continue;
				// Its result is after the marker and can never come back: no cut below
				// this message is safe either, so the walk is done.
				if (!unmatchedResults.delete(c.id)) danglingCalls++;
			}
		} else if (unmatchedResults.size === 0 && danglingCalls === 0) {
			// References nothing earlier and everything after it is paired: safe cut.
			best = { start: i, tokens };
		}
		if (danglingCalls > 0) break;
	}
	return best;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

type Phase = "idle" | "steered" | "prompted" | "exhausted";
type SwapTrigger = "soft" | "hard" | "hard-no-file";
/** Who wrote the handoff document: the agent via the tool, or the writer LLM call. */
type HandoffAuthor = "agent" | "machine";

/** Forensic metadata persisted on the swap-marker session entry (never sent to LLM). */
interface SwapDetails {
	seq: number | null;
	trigger: SwapTrigger;
	tokensAtSwap: number;
	handoffPath: string | null;
	stale: boolean;
	/** null = no document at all (hard-no-file). Lets reconstruction tell the paths apart. */
	author: HandoffAuthor | null;
	/** A/B lever: handoff document schema the writer was asked for. */
	schema: HandoffSchema;
	/** A/B lever: configured recency-tail budget (CONTEXT_CAP_TAIL_TOKENS). */
	tailTokens: number;
	/** Estimated tokens of raw transcript kept in front of the handoff (0 = lever off). */
	tailKeptTokens: number;
	/** Model context window this cycle's caps were derived from; null = unknown. */
	contextWindow: number | null;
	/** Soft trigger actually in force when the cycle started. */
	softCap: number;
	/** Hard trigger actually in force when the cycle started. */
	hardCap: number;
	/** Where softCap/hardCap came from: explicit env, derived from the window, or the static default. */
	capSource: TriggerSource;
}

export default function contextCapExtension(pi: ExtensionAPI) {
	let phase: Phase = "idle";
	let expectedPath: string | undefined;
	let seq = 0;
	let retries = 0;
	let tokensAtTrigger = 0;
	/** Set by the tool once the handoff file is on disk. Replaces existsSync polling. */
	let handoffWritten = false;
	/** One-shot grace so the hard cap doesn't swap away the message carrying the tool call. */
	let hardGraceUsed = false;
	/**
	 * Model-aware triggers. Resolved FRESH on every check (the model can change
	 * mid-session and pi has no model-switch event), never at import time.
	 */
	const resolveCaps = createCapResolver();
	/**
	 * The pair in force when the current cycle started — what the steer message
	 * quoted, and therefore what the marker/frontmatter must record. Deliberately
	 * NOT re-resolved at swap time: the forensic question is "what fired this".
	 */
	let cycleCaps: ResolvedTriggers | null = null;
	/**
	 * Last LLM-visible message array (post-slice, i.e. exactly what the model saw).
	 * Cached HERE, not in lib/: jiti gives each extension file its own module copy,
	 * so module-level state in lib/ would silently split (AGENTS.md).
	 */
	let lastContextMessages: readonly HandoffMessage[] = [];

	function resetCycle() {
		phase = "idle";
		expectedPath = undefined;
		seq = 0;
		retries = 0;
		tokensAtTrigger = 0;
		handoffWritten = false;
		hardGraceUsed = false;
		cycleCaps = null;
	}

	function sessionId(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId();
	}

	/**
	 * The triggers for THIS check, re-read from the live model each time. Handlers
	 * pass the usage they already read: getContextUsage() re-estimates over the whole
	 * message array, and near the cap that array is large.
	 */
	function capsFrom(ctx: ExtensionContext, usage: UsageLike): ResolvedTriggers {
		return resolveCaps(usage, (message, level) => ctx.ui.notify(message, level));
	}
	function caps(ctx: ExtensionContext): ResolvedTriggers {
		return capsFrom(ctx, ctx.getContextUsage());
	}

	function updateStatus(ctx: ExtensionContext, tokens: number | null | undefined, resolved?: ResolvedTriggers) {
		const t = tokens == null ? "?" : fmtTokens(tokens);
		let suffix = "";
		if (phase === "steered" || phase === "prompted") suffix = " ⚠ handoff";
		else if (phase === "exhausted") suffix = " ⚠ awaiting hard cap";
		ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, `${t}/${fmtTokens((resolved ?? caps(ctx)).soft)}${suffix}`);
	}

	// deliverAs is ignored when idle (agent-session.js: isStreaming ? streamingBehavior
	// : undefined), so one followUp call is safe whether or not the run is streaming.
	function send(text: string) {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	}

	function startCycle(ctx: ExtensionContext, tokens: number, triggerCaps: ResolvedTriggers) {
		fs.mkdirSync(CAP_DIR, { recursive: true });
		const next = nextPath(sessionId(ctx));
		seq = next.seq;
		expectedPath = next.filePath;
		retries = 0;
		tokensAtTrigger = tokens;
		handoffWritten = false;
		cycleCaps = triggerCaps;
	}

	/** Caps to stamp on this cycle's artefacts — the cycle's own, or a fresh read if none. */
	function stampCaps(ctx: ExtensionContext): ResolvedTriggers {
		return cycleCaps ?? caps(ctx);
	}

	/**
	 * Estimated size of the recency tail this swap carries, for the marker details
	 * and the file frontmatter. Computed from the last LLM-visible context, which
	 * is the same array the `context` handler cuts — minus the turn that lands
	 * between the two, so treat it as the swap's projection, not a measurement.
	 * 0 whenever the lever is off.
	 */
	function tailKeptEstimate(): number {
		if (TAIL_TOKENS <= 0) return 0;
		return selectContextTail(lastContextMessages, lastContextMessages.length, TAIL_TOKENS).tokens;
	}

	function buildSummary(filePath: string, stale: boolean, author: HandoffAuthor): string {
		const body = stripFrontmatter(fs.readFileSync(filePath, "utf8")).trim();
		const staleNote = stale ? `\n\n${STALE_NOTE}` : "";
		const preamble = author === "machine" ? MACHINE_PREAMBLE : PREAMBLE;
		return `${preamble}\n\n${body}${staleNote}\n\n${CONTINUE_SUFFIX}`;
	}

	/**
	 * Swap = append a persistent marker entry; the "context" handler slices at it.
	 * filePath undefined = hard cap with no handoff file at all.
	 * Instant and infallible past the file read — no compaction, no abort, no race.
	 */
	function doSwap(
		ctx: ExtensionContext,
		filePath: string | undefined,
		stale: boolean,
		trigger: SwapTrigger,
		author: HandoffAuthor = "agent",
	) {
		let content: string;
		if (filePath) {
			try {
				content = buildSummary(filePath, stale, author);
			} catch (e) {
				resetCycle();
				updateStatus(ctx, ctx.getContextUsage()?.tokens);
				ctx.ui.notify(`context-cap: failed to read handoff file: ${e instanceof Error ? e.message : e}`, "error");
				return;
			}
		} else {
			content = NO_FILE_SUMMARY;
			ctx.ui.notify("context-cap: hard cap hit with no handoff file — swapping without summary", "warning");
		}
		const swapCaps = stampCaps(ctx);
		const details: SwapDetails = {
			seq: filePath ? fileSeq(sessionId(ctx), path.basename(filePath)) ?? null : null,
			trigger,
			tokensAtSwap: tokensAtTrigger,
			handoffPath: filePath ?? null,
			stale,
			author: filePath ? author : null,
			schema: SCHEMA,
			tailTokens: TAIL_TOKENS,
			tailKeptTokens: tailKeptEstimate(),
			contextWindow: swapCaps.contextWindow,
			softCap: swapCaps.soft,
			hardCap: swapCaps.hard,
			capSource: swapCaps.source,
		};
		resetCycle();
		// Idle (turn_end path): marker itself starts the next turn.
		// Streaming (hard-cap path): steer. Verified in pi-agent-core agent-loop.js:
		// the steering queue is drained only AFTER turn_end — tool results are already
		// in context — and injected before the next assistant response, so the marker
		// can never land between a toolCall and its toolResult (no orphan possible).
		// If the run aborts before the queue drains, the marker is lost — harmless:
		// the cycle is already reset, so the next message_end above the cap re-fires.
		if (ctx.isIdle()) {
			pi.sendMessage({ customType: MARKER_TYPE, content, display: true, details }, { triggerTurn: true });
		} else {
			pi.sendMessage({ customType: MARKER_TYPE, content, display: true, details }, { deliverAs: "steer" });
		}
		// Dashboard index (agent-runs.jsonl): a swap happened in this session — main
		// or child alike, the sid tells them apart. No-op for in-memory sessions.
		appendEvent(ctx.sessionManager.getSessionDir(), { ts: Date.now(), event: "reset", sid: sessionId(ctx) });
		// Provider-reported usage is stale (pre-swap) until the next response lands;
		// show an explicit transient instead of a misleading high number.
		ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, `swapped/${fmtTokens(swapCaps.soft)}`);
		ctx.ui.notify(`context-cap: context swapped (${trigger}, ${fmtTokens(details.tokensAtSwap)} tokens)`, "info");
	}

	/**
	 * Last resort before the backstop wipes: draft the handoff ourselves from the
	 * context the agent still has, and write it through the normal file path
	 * (same <sessionId>-<seq>.md mechanism, frontmatter author "machine").
	 * Returns the file path, or undefined on ANY failure — the caller then does
	 * exactly what it did before this path existed.
	 */
	async function machineHandoff(ctx: ExtensionContext, lastMessage: unknown): Promise<string | undefined> {
		const messages = [...lastContextMessages];
		// message_end fires before the message is in the next context event, so the
		// message that crossed the cap must be appended by hand.
		if (lastMessage) messages.push(lastMessage as HandoffMessage);
		if (messages.length === 0 || !expectedPath) return undefined;
		ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, `writing handoff/${fmtTokens(stampCaps(ctx).soft)}`);
		ctx.ui.notify("context-cap: no fresh handoff — writing one from the context (one LLM call)", "warning");
		// Never throws (lib/handoff-writer.ts contract); honors the run's abort signal.
		const draft = await draftHandoff({
			modelRegistry: ctx.modelRegistry,
			model: ctx.model,
			messages,
			signal: ctx.signal,
			schema: SCHEMA,
		});
		if (!draft) {
			ctx.ui.notify("context-cap: could not write a handoff — falling back to the previous file", "warning");
			return undefined;
		}
		try {
			writeHandoff(expectedPath, draft.text, {
				sessionId: sessionId(ctx),
				seq,
				tokens: tokensAtTrigger,
				author: "machine",
				schema: SCHEMA,
				tailTokens: TAIL_TOKENS,
				tailKeptTokens: tailKeptEstimate(),
				caps: stampCaps(ctx),
			});
		} catch (e) {
			ctx.ui.notify(
				`context-cap: writing the machine handoff failed: ${e instanceof Error ? e.message : e}`,
				"error",
			);
			return undefined;
		}
		return expectedPath;
	}

	async function hardCap(ctx: ExtensionContext, tokens: number, capsNow: ResolvedTriggers, lastMessage?: unknown) {
		if (!expectedPath) {
			// Hard crossed without a cycle and without a rescuable next turn (the
			// one-jump toolUse case is steered in message_end): derive path context anyway.
			startCycle(ctx, tokens, capsNow);
		} else {
			// Cycle already in flight from the soft trigger — record the hard-cap
			// reading so the marker's forensic tokensAtSwap reflects swap time.
			tokensAtTrigger = tokens;
		}
		const fresh = expectedPath && handoffWritten ? expectedPath : undefined;
		ctx.ui.notify(`context-cap: hard cap (${fmtTokens(tokens)}) — forcing handoff`, "warning");
		if (!fresh) {
			// No handoff from this cycle: rather than re-injecting a possibly minutes-old
			// file (or nothing at all), spend one LLM call on a current one.
			const written = await machineHandoff(ctx, lastMessage);
			if (written) {
				doSwap(ctx, written, false, "hard", "machine");
				return;
			}
			// The draft failed because the user hit ESC mid-call — a window that only
			// exists because we now await here. Wiping the context on an abort would be
			// strictly worse than before: skip, leave the cycle armed, and let the next
			// real message above the cap re-fire the backstop (the marker would be
			// dropped by the aborting run anyway).
			if (ctx.signal?.aborted) {
				ctx.ui.notify("context-cap: aborted while writing the handoff — swap deferred", "warning");
				updateStatus(ctx, tokens);
				return;
			}
		}
		const fallback = fresh ?? latestPath(sessionId(ctx));
		const stale = !fresh && fallback !== undefined; // older seq file substituted
		doSwap(ctx, fallback, stale, fallback ? "hard" : "hard-no-file", "agent");
	}

	// -- handoff tool -----------------------------------------------------------

	// Always active (never hidden): tool definitions are part of the cached prompt
	// prefix, so toggling them mid-session would invalidate the provider prompt
	// cache at ~260k tokens — far pricier than the ~100 tokens this always costs.
	// setActiveTools also only takes effect on the NEXT turn, i.e. not on the very
	// turn the soft-cap steer lands, which is exactly when the tool is needed.
	pi.registerTool({
		name: TOOL_NAME,
		label: "Context handoff",
		description:
			"INTERNAL — context-cap machinery. Call this ONLY when a [context-cap] message explicitly instructs you to. " +
			"Never call it on your own initiative, and never because a handoff/summary sounds useful: calling it discards " +
			"your entire context and replaces it with the text you pass. For a user-requested summary, write a normal reply.",
		parameters: Type.Object({
			markdown: Type.String({
				description: `Handoff body, plain markdown, no YAML frontmatter. First section must be '## Current Task'. ~${handoffLineBudget(SCHEMA)} lines.`,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!expectedPath || phase === "idle") {
				return {
					content: [
						{
							type: "text" as const,
							text: "Refused: no handoff was requested. This tool may only be called after a [context-cap] instruction. Nothing was written; continue your work.",
						},
					],
					details: {},
					isError: true,
				};
			}
			const body = params.markdown.trim();
			if (!body) {
				return {
					content: [{ type: "text" as const, text: "Refused: 'markdown' is empty. Call again with the handoff body." }],
					details: {},
					isError: true,
				};
			}
			try {
				writeHandoff(expectedPath, body, {
					sessionId: sessionId(ctx),
					seq,
					tokens: tokensAtTrigger,
					author: "agent",
					schema: SCHEMA,
					tailTokens: TAIL_TOKENS,
					tailKeptTokens: tailKeptEstimate(),
					caps: stampCaps(ctx),
				});
			} catch (e) {
				// Host-side write failed (disk full, permissions). Report so the agent
				// can retry; the hard cap remains the backstop.
				return {
					content: [
						{ type: "text" as const, text: `Handoff write failed: ${e instanceof Error ? e.message : e}` },
					],
					details: {},
					isError: true,
				};
			}
			handoffWritten = true;
			return {
				content: [
					{
						type: "text" as const,
						text: "Handoff recorded. End your turn now (no further tool calls) — your context is replaced immediately afterwards.",
					},
				],
				details: {},
			};
		},
	});

	// -- context scrub ----------------------------------------------------------

	// Slice the LLM context at the latest swap marker: the first post-swap call
	// sees ONLY the handoff (converted to a user message by pi), later calls see
	// handoff + post-swap turns. The session file always keeps full history.
	pi.on("context", (event) => {
		const msgs = event.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { role: string; customType?: string };
			if (m.role === "custom" && m.customType === MARKER_TYPE) {
				// Recency tail: keep whole turns in front of the marker when the lever is
				// on. TAIL_TOKENS = 0 ⇒ start === i ⇒ byte-identical to the pre-lever slice.
				// The marker (and any post-swap turns) stay last: the handoff is the last
				// thing the model reads. Deterministic in the prefix, so later calls in the
				// same window cut at the same place and the prompt prefix stays cacheable.
				const { start } = selectContextTail(msgs, i, TAIL_TOKENS);
				const sliced = msgs.slice(start);
				// Cache what the model actually sees — the machine writer hands off the
				// live context, not the full session history behind the last marker.
				lastContextMessages = start > 0 ? sliced : msgs;
				return start > 0 ? { messages: sliced } : undefined;
			}
		}
		lastContextMessages = msgs;
		return undefined;
	});

	// -- events ---------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		resetCycle();
		updateStatus(ctx, ctx.getContextUsage()?.tokens);
	});

	// Async on purpose: the hard-cap path may await one LLM call. Verified safe —
	// pi-agent-core awaits every listener and awaits the message_end emit BEFORE
	// executing that message's tool calls, so this stalls the loop rather than
	// racing it (see the header). Every other path stays synchronous.
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message as { role: string; stopReason?: string };
		if (msg.role !== "assistant") return;
		// Re-read per check: the model (and with it the window) can change mid-session
		// and pi has no model-switch event.
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		const capsNow = capsFrom(ctx, usage);
		updateStatus(ctx, tokens, capsNow);
		// Network-errored / user-aborted messages are synthesized by pi's failure
		// path, not agent decisions, and carry no fresh usage (getContextUsage
		// backward-scans past them to the previous real reading). Acting on that
		// stale reading double-fires decisions already taken for it — observed
		// live: an errored message during an emergency cycle bypassed the grace
		// gate (stopReason ≠ "toolUse") and wiped via the no-file backstop while
		// the handoff was still perfectly reachable. Skip; pi retries or settles,
		// and the next real message re-evaluates.
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
		if (tokens == null) return; // unknown usage — never trigger blind
		if (capsNow.disabled) return; // window too small to hold a cap — warned once by the resolver

		// Fresh-window guard: mid-cycle but the context shrank far below the soft
		// trigger — a swap/compaction raced a network error, or the steer was
		// dropped (ESC clears extension-queued messages silently) and work resumed
		// fresh. The demand this cycle rides on no longer applies; without the
		// reset, turn-end verification keeps demanding a handoff from a window
		// that is nowhere near the cap.
		if (phase !== "idle" && tokens < capsNow.soft / 2) {
			resetCycle();
			updateStatus(ctx, tokens, capsNow);
			ctx.ui.notify("context-cap: context shrank mid-cycle — stale handoff cycle reset", "info");
		}

		if (tokens >= capsNow.hard) {
			// One-jump crossing: no cycle in flight (the soft steer never fired — the
			// PREVIOUS message was below the soft cap) and this message ends in tool
			// calls, so another turn is guaranteed. Wiping now would discard a context
			// that never saw a warning (observed live 2026-08-11: explorer grep of a
			// .js.map jumped 36k → 377k). Steer an immediate handoff instead; the
			// grace below protects the message carrying the tool call, and an agent
			// that ignores this steer still meets the backstop one grace turn later.
			if (phase === "idle" && msg.stopReason === "toolUse") {
				startCycle(ctx, tokens, capsNow);
				phase = "steered";
				updateStatus(ctx, tokens, capsNow);
				pi.sendUserMessage(hardSteerMessage(tokens, capsNow), { deliverAs: "steer" });
				ctx.ui.notify(
					`context-cap: hard cap (${fmtTokens(tokens)}) crossed in one jump — emergency handoff requested`,
					"warning",
				);
				return;
			}
			// Grace turn: a handoff cycle is in flight and this message ends in tool
			// calls — message_end fires BEFORE tools execute, so swapping now would
			// scrub away the handoff write itself (observed live). Let the tools run
			// once; turn_end or the next message_end re-checks. One-shot per cycle so
			// an agent that ignores the handoff can't defer the hard cap forever.
			if (
				(phase === "steered" || phase === "prompted") &&
				msg.stopReason === "toolUse" &&
				expectedPath &&
				!handoffWritten &&
				!hardGraceUsed
			) {
				hardGraceUsed = true;
				return;
			}
			await hardCap(ctx, tokens, capsNow, event.message);
			return;
		}

		// Soft steer: only when another turn is guaranteed (mid-tool-use),
		// so the warning is seen while there is still budget to act on it.
		if (tokens >= capsNow.soft && phase === "idle" && msg.stopReason === "toolUse") {
			startCycle(ctx, tokens, capsNow);
			phase = "steered";
			updateStatus(ctx, tokens, capsNow);
			// stopReason "toolUse" ⇒ run is streaming, so steer is the live path;
			// deliverAs is ignored when idle (plain prompt), making one call safe for both.
			pi.sendUserMessage(steerMessage(tokens, capsNow), { deliverAs: "steer" });
			ctx.ui.notify(`context-cap: soft cap (${fmtTokens(tokens)}) — handoff requested`, "info");
		}
	});

	pi.on("turn_end", (event, ctx) => {
		// Errored/aborted turns never reached the agent (the message is synthetic,
		// toolResults always []). Treating them as refusals burned reminder retries
		// during network flakes — two blips flipped the cycle to "exhausted" with
		// the agent never having seen one reminder — and queuing a reminder into an
		// aborted run un-aborted it via pi's queued-message rescue (continue()).
		// Skip; the cycle stays armed and the next real turn re-evaluates.
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") return;

		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		const hasToolCalls = event.toolResults.length > 0;
		// Re-read per check (see message_end). Verification of an in-flight cycle still
		// runs when the cap is disabled — a handoff already demanded must be collected.
		const capsNow = capsFrom(ctx, usage);

		// Verification (both steer and silent-stop paths): swap as soon as the file exists.
		if ((phase === "steered" || phase === "prompted" || phase === "exhausted") && expectedPath) {
			if (handoffWritten) {
				doSwap(ctx, expectedPath, false, "soft");
				return;
			}
			if (phase === "exhausted" || hasToolCalls) return; // still working / already gave up
			if (retries < MAX_RETRIES) {
				retries++;
				send(reminderMessage(retries));
			} else {
				phase = "exhausted";
				updateStatus(ctx, tokens, capsNow);
				ctx.ui.notify("context-cap: handoff never recorded — waiting for hard cap backstop", "warning");
			}
			return;
		}

		// Silent-stop fallback: crossed soft cap but the crossing turn ended without
		// tool calls, so the steer gate never fired — the agent saw no warning.
		if (phase === "idle" && !hasToolCalls && !capsNow.disabled && tokens != null && tokens >= capsNow.soft) {
			startCycle(ctx, tokens, capsNow);
			phase = "prompted";
			updateStatus(ctx, tokens, capsNow);
			send(silentStopMessage(tokens, capsNow));
			ctx.ui.notify(`context-cap: soft cap (${fmtTokens(tokens)}) — last-turn handoff requested`, "info");
		}
	});

	// -- pi's own compaction: last ditch ---------------------------------------

	// Reached only when pi's threshold fires anyway (contextWindow - reserveTokens,
	// the ceiling our hard cap sits 10% under — a single monstrous message), or on
	// /compact, or when a degenerate window disabled us entirely. Supply
	// a handoff-shaped summary instead of a generic one, from the SAME writer.
	// Semantics differ from our swap and that is intended: pi keeps the messages
	// after firstKeptEntryId, so the summary replaces the older part only.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!envFlag(COMPACT_HANDOFF_ENV, true)) return undefined;
		try {
			const { preparation, signal } = event;
			const messages = [
				...preparation.messagesToSummarize,
				...preparation.turnPrefixMessages,
			] as HandoffMessage[];
			const draft = await draftHandoff({
				modelRegistry: ctx.modelRegistry,
				model: ctx.model,
				messages,
				signal,
				previousSummary: preparation.previousSummary,
				extraInstructions: COMPACT_EXTRA_INSTRUCTIONS,
				schema: SCHEMA,
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
					details: { author: "machine", writer: "context-cap", reason: event.reason, schema: SCHEMA },
				},
			};
		} catch {
			// The runner would log a throw as an extension error; falling through
			// silently to pi's own compaction is the quieter, identical outcome.
			return undefined;
		}
	});
}
