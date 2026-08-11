/**
 * Dashboard HTTP API — response shapes and their derivation from the
 * agent-runs.jsonl event index (docs/agent-dashboard-spec.md, "API (v1)").
 *
 * This is THE contract module: every /api/* response body is one of the
 * *Response types below. Derivation is pure — events in, JSON-able data out;
 * the only I/O crosses the `statsFor` callback (session-transcript.ts's
 * readSessionStats), injected so these functions stay testable and this module
 * needs no runtime import of the JSONL parser.
 *
 * Consumer tolerances (mirrors lib/agent-runs.ts docs): events may trail a
 * sid's finish row, rows for vanished session files are pruned before we ever
 * see them, and unknown event types are ignored (default switch arms).
 */
import type { AgentRunEvent, RunFinish, RunSessionStart, RunSpawn, RunStatus } from "./agent-runs.ts";

/**
 * Liveness heuristic (deliberately simple and honest): a tree counts as
 * "running" iff its last observed activity — the newest index event ts of any
 * node in the tree, or the root session file's mtime, whichever is later — is
 * younger than this window. The main session writes no progress heartbeats, but
 * every assistant message append bumps its file mtime; children heartbeat per
 * turn/tool. Cost: a session idle at the prompt flips to "finished" after this
 * window and flips back on the next message; a single silent turn longer than
 * the window shows "finished" until its message lands. Accepted for v1.
 */
export const ACTIVE_WINDOW_MS = 120_000;

/** What deriveSessions/deriveTree need from a session JSONL (see readSessionStats). */
export interface SessionFileStats {
	/** Σ usage.cost.total over the file's assistant/compaction entries. */
	costUsd: number;
	/** Number of assistant messages — "turns" for the main-session node. */
	turns: number;
	/** File mtime, feeds the ACTIVE_WINDOW_MS liveness heuristic. */
	mtimeMs: number;
}
export type StatsFor = (sessionFile: string) => SessionFileStats | null;

// --- GET /api/sessions -------------------------------------------------------

/** One landing-page row per tree root (main session). */
export interface SessionRow {
	sid: string;
	startTs: number;
	/** ACTIVE_WINDOW_MS heuristic above. Pinning running rows on top is the client's job. */
	running: boolean;
	/** startTs → last activity (running: → now). */
	durationMs: number;
	/** Main session's own JSONL cost + Σ last-finish costUsd of its children. Running children not yet counted. */
	costUsd: number;
	/** Spawn rows in the tree — agents AND explorers. */
	agentCount: number;
	/** Context-cap resets across the whole tree (root included). */
	resetCount: number;
}

/** Sorted newest first (startTs desc). */
export interface SessionsResponse {
	sessions: SessionRow[];
}

// --- GET /api/tree?root=<sid> ------------------------------------------------

/**
 * `abandoned`: node never settled (no finish covering its latest activity) and
 * the tree is stale — typically the owning pi process died mid-run.
 */
export type TreeNodeStatus = RunStatus | "running" | "abandoned";

/** One Gantt bar / tree row. The root node has kind "main" and parentSid null. */
export interface TreeNode {
	sid: string;
	label: string;
	kind: string;
	description: string;
	parentSid: string | null;
	startTs: number;
	/** null while running. */
	endTs: number | null;
	status: TreeNodeStatus;
	/** Children: last finish row's cumulative cost. Root: own JSONL cost. null = not known (yet). */
	costUsd: number | null;
	/** Count of reset events (more current than finish.resets, which may lag by one). */
	resets: number;
	turns: number;
}

/** Nodes in index order (root first when its rows survived pruning). */
export interface TreeResponse {
	root: string;
	nodes: TreeNode[];
}

// --- GET /api/transcript?sid=<sid> -------------------------------------------

export interface TranscriptToolCall {
	name: string;
	/** JSON.stringify of the call arguments, truncated. */
	argsSummary: string;
	/** Matched toolResult text, truncated to ~2000 chars; "" until the result lands. */
	output: string;
}

export interface TranscriptEntry {
	role: "user" | "assistant";
	text: string;
	toolCalls: TranscriptToolCall[];
	/** Message timestamp (epoch ms), null when the line carried none. Correlates with Gantt/anchors. */
	tsMs: number | null;
}

export type TranscriptAnchorType = "handoff" | "agent-spawn" | "explorer-spawn";

/** Sidebar jump target: the entry at/just before the event. */
export interface TranscriptAnchor {
	type: TranscriptAnchorType;
	entryIndex: number;
	/** Spawn anchors: the child's sid — links into the child's own transcript. */
	targetSid?: string;
	/** Spawn anchors: the child's display label, e.g. "agent#3ce02a1b". */
	label?: string;
	/** Spawn anchors: the child's task description. */
	description?: string;
}

