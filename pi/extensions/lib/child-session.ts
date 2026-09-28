// Shared plumbing for child-session tools (Agent, Explore): the shared child
// registry (liveChildren) and busy-group semaphore, and runChildTool — resolve a
// child (spawn, or resume a live/evicted one), run one prompt on it, report back.
// Session construction lives in lib/child-create.ts, eviction/reopen in
// lib/child-reopen.ts, agent-runs rows and meta text in lib/child-runs.ts.
//
// Not an extension: pi's loader only scans top-level *.ts in the extensions dir
// (core/package-manager.js collectAutoExtensionEntries), so files under lib/ are
// never loaded as extensions and need no default export.
import { randomUUID } from "node:crypto";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RunStatus } from "./agent-runs.ts";
import { type BusyGroup, busyGroup, releaseSlot, tryAcquireSlot } from "./child-busy.ts";
import { createChildSession } from "./child-create.ts";
import { evictFinishedChildren, freshHint, reopenEvictedChild } from "./child-reopen.ts";
import {
	collectMeta,
	metaLine,
	type RunMeta,
	rootSidFor,
	statusLine,
	writeFinishEvent,
	writeProgressEvent,
	writeSpawnEvent,
} from "./child-runs.ts";
import type { ChildRecord, ChildRegistry, ChildToolParams, RunChildOptions } from "./child-types.ts";
import { ChildView } from "./child-view.ts";
import { messageText } from "./message-text.ts";
import { sharedState } from "./shared-state.ts";
import { waitForSessionQuiet } from "./session-quiet.ts";

export const AGENT_TOOL = "Agent";
export const EXPLORE_TOOL = "Explore";

// State lives on globalThis, NOT in module scope: pi's extension loader creates a
// fresh jiti instance with `moduleCache: false` per extension file, so subagent.ts
// and explore.ts each import their own *copy* of this module (same reasoning as
// lib/shared-state.ts). Module-level state would split into per-copy islands:
// explorers would be invisible to the F2 watch (registered via subagent.ts's copy)
// and session_shutdown would clear only agent children.
// The registry fields (liveChildren/evicted/reopening) are documented on
// ChildRegistry (lib/child-types.ts); lib/child-reopen.ts gets `state` passed in.
interface SharedState extends ChildRegistry {
	busyGroups: Map<string, BusyGroup>;
}
// Versioned key: whenever SharedState's shape changes, bump it. jiti re-imports this
// module on every session bind (moduleCache: false), so in a long-lived pi process an
// old code copy may still hold the previous shape under the previous symbol — old and
// new copies must never share a mis-shaped state object.
// v7: ChildView gained handoffCount/handoffAnchors (read by the watch overlay);
// ChildRecord gained the optional runStartedAt (readers treat undefined as "not running").
// v8: the child-session ALS (childSessionStore) moved to lib/child-context.ts and the F2
// watchCursor to lib/child-watch.ts, each under its own key.
// (Still v8 after the child-busy/child-reopen/child-types split: the object's shape
// is unchanged, only its interfaces moved.)
const STATE_KEY = Symbol.for("terminal-setup.child-session.v8");
const state = sharedState<SharedState>(STATE_KEY, () => ({
	liveChildren: new Map(),
	evicted: new Map(),
	reopening: new Set(),
	busyGroups: new Map(),
}));

/** Session teardown: drop child records and busy-latch counters (see subagent.ts). */
export function resetChildState(): void {
	state.liveChildren.clear();
	state.evicted.clear();
	state.reopening.clear();
	state.busyGroups.clear();
}

export const liveChildren = state.liveChildren;

type ChildUpdate = ((partial: ReturnType<typeof textResult>) => void) | undefined;

function watchChild(record: ChildRecord, onUpdate: ChildUpdate): { text(): string; pushStatus(): void; stop(): void } {
	const parts: string[] = [];
	const pushStatus = () => onUpdate?.(textResult(statusLine(record), { id: record.id }));
	const unsub = record.session.subscribe((event: AgentSessionEvent) => {
		record.view.handle(event);
		trackChildActivity(record, event, pushStatus);
		if (event.type === "message_end") parts.push(...assistantTexts(event.message));
	});
	pushStatus();
	return {
		pushStatus,
		text: () => {
			for (let i = parts.length - 1; i >= 0; i--) {
				const part = parts[i]?.trim();
				if (part) return part;
			}
			return "";
		},
		stop: unsub,
	};
}

