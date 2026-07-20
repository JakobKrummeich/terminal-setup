/**
 * context-cap — token-cap + graceful handoff via context-scrub (session ≠ context).
 *
 * Always on. Coexists with /handoff (manual). Mechanism:
 *  - soft cap (160k): steer the agent mid-tool-use to write a handoff file
 *    (exact path given; "Current Task" section first — the next context sees ONLY this file)
 *  - silent-stop fallback: turn ends without tool calls above soft cap → followUp
 *  - turn-end verification on both paths: file missing → bounded followUp reminders
 *  - swap = context-scrub: a persistent custom-message marker entry
 *    (customType "context-cap-swap", content = preamble + handoff body, details =
 *    forensic metadata) is appended to the session, and a "context" event handler
 *    slices the LLM message array at the latest marker. The first post-swap LLM
 *    call sees ONLY the handoff. No compaction, no run abort, no LLM calls, no
 *    keepRecentTokens constraint. The session file keeps FULL history — the marker
 *    records exactly when/why the swap happened for later reconstruction.
 *  - hard cap (200k): pure backstop — swap with the latest file, staleness accepted.
 *    One grace turn per cycle when the handoff write is likely in flight (message_end
 *    fires before tool execution — observed live 2026-07-08).
 *  - pi's threshold auto-compaction stays naturally quiet: it keys off provider-
 *    reported usage, which post-swap reflects only the scrubbed context.
 *
 * Files: ~/.pi/agent/context-cap/<sessionId>-<seq>.md — seq is disk-derived per
 * sessionId (sessionId never changes — swaps are entries, not new sessions, so one
 * session accumulates seq 1, 2, 3…). YAML frontmatter is added by the extension
 * AFTER the agent writes plain markdown; it is stripped before injection. No
 * cleanup policy (v1).
 *
 * Config: constants below, overridable via env CONTEXT_CAP_SOFT / CONTEXT_CAP_HARD.
 * Live-verified (compaction-hijack predecessor + this design's API surface) 2026-07-08.
 * Full soft-cap cycle (steer → handoff write → swap) live-tested with lowered caps 2026-07-09.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOFT_TRIGGER = envInt("CONTEXT_CAP_SOFT", 160_000);
const HARD_TRIGGER = envInt("CONTEXT_CAP_HARD", 200_000);
const MAX_RETRIES = 2;
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");
const MARKER_TYPE = "context-cap-swap";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function contentSpec(expectedPath: string): string {
	return `Write a handoff file to exactly this path:
${expectedPath}

Content requirements (plain markdown, NO YAML frontmatter, ~30 lines total):
1. "## Current Task" — FIRST section: what you are working on right now and the overall goal. The next session sees ONLY this file; nobody will restate the task.
2. A brief summary of this session and current status
3. Key file paths that were worked on
4. Information you found surprising or where you struggled
5. What the next session needs to know to continue

The directory already exists. After writing the file, end your turn. Your context will then be replaced by this file.`;
}

function steerMessage(tokens: number, expectedPath: string): string {
	return `[context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${SOFT_TRIGGER}, hard cap ${HARD_TRIGGER}).

Finish your current logical unit of work first. Then: ${contentSpec(expectedPath)}`;
}

function silentStopMessage(tokens: number, expectedPath: string): string {
	return `[context-cap] ⚠️ CONTEXT LIMIT WARNING: your context is at ${tokens} tokens (soft cap ${SOFT_TRIGGER}, hard cap ${HARD_TRIGGER}). This is your last turn before handoff.

${contentSpec(expectedPath)}`;
}

function reminderMessage(expectedPath: string, attempt: number): string {
	return `[context-cap] The handoff file was not found at:
${expectedPath}

Write it now (see the earlier context-limit instructions), then end your turn. (reminder ${attempt}/${MAX_RETRIES})`;
}

const PREAMBLE =
	"You are continuing work from a previous session. The agent before you left you this information:";

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

/** Prepend YAML frontmatter (tooling metadata only — never injected). Idempotent. */
function addFrontmatter(filePath: string, meta: { sessionId: string; seq: number; tokens: number }): void {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		if (FRONTMATTER_RE.test(raw)) return;
		const fm = `---\nsessionId: ${meta.sessionId}\ntimestamp: ${new Date().toISOString()}\ntokens: ${meta.tokens}\nseq: ${meta.seq}\n---\n\n`;
		fs.writeFileSync(filePath, fm + raw);
	} catch {
		// non-fatal: frontmatter is tooling metadata only
	}
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