export interface TranscriptResponse {
	sid: string;
	entries: TranscriptEntry[];
	/** Sorted by entryIndex. */
	anchors: TranscriptAnchor[];
}

// --- derivation --------------------------------------------------------------

/** Everything the index told us about one sid, folded once in indexByRoot. */
interface SidAgg {
	sessionStart?: RunSessionStart;
	spawn?: RunSpawn;
	/** Latest finish row — cumulative totals, so the last one is authoritative. */
	lastFinish?: RunFinish;
	/** Latest spawn/progress ts — "was actually running" activity (resets don't count: they can trail a finish). */
	lastRunTs: number;
	lastEventTs: number;
	maxTurn: number;
	resets: number;
}

interface RootAgg {
	root: string;
	/** Earliest ts seen — startTs fallback when the root's own rows were pruned. */
	firstTs: number;
	/** sid → agg, in first-seen (file) order; may lack the root sid itself. */
	sids: Map<string, SidAgg>;
}

function emptySidAgg(): SidAgg {
	return { lastRunTs: 0, lastEventTs: 0, maxTurn: 0, resets: 0 };
}

function applyEvent(agg: SidAgg, event: AgentRunEvent): void {
	agg.lastEventTs = Math.max(agg.lastEventTs, event.ts);
	switch (event.event) {
		case "session-start":
			agg.sessionStart ??= event;
			break;
		case "spawn":
			agg.spawn ??= event;
			agg.lastRunTs = Math.max(agg.lastRunTs, event.ts);
			break;
		case "progress":
			agg.lastRunTs = Math.max(agg.lastRunTs, event.ts);
			agg.maxTurn = Math.max(agg.maxTurn, event.turn);
			break;
		case "reset":
			agg.resets += 1;
			break;
		case "finish":
			if (!agg.lastFinish || event.ts >= agg.lastFinish.ts) agg.lastFinish = event;
			break;
		default:
			break; // future event types: tolerated, ignored
	}
}

/** Group events into per-root aggregates. Events for sids with no known root (foreign lines) are dropped. */
function indexByRoot(events: AgentRunEvent[]): Map<string, RootAgg> {
	const rootBySid = new Map<string, string>();
	const roots = new Map<string, RootAgg>();
	for (const event of events) {
		if (event.event === "session-start") rootBySid.set(event.sid, event.sid);
		if (event.event === "spawn") rootBySid.set(event.sid, event.root);
		const root = rootBySid.get(event.sid);
		if (root === undefined) continue;
		let agg = roots.get(root);
		if (!agg) {
			agg = { root, firstTs: event.ts, sids: new Map() };
			roots.set(root, agg);
		}
		agg.firstTs = Math.min(agg.firstTs, event.ts);
		let sidAgg = agg.sids.get(event.sid);
		if (!sidAgg) {
			sidAgg = emptySidAgg();
			agg.sids.set(event.sid, sidAgg);
		}
		applyEvent(sidAgg, event);
	}
	return roots;
}

/** Newest index event across the tree vs the root file's mtime — see ACTIVE_WINDOW_MS. */
function treeLastActivity(agg: RootAgg, mtimeMs: number | null): number {
	let last = mtimeMs ?? 0;
	for (const sidAgg of agg.sids.values()) last = Math.max(last, sidAgg.lastEventTs);
	return last;
}

function summarizeRoot(agg: RootAgg, now: number, statsFor: StatsFor): SessionRow {
	const rootAgg = agg.sids.get(agg.root);
	const file = rootAgg?.sessionStart?.sessionFile;
	const stats = file ? statsFor(file) : null;
	const startTs = rootAgg?.sessionStart?.ts ?? agg.firstTs;
	const lastActivity = treeLastActivity(agg, stats?.mtimeMs ?? null);
	let costUsd = stats?.costUsd ?? 0;
	let agentCount = 0;
	let resetCount = 0;
	for (const [sid, sidAgg] of agg.sids) {
		if (sidAgg.spawn) agentCount += 1;
		resetCount += sidAgg.resets;
		if (sid !== agg.root && sidAgg.lastFinish) costUsd += sidAgg.lastFinish.costUsd;
	}
	const running = now - lastActivity < ACTIVE_WINDOW_MS;
	return {
		sid: agg.root,
		startTs,
		running,
		durationMs: Math.max(0, (running ? now : lastActivity) - startTs),
		costUsd,
		agentCount,
		resetCount,
	};
}

