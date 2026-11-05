/**
 * context-cap, one extension instance's state and the small helpers every
 * effect path shares (status footer, cycle arming, cap stamping, the handoff
 * file write). context-cap.ts creates ONE CapSession per extension load and
 * hands it explicitly to the handlers and to the lib/context-cap-* effect
 * modules — nothing here is module state (AGENTS.md: jiti gives each extension
 * file its own copy of lib/).
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextCapDir } from "./agent-dir.ts";
import { type CycleOrigin, type CycleState, type HandoffAuthor, idleCycle } from "./context-cap-decide.ts";
import { nextPath, stripFrontmatter, writeHandoff } from "./context-cap-files.ts";
import { type CapResolver, createCapResolver, type UsageLike } from "./context-cap-resolver.ts";
import { selectContextTail } from "./context-cap-view.ts";
import {
	CONTEXT_CAP_SCHEMA,
	CONTEXT_CAP_STATUS_KEY,
	CONTEXT_CAP_TAIL_TOKENS,
	type ResolvedTriggers,
} from "./env.ts";
import { formatCapStatus } from "./format.ts";
import type { HandoffMessage } from "./handoff-writer.ts";

/** How a /handoff ends: the successor seed, or why there is none (no reason = say nothing). */
export type ManualResult = { ok: true; seed: string } | { ok: false; reason?: string };

/** The /handoff command waiting for its cycle (lib/context-cap-manual.ts). */
export interface ManualWaiter {
	resolve(result: ManualResult): void;
}

export interface CapSession {
	/** sendMessage only ever starts a run from idle (/handoff): nothing is queued. */
	readonly pi: Pick<ExtensionAPI, "sendMessage">;
	/**
	 * The current handoff cycle (lib/context-cap-decide.ts CycleState documents the
	 * lifecycle). Always accessed as `s.cycle.<field>`, never aliased: resetCycle()
	 * replaces the object, and code resuming after an await must see the new one.
	 */
	cycle: CycleState;
	/**
	 * Model-aware triggers. Resolved FRESH on every check (the model can change
	 * mid-session and pi has no model-switch event), never at import time.
	 */
	readonly resolveCaps: CapResolver;
	/**
	 * Last LLM-visible message array (post-slice, i.e. exactly what the model saw).
	 * Session-lifetime, NOT part of the cycle (a reset keeps it). Lives on the
	 * session object, not in lib/ module state: jiti gives each extension file its
	 * own module copy, so module-level state would silently split (AGENTS.md).
	 */
	lastContextMessages: readonly HandoffMessage[];
	/**
	 * The /handoff command awaiting this cycle; set ⇔ `cycle.ending` is "new-session".
	 * Lives beside the cycle, not in it: a reset replaces the cycle and must settle
	 * the waiter (resetCycle), or the command would wait forever.
	 */
	manual: ManualWaiter | null;
}

export function createCapSession(pi: Pick<ExtensionAPI, "sendMessage">): CapSession {
	return { pi, cycle: idleCycle(), resolveCaps: createCapResolver(), lastContextMessages: [], manual: null };
}

/** Settle the waiting /handoff command, if any. */
export function settleManual(s: CapSession, result: ManualResult): void {
	const waiter = s.manual;
	s.manual = null;
	waiter?.resolve(result);
}

/** Back to idle. A /handoff still waiting on this cycle fails with `reason`. */
export function resetCycle(s: CapSession, reason = "the handoff cycle was reset"): void {
	settleManual(s, { ok: false, reason });
	s.cycle = idleCycle();
}

export function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

/**
 * The triggers for THIS check, re-read from the live model each time. Handlers
 * pass the usage they already read: getContextUsage() re-estimates over the whole
 * message array, and near the cap that array is large.
 */
export function capsFrom(s: CapSession, ctx: ExtensionContext, usage: UsageLike): ResolvedTriggers {
	return s.resolveCaps(usage, (message, level) => ctx.ui.notify(message, level));
}

function caps(s: CapSession, ctx: ExtensionContext): ResolvedTriggers {
	return capsFrom(s, ctx, ctx.getContextUsage());
}

export function updateStatus(
	s: CapSession,
	ctx: ExtensionContext,
	tokens: number | null | undefined,
	resolved?: ResolvedTriggers,
): void {
	let suffix = "";
	if (s.cycle.phase === "pending" || s.cycle.phase === "demanded") suffix = " ⚠ handoff";
	else if (s.cycle.phase === "exhausted") suffix = " ⚠ awaiting hard cap";
	ctx.ui.setStatus(CONTEXT_CAP_STATUS_KEY, formatCapStatus(tokens, (resolved ?? caps(s, ctx)).soft, suffix));
}

export function startCycle(s: CapSession, ctx: ExtensionContext, tokens: number, triggerCaps: ResolvedTriggers): void {
	fs.mkdirSync(contextCapDir(), { recursive: true });
	const next = nextPath(sessionId(ctx));
	s.cycle.seq = next.seq;
	s.cycle.expectedPath = next.filePath;
	s.cycle.retries = 0;
	s.cycle.tokensAtTrigger = tokens;
	s.cycle.doc = null;
	s.cycle.cycleCaps = triggerCaps;
}

/**
 * Arm a cap cycle whose demand was just decided and show it. The demand entry
 * itself is committed at the imminent turn_end (lib/context-cap-demand.ts).
 */
export function openCycle(
	s: CapSession,
	ctx: ExtensionContext,
	tokens: number,
	capsNow: ResolvedTriggers,
	origin: Exclude<CycleOrigin, "manual" | "hard">,
): void {
	startCycle(s, ctx, tokens, capsNow);
	s.cycle.origin = origin;
	s.cycle.phase = "pending";
	s.cycle.demandAt = "turn_end";
	updateStatus(s, ctx, tokens, capsNow);
}

/** Caps to stamp on this cycle's artefacts — the cycle's own, or a fresh read if none. */
export function stampCaps(s: CapSession, ctx: ExtensionContext): ResolvedTriggers {
	return s.cycle.cycleCaps ?? caps(s, ctx);
}

/**
 * Estimated size of the recency tail this swap carries, for the marker details
 * and the file frontmatter. Computed from the last LLM-visible context, which
 * is the same array the `context` handler cuts — minus the turn that lands
 * between the two, so treat it as the swap's projection, not a measurement.
 * 0 whenever the lever is off.
 */
export function tailKeptEstimate(s: CapSession): number {
	if (CONTEXT_CAP_TAIL_TOKENS <= 0) return 0;
	return selectContextTail(s.lastContextMessages, s.lastContextMessages.length, CONTEXT_CAP_TAIL_TOKENS).tokens;
}

/**
 * Write this cycle's handoff document, frontmatter stamped from the cycle, and
 * record it as `cycle.doc` — the only source of the successor text, for both
 * endings. Throws on I/O failure (then nothing is recorded).
 */
export function writeCycleHandoff(
	s: CapSession,
	ctx: ExtensionContext,
	filePath: string,
	body: string,
	author: HandoffAuthor,
): void {
	writeHandoff(filePath, body, {
		sessionId: sessionId(ctx),
		seq: s.cycle.seq,
		tokens: s.cycle.tokensAtTrigger,
		author,
		schema: CONTEXT_CAP_SCHEMA,
		tailTokens: CONTEXT_CAP_TAIL_TOKENS,
		tailKeptTokens: tailKeptEstimate(s),
		caps: stampCaps(s, ctx),
	});
	// Byte-identical to the file's body (writeHandoff strips + trims the same way).
	s.cycle.doc = { body: stripFrontmatter(body).trim(), author };
}
