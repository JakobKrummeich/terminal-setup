// Types shared by the child-session modules (child-session, child-create,
// child-reopen, child-runs) and their readers (F2 watch, tests). Type-only, so
// every module can import it without creating an import cycle.
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildView } from "./child-view.ts";

/** A model as handed out by ExtensionContext.modelRegistry. */
export type ChildModel = NonNullable<ExtensionContext["model"]>;

/** Thinking level as the session runtime knows it (re-derived: the canonical type lives in pi-agent-core). */
export type ChildThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export interface ChildRecord {
	id: string;
	kind: string;
	/** The child's session uuid (sessionManager.getSessionId()) — `sid` in agent-runs.jsonl. */
	sid: string;
	/**
	 * The main session's sid for this spawn tree — `root` in agent-runs.jsonl.
	 * A child spawned by another child inherits the spawner's rootSid; falls back
	 * to the child's own sid when the spawner is unknown (bare test contexts).
	 */
	rootSid: string;
	session: AgentSession;
	view: ChildView;
	description: string;
	turns: number;
	elapsedMs: number;
	currentTool?: string;
	running: boolean;
	/**
	 * Epoch ms the current run started (runChildRecord); undefined between runs.
	 * elapsedMs only grows when a run ends — liveElapsedMs adds the running part.
	 */
	runStartedAt?: number;
	/** Epoch ms of the last agent-runs.jsonl progress row (write throttle). */
	lastProgressAt?: number;
}

/**
 * Where an evicted (or pre-restart) child lives on disk, plus the record fields
 * to restore when it is reopened. Built from an eviction tombstone or from the
 * child's agent-runs.jsonl spawn/finish rows.
 */
export interface ChildSource {
	id: string;
	kind: string;
	sid: string;
	rootSid: string;
	/** undefined for in-memory sessions (never persisted). */
	sessionFile: string | undefined;
	description: string;
	turns: number;
	elapsedMs: number;
}

/**
 * The child registry part of child-session.ts's shared state (its SharedState
 * extends this). Passed explicitly to lib/child-reopen.ts, which evicts and
 * reopens children but does not own the state.
 */
export interface ChildRegistry {
	/**
	 * All children of this pi session: running/settling entries plus at most
	 * MAX_FINISHED_CHILDREN finished ones. Older finished children are evicted
	 * when a fresh child spawns (memory cap: each record holds a full AgentSession
	 * — whose SessionManager keeps the whole transcript in memory — plus a
	 * rendered ChildView). Eviction is lossless: a later resume_id reopens the
	 * child from its session file (see reopenChild).
	 */
	liveChildren: Map<string, ChildRecord>;
	/**
	 * Tombstones of evicted children, keyed by child id: everything needed to
	 * reopen one from disk. Deleted when the child is reopened. Small records, so
	 * unbounded for the pi session's lifetime (cleared by resetChildState).
	 */
	evicted: Map<string, ChildSource>;
	/**
	 * Ids currently being reopened (reserved synchronously before the first await).
	 * Never placeholders in liveChildren — the record appears there only once the
	 * session exists, so eviction/watch/picker code never sees half-built entries.
	 */
	reopening: Set<string>;
}

export interface ChildSessionOptions {
	/** Model for the child. Defaults to the parent's model. */
	model?: ChildModel;
	/** Thinking level for the child. Defaults to the parent's level. */
	thinkingLevel?: ChildThinkingLevel;
	/** Allowlist of tool names — only these are enabled. Omit for the full default set. */
	tools?: string[];
	/** Tools the child must not have. */
	excludeTools: string[];
}

export interface ChildToolParams {
	prompt: string;
	description?: string;
	resume_id?: string;
}

export interface RunChildOptions extends ChildSessionOptions {
	/** Shown in ids, status and meta lines, e.g. "agent". */
	kind: string;
	/** Semaphore group, e.g. "agent" or "explorer". At most `concurrency` children per group. */
	busyGroup: string;
	/** Max concurrent children in the group. Default 1 (strict serialization). */
	concurrency?: number;
	/** Full rejection text when the group is at its limit. Default: the serialized-calls message. */
	busyMessage?: string;
	/**
	 * Appended to the child's system prompt every turn (survives context-cap swaps);
	 * the delegate role and output contract. Injection happens in subagent.ts's
	 * before_agent_start handler — the prompt itself is never touched.
	 */
	contract?: string;
}