/** Turn count, current tool, progress rows and live status of a running child. */
function trackChildActivity(record: ChildRecord, event: AgentSessionEvent, pushStatus: () => void): void {
	switch (event.type) {
		case "turn_end":
			record.currentTool = undefined;
			// Before turns++: the progress row's `turn` is the turn that just ended.
			writeProgressEvent(record);
			record.turns++;
			pushStatus();
			break;
		case "tool_execution_start":
			record.currentTool = event.toolName;
			writeProgressEvent(record);
			pushStatus();
			break;
		case "tool_execution_end":
			record.currentTool = undefined;
			pushStatus();
			break;
	}
}

/** The non-blank text blocks of an assistant message (none for other roles). */
function assistantTexts(message: { role: string }): string[] {
	if (message.role !== "assistant") return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return (content as Array<{ type?: string; text?: string }>).filter(isNonBlankText).map((block) => block.text);
}

function isNonBlankText(block: { type?: string; text?: string }): block is { type: "text"; text: string } {
	return block?.type === "text" && !!block.text?.trim();
}

function labelFromPrompt(prompt: string): string {
	const firstLine = prompt.split("\n").find((line) => line.trim()) ?? "agent task";
	const words = firstLine.trim().split(/\s+/).slice(0, 5).join(" ");
	return words.length > 48 ? `${words.slice(0, 47)}\u2026` : words;
}

export function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text }] as TextContent[],
		details,
		...(isError && { isError: true }),
	};
}

/** Shared execute() body for child-session tools. */
export async function runChildTool(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ChildUpdate,
	ctx: ExtensionContext,
) {
	const group = busyGroup(state.busyGroups, options.busyGroup);
	if (!tryAcquireSlot(group, options.concurrency)) {
		return textResult(
			options.busyMessage ??
				`Another ${options.kind} is already running. ${options.kind} calls are serialized — wait for the running one's result, then call again.`,
			{ error: "child_busy" },
			true,
		);
	}
	// This call's own child session, captured for the wind-down below. Local per call —
	// a shared slot on the group would cross-wire concurrent explorers.
	let childSession: AgentSession | undefined;
	try {
		return await runChildToolInSlot(params, options, signal, onUpdate, ctx, (session) => {
			childSession = session;
		});
	} finally {
		releaseSlot(group, childSession);
	}
}

/** A resolved child for this call, or the tool result that ends the call instead. */
type ResolvedChild = { record: ChildRecord } | { result: ReturnType<typeof textResult> };

async function runChildToolInSlot(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ChildUpdate,
	ctx: ExtensionContext,
	onSession: (session: AgentSession) => void,
) {
	// Both steps hand back the record already claimed (running = true), set in the
	// same synchronous stretch as their checks: the await here yields, and in that
	// gap a concurrent resume or another spawn's eviction must see it as running.
	const resolved: ResolvedChild = params.resume_id
		? await resumeChildRecord(params.resume_id, params.description, options, ctx)
		: { record: await spawnChildRecord(params, options, ctx) };
	if ("result" in resolved) return resolved.result;
	onSession(resolved.record.session);
	return runChildRecord(resolved.record, params, options, signal, onUpdate);
}

/**
 * Resume `resumeId` for this call: the live child, or an evicted/pre-restart one
 * reopened from its session file. Claims it (running = true) on success; returns
 * an error result when it is unknown, of another kind, or still running.
 */
async function resumeChildRecord(
	resumeId: string,
	description: string | undefined,
	options: RunChildOptions,
	ctx: ExtensionContext,
): Promise<ResolvedChild> {
	// Reservation first: a reopen in flight is running even once its record is
	// already in liveChildren (inserted with running: true, see reopenChild).
	if (state.reopening.has(resumeId)) return stillRunning(options.kind, resumeId);
	const existing = liveChildren.get(resumeId);
	let record: ChildRecord;
	if (existing) {
		// No await between this check and the claim below.
		const live = resumableLiveChild(existing, resumeId, options.kind);
		if ("result" in live) return live;
		record = live.record;
	} else {
		const reopened = await reopenEvictedChild(resumeId, options, ctx, state);
		if ("error" in reopened) return unknownResume(reopened.error);
		record = reopened;
	}
	if (description) record.description = description;
	record.running = true;
	return { record };
}

/** `existing` if this call may resume it now (synchronous: the caller claims it right after). */
function resumableLiveChild(existing: ChildRecord, resumeId: string, kind: string): ResolvedChild {
	if (existing.kind !== kind) {
		return unknownResume(
			`No ${kind} session with id "${resumeId}" (that id is a ${existing.kind}). ${freshHint(kind)}`,
		);
	}
	// With explorers running in parallel, two calls can pass the semaphore and
	// resume the same child at once — session.prompt() on a busy session throws,
	// and the loser's wind-down would mark the winner's record as not running.
	// Also covers a session still draining after an abort.
	if (existing.running || !existing.session.isIdle) return stillRunning(kind, resumeId);
	return { record: existing };
}