/** GET /api/sessions body. */
export function deriveSessions(events: AgentRunEvent[], now: number, statsFor: StatsFor): SessionsResponse {
	const sessions = [...indexByRoot(events).values()].map((agg) => summarizeRoot(agg, now, statsFor));
	sessions.sort((a, b) => b.startTs - a.startTs);
	return { sessions };
}

/** The root's own row: no finish events exist for it, so status is running|done by tree activity. */
function rootNode(agg: RootAgg, now: number, statsFor: StatsFor): TreeNode {
	const rootAgg = agg.sids.get(agg.root);
	const file = rootAgg?.sessionStart?.sessionFile;
	const stats = file ? statsFor(file) : null;
	const lastActivity = treeLastActivity(agg, stats?.mtimeMs ?? null);
	const running = now - lastActivity < ACTIVE_WINDOW_MS;
	return {
		sid: agg.root,
		label: "main",
		kind: "main",
		description: "",
		parentSid: null,
		startTs: rootAgg?.sessionStart?.ts ?? agg.firstTs,
		endTs: running ? null : lastActivity,
		status: running ? "running" : "done",
		costUsd: stats?.costUsd ?? null,
		resets: rootAgg?.resets ?? 0,
		turns: stats?.turns ?? 0,
	};
}

/** A spawned child's row. `settled` = latest finish covers all run activity (spawn/progress). */
function childNode(sidAgg: SidAgg, spawn: RunSpawn, now: number): TreeNode {
	const finish = sidAgg.lastFinish;
	const settled = finish !== undefined && finish.ts >= sidAgg.lastRunTs;
	const stale = now - sidAgg.lastEventTs >= ACTIVE_WINDOW_MS;
	let status: TreeNodeStatus;
	let endTs: number | null;
	if (settled) {
		status = finish.status;
		endTs = finish.ts;
	} else {
		status = stale ? "abandoned" : "running";
		endTs = stale ? sidAgg.lastEventTs : null;
	}
	return {
		sid: spawn.sid,
		label: spawn.label,
		kind: spawn.kind,
		description: spawn.description,
		parentSid: spawn.parentSid,
		startTs: spawn.ts,
		endTs,
		status,
		costUsd: finish?.costUsd ?? null,
		resets: sidAgg.resets,
		turns: Math.max(sidAgg.maxTurn, finish?.turns ?? 0),
	};
}

/** GET /api/tree body; null when the root sid has no rows in the index. */
export function deriveTree(events: AgentRunEvent[], root: string, now: number, statsFor: StatsFor): TreeResponse | null {
	const agg = indexByRoot(events).get(root);
	if (!agg) return null;
	const nodes: TreeNode[] = [rootNode(agg, now, statsFor)];
	for (const [sid, sidAgg] of agg.sids) {
		if (sid === agg.root || !sidAgg.spawn) continue; // non-root rows always have a spawn intro (readRuns prunes orphans)
		nodes.push(childNode(sidAgg, sidAgg.spawn, now));
	}
	return { root, nodes };
}

/** First intro row (session-start | spawn) naming this sid's transcript file. */
export function sessionFileFor(events: AgentRunEvent[], sid: string): string | null {
	for (const event of events) {
		if ((event.event === "session-start" || event.event === "spawn") && event.sid === sid) return event.sessionFile;
	}
	return null;
}

/** Last entry at-or-before ts (entries with unknown ts skipped); 0 when none. */
function nearestEntryIndex(entryTs: readonly (number | null)[], ts: number): number {
	let best = 0;
	for (let i = 0; i < entryTs.length; i++) {
		const t = entryTs[i];
		if (t !== null && t <= ts) best = i;
	}
	return best;
}

/**
 * Anchors for children spawned BY session `sid`, placed at the transcript entry
 * nearest each spawn's ts. Kinds other than "explorer" map to agent-spawn —
 * kind is an open set and agents are the general case.
 */
export function deriveSpawnAnchors(
	events: AgentRunEvent[],
	sid: string,
	entryTs: readonly (number | null)[],
): TranscriptAnchor[] {
	const anchors: TranscriptAnchor[] = [];
	for (const event of events) {
		if (event.event !== "spawn" || event.parentSid !== sid) continue;
		anchors.push({
			type: event.kind === "explorer" ? "explorer-spawn" : "agent-spawn",
			entryIndex: nearestEntryIndex(entryTs, event.ts),
			targetSid: event.sid,
			label: event.label,
			description: event.description,
		});
	}
	return anchors;
}
