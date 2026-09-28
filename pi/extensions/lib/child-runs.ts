// A child run's bookkeeping: its agent-runs.jsonl rows (spawn/progress/finish —
// the dashboard data layer) and the meta/status text built from a ChildRecord
// (tool result details, F2 picker and header lines).
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { appendEvent, type RunStatus } from "./agent-runs.ts";
import type { ChildRecord } from "./child-types.ts";
import { CONTEXT_CAP_TOOL_NAME } from "./env.ts";
import { formatTokenCount } from "./format.ts";

export interface RunMeta {
	id: string;
	kind: string;
	turns: number;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	resets: number;
	costUsd: number;
	durationMs: number;
}

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function countCompactions(session: AgentSession): number {
	let compactions = 0;
	for (const entry of session.sessionManager.getEntries() as Array<{ type?: string }>) {
		if (entry?.type === "compaction") compactions++;
	}
	return compactions;
}

function countContextCapCalls(session: AgentSession): number {
	let calls = 0;
	for (const message of session.messages) calls += contextCapCallsIn(message);
	return calls;
}

function contextCapCallsIn(message: { role: string }): number {
	if (message.role !== "assistant") return 0;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let calls = 0;
	for (const block of content as Array<{ type?: string; name?: string }>) {
		if (block?.type === "toolCall" && block.name === CONTEXT_CAP_TOOL_NAME) calls++;
	}
	return calls;
}

/** Context resets of a child: pi compactions plus context-cap handoff tool calls. */
function countResets(session: AgentSession): number {
	return countCompactions(session) + countContextCapCalls(session);
}

export function collectMeta(record: ChildRecord): RunMeta {
	const stats = record.session.getSessionStats();
	const usage = record.session.getContextUsage();
	return {
		id: record.id,
		kind: record.kind,
		turns: record.turns,
		contextTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? 0,
		contextPercent: usage?.percent ?? null,
		resets: countResets(record.session),
		costUsd: stats.cost,
		durationMs: record.elapsedMs,
	};
}

// --- agent-runs.jsonl writers (dashboard data layer — docs/agent-dashboard-spec.md).
// The index lives in the same dir as the session files; appendEvent no-ops for
// in-memory sessions (dir ""), which keeps harness-based tests off the disk.

/** Coarse heartbeat rate: at most one progress row per child per this interval. */
const PROGRESS_THROTTLE_MS = 2_000;

/** Written once per child, right after its record is registered. */
export function writeSpawnEvent(record: ChildRecord, parentSid: string): void {
	const manager = record.session.sessionManager;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) return; // in-memory child: no transcript to index
	appendEvent(manager.getSessionDir(), {
		ts: Date.now(),
		event: "spawn",
		sid: record.sid,
		root: record.rootSid,
		parentSid,
		kind: record.kind,
		label: `${record.kind}#${record.id}`,
		sessionFile,
		description: record.description,
	});
}

/** Heartbeat on turn end / tool change — throttled, so the disk suffices for a live view. */
export function writeProgressEvent(record: ChildRecord): void {
	const now = Date.now();
	if (now - (record.lastProgressAt ?? 0) < PROGRESS_THROTTLE_MS) return;
	record.lastProgressAt = now;
	appendEvent(record.session.sessionManager.getSessionDir(), {
		ts: now,
		event: "progress",
		sid: record.sid,
		turn: record.turns + 1,
		...(record.currentTool !== undefined && { tool: record.currentTool }),
	});
}

/** Written every time a run settles; numbers are cumulative (last row per sid wins). */
export function writeFinishEvent(record: ChildRecord, status: RunStatus): void {
	const meta = collectMeta(record);
	appendEvent(record.session.sessionManager.getSessionDir(), {
		ts: Date.now(),
		event: "finish",
		sid: record.sid,
		status,
		turns: meta.turns,
		costUsd: meta.costUsd,
		contextTokens: meta.contextTokens,
		contextPercent: meta.contextPercent,
		resets: meta.resets,
		durationMs: meta.durationMs,
	});
}

/**
 * Root sid for a child about to be spawned by `spawnerSid`: when the spawner is
 * itself a live child (agent spawning explorers — its record is in the shared
 * liveChildren map), the tree root is the spawner's own root; otherwise the
 * spawner IS the main session and thus the root.
 */
export function rootSidFor(liveChildren: ReadonlyMap<string, ChildRecord>, spawnerSid: string): string {
	for (const record of liveChildren.values()) {
		if (record.sid === spawnerSid) return record.rootSid;
	}
	return spawnerSid;
}

export function metaLine(meta: RunMeta): string {
	const context =
		meta.contextTokens === null
			? "ctx ?"
			: `ctx ${formatTokenCount(meta.contextTokens)}/${formatTokenCount(meta.contextWindow)}${
					meta.contextPercent === null ? "" : ` (${Math.round(meta.contextPercent)}%)`
				}`;
	return [
		`${meta.kind}#${meta.id}`,
		`${meta.turns} turns`,
		context,
		`${meta.resets} resets`,
		`$${meta.costUsd.toFixed(3)}`,
		formatDuration(meta.durationMs),
	].join(" \u00b7 ");
}

export function statusLine(record: ChildRecord): string {
	const activity = record.currentTool ? `running ${record.currentTool}` : "thinking";
	return `${record.kind}#${record.id} · ${record.description} · turn ${record.turns + 1} · ${activity}`;
}