function unknownResume(text: string): ResolvedChild {
	return { result: textResult(text, { error: "unknown_resume_id" }, true) };
}

function stillRunning(kind: string, resumeId: string): ResolvedChild {
	return {
		result: textResult(
			`${kind} "${resumeId}" is still running. Wait for its result, then resume it.`,
			{ error: "child_running" },
			true,
		),
	};
}

/** Spawn a fresh child session, register it (+ spawn row) and claim it (running = true). */
async function spawnChildRecord(
	params: ChildToolParams,
	options: RunChildOptions,
	ctx: ExtensionContext,
): Promise<ChildRecord> {
	evictFinishedChildren(state);
	const id = randomUUID().slice(0, 8);
	const session = await createChildSession(ctx, options);
	session.setSessionName(`${options.kind}#${id}`);
	// Spawner = the session whose tool call runs right now: the main session, or
	// an agent child when its own Explore call lands here (ctx is then the child's
	// ExtensionContext). Optional chain: unit tests pass bare fake contexts.
	const spawnerSid = ctx.sessionManager?.getSessionId();
	const sid = session.sessionManager.getSessionId();
	const record: ChildRecord = {
		id,
		kind: options.kind,
		sid,
		rootSid: spawnerSid ? rootSidFor(liveChildren, spawnerSid) : sid,
		session,
		view: new ChildView(session, ctx.cwd),
		description: params.description ?? labelFromPrompt(params.prompt),
		turns: 0,
		elapsedMs: 0,
		running: false,
	};
	liveChildren.set(id, record);
	if (spawnerSid) writeSpawnEvent(record, spawnerSid);
	record.running = true;
	return record;
}

/**
 * Run one prompt on a claimed record and do the run's bookkeeping: elapsed time,
 * runStartedAt and the agent-runs finish row.
 */
async function runChildRecord(
	record: ChildRecord,
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ChildUpdate,
) {
	const watcher = startRun(record, params.prompt, onUpdate);
	const onAbort = () => void record.session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const startedAt = Date.now();
	record.runStartedAt = startedAt;
	let failed = false;
	try {
		await record.session.prompt(params.prompt);
		// prompt() resolving means the model stopped calling tools; a queued
		// steer/follow-up may still be about to run (lib/session-quiet.ts).
		await waitForSessionQuiet(record.session, signal);
	} catch (error) {
		failed = true; // finish row must say "error", not "done"
		throw error;
	} finally {
		record.elapsedMs += Date.now() - startedAt;
		record.runStartedAt = undefined;
		watcher.stop();
		record.running = false;
		record.currentTool = undefined;
		signal?.removeEventListener("abort", onAbort);
		// After elapsedMs is final: the finish row carries this run's cumulative numbers.
		writeFinishEvent(record, runStatus(signal, failed));
	}
	return childRunResult(record, options.kind, watcher.text(), signal);
}

/** Show the prompt and start watching the child's events for this run. */
function startRun(record: ChildRecord, prompt: string, onUpdate: ChildUpdate): ReturnType<typeof watchChild> {
	try {
		// The child gets the task verbatim: the delegate contract rides the system
		// prompt (options.contract, injected per turn by subagent.ts), not the prompt.
		record.view.addUserMessage(prompt);
		return watchChild(record, onUpdate);
	} catch (error) {
		// Before the run's own finally: never leave a stale running=true record
		// (it would block every later resume and be exempt from eviction).
		record.running = false;
		throw error;
	}
}

function runStatus(signal: AbortSignal | undefined, failed: boolean): RunStatus {
	return signal?.aborted ? "cancelled" : failed ? "error" : "done";
}

function childRunResult(record: ChildRecord, kind: string, text: string, signal: AbortSignal | undefined) {
	return textResult(
		`${text || `(${kind} produced no text output)`}\n\n---\n${kind} id: ${record.id} (pass as resume_id to continue)`,
		{ ...collectMeta(record), aborted: signal?.aborted === true },
	);
}

/** Shared renderResult() for child-session tools. */
export function renderChildResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
	theme: Pick<Theme, "fg">,
	context: { lastComponent?: unknown },
) {
	const text = messageText(result.content);
	const meta = result.details as RunMeta | undefined;
	const summary = meta?.kind ? theme.fg("toolTitle", metaLine(meta)) : "";
	const body = theme.fg("toolOutput", text);
	const component = (context.lastComponent as Text) ?? new Text("", 0, 0);
	component.setText([summary, body].filter(Boolean).join("\n"));
	return component;
}