type Phase = "idle" | "steered" | "prompted" | "exhausted";
type SwapTrigger = "soft" | "hard" | "hard-no-file";

/** Forensic metadata persisted on the swap-marker session entry (never sent to LLM). */
interface SwapDetails {
	seq: number | null;
	trigger: SwapTrigger;
	tokensAtSwap: number;
	handoffPath: string | null;
	stale: boolean;
}

export default function contextCapExtension(pi: ExtensionAPI) {
	let phase: Phase = "idle";
	let expectedPath: string | undefined;
	let seq = 0;
	let retries = 0;
	let tokensAtTrigger = 0;
	/** One-shot grace so the hard cap doesn't swap away the message carrying the handoff write. */
	let hardGraceUsed = false;

	function resetCycle() {
		phase = "idle";
		expectedPath = undefined;
		seq = 0;
		retries = 0;
		tokensAtTrigger = 0;
		hardGraceUsed = false;
	}

	function sessionId(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId();
	}

	function updateStatus(ctx: ExtensionContext, tokens: number | null | undefined) {
		const t = tokens == null ? "?" : fmtTokens(tokens);
		let suffix = "";
		if (phase === "steered" || phase === "prompted") suffix = " ⚠ handoff";
		else if (phase === "exhausted") suffix = " ⚠ awaiting hard cap";
		ctx.ui.setStatus("context-cap", `${t}/${fmtTokens(SOFT_TRIGGER)}${suffix}`);
	}

	// deliverAs is ignored when idle (agent-session.js: isStreaming ? streamingBehavior
	// : undefined), so one followUp call is safe whether or not the run is streaming.
	function send(text: string) {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	}

	function startCycle(ctx: ExtensionContext, tokens: number) {
		fs.mkdirSync(CAP_DIR, { recursive: true });
		const next = nextPath(sessionId(ctx));
		seq = next.seq;
		expectedPath = next.filePath;
		retries = 0;
		tokensAtTrigger = tokens;
	}

	function buildSummary(filePath: string, stale: boolean): string {
		const body = stripFrontmatter(fs.readFileSync(filePath, "utf8")).trim();
		const staleNote = stale ? `\n\n${STALE_NOTE}` : "";
		return `${PREAMBLE}\n\n${body}${staleNote}\n\n${CONTINUE_SUFFIX}`;
	}

	/**
	 * Swap = append a persistent marker entry; the "context" handler slices at it.
	 * filePath undefined = hard cap with no handoff file at all.
	 * Instant and infallible past the file read — no compaction, no abort, no race.
	 */
	function doSwap(ctx: ExtensionContext, filePath: string | undefined, stale: boolean, trigger: SwapTrigger) {
		let content: string;
		if (filePath) {
			if (filePath === expectedPath) {
				addFrontmatter(filePath, { sessionId: sessionId(ctx), seq, tokens: tokensAtTrigger });
			}
			try {
				content = buildSummary(filePath, stale);
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
		const details: SwapDetails = {
			seq: filePath ? fileSeq(sessionId(ctx), path.basename(filePath)) ?? null : null,
			trigger,
			tokensAtSwap: tokensAtTrigger,
			handoffPath: filePath ?? null,
			stale,
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
		// Provider-reported usage is stale (pre-swap) until the next response lands;
		// show an explicit transient instead of a misleading high number.
		ctx.ui.setStatus("context-cap", `swapped/${fmtTokens(SOFT_TRIGGER)}`);
		ctx.ui.notify(`context-cap: context swapped (${trigger}, ${fmtTokens(details.tokensAtSwap)} tokens)`, "info");
	}

	function hardCap(ctx: ExtensionContext, tokens: number) {
		if (!expectedPath) {
			// Hard crossed without a cycle (e.g. huge single jump): derive path context anyway.
			startCycle(ctx, tokens);
		} else {
			// Cycle already in flight from the soft trigger — record the hard-cap
			// reading so the marker's forensic tokensAtSwap reflects swap time.
			tokensAtTrigger = tokens;
		}
		const fresh = expectedPath && fs.existsSync(expectedPath) ? expectedPath : undefined;
		const fallback = fresh ?? latestPath(sessionId(ctx));
		const stale = !fresh && fallback !== undefined; // older seq file substituted
		ctx.ui.notify(`context-cap: hard cap (${fmtTokens(tokens)}) — forcing handoff`, "warning");
		doSwap(ctx, fallback, stale, fallback ? "hard" : "hard-no-file");
	}

	// -- context scrub ----------------------------------------------------------

	// Slice the LLM context at the latest swap marker: the first post-swap call
	// sees ONLY the handoff (converted to a user message by pi), later calls see
	// handoff + post-swap turns. The session file always keeps full history.
	pi.on("context", (event) => {
		const msgs = event.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { role: string; customType?: string };
			if (m.role === "custom" && m.customType === MARKER_TYPE) {
				return i > 0 ? { messages: msgs.slice(i) } : undefined;
			}
		}
		return undefined;
	});

	// -- events ---------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		resetCycle();
		updateStatus(ctx, ctx.getContextUsage()?.tokens);
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message as { role: string; stopReason?: string };
		if (msg.role !== "assistant") return;
		const tokens = ctx.getContextUsage()?.tokens;
		updateStatus(ctx, tokens);
		if (tokens == null) return; // unknown usage — never trigger blind

		if (tokens >= HARD_TRIGGER) {
			// Grace turn: a handoff cycle is in flight and this message ends in tool
			// calls — message_end fires BEFORE tools execute, so swapping now would
			// scrub away the handoff write itself (observed live). Let the tools run
			// once; turn_end or the next message_end re-checks. One-shot per cycle so
			// an agent that ignores the handoff can't defer the hard cap forever.
			if (
				(phase === "steered" || phase === "prompted") &&
				msg.stopReason === "toolUse" &&
				expectedPath &&
				!fs.existsSync(expectedPath) &&
				!hardGraceUsed
			) {
				hardGraceUsed = true;
				return;
			}
			hardCap(ctx, tokens);
			return;
		}

		// Soft steer: only when another turn is guaranteed (mid-tool-use),
		// so the warning is seen while there is still budget to act on it.
		if (tokens >= SOFT_TRIGGER && phase === "idle" && msg.stopReason === "toolUse") {
			startCycle(ctx, tokens);
			phase = "steered";
			updateStatus(ctx, tokens);
			// stopReason "toolUse" ⇒ run is streaming, so steer is the live path;
			// deliverAs is ignored when idle (plain prompt), making one call safe for both.
			pi.sendUserMessage(steerMessage(tokens, expectedPath!), { deliverAs: "steer" });
			ctx.ui.notify(`context-cap: soft cap (${fmtTokens(tokens)}) — handoff requested`, "info");
		}
	});

	pi.on("turn_end", (event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens;
		const hasToolCalls = event.toolResults.length > 0;

		// Verification (both steer and silent-stop paths): swap as soon as the file exists.
		if ((phase === "steered" || phase === "prompted" || phase === "exhausted") && expectedPath) {
			if (fs.existsSync(expectedPath)) {
				doSwap(ctx, expectedPath, false, "soft");
				return;
			}
			if (phase === "exhausted" || hasToolCalls) return; // still working / already gave up
			if (retries < MAX_RETRIES) {
				retries++;
				send(reminderMessage(expectedPath, retries));
			} else {
				phase = "exhausted";
				updateStatus(ctx, tokens);
				ctx.ui.notify("context-cap: handoff file never written — waiting for hard cap backstop", "warning");
			}
			return;
		}

		// Silent-stop fallback: crossed soft cap but the crossing turn ended without
		// tool calls, so the steer gate never fired — the agent saw no warning.
		if (phase === "idle" && !hasToolCalls && tokens != null && tokens >= SOFT_TRIGGER) {
			startCycle(ctx, tokens);
			phase = "prompted";
			updateStatus(ctx, tokens);
			send(silentStopMessage(tokens, expectedPath!));
			ctx.ui.notify(`context-cap: soft cap (${fmtTokens(tokens)}) — last-turn handoff requested`, "info");
		}
	});
}
