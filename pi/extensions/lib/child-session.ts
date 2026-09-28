// Shared plumbing for child-session tools (Agent, Explore).
//
// Not an extension: pi's loader only scans top-level *.ts in the extensions dir
// (core/package-manager.js collectAutoExtensionEntries), so files under lib/ are
// never loaded as extensions and need no default export.
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { appendEvent, findSpawnsByLabel, type RunStatus } from "./agent-runs.ts";
import { type ChildSessionInfo, runInChildSession } from "./child-context.ts";
import { ChildView, formatTokenCount } from "./child-view.ts";
import { messageText } from "./message-text.ts";
import { sharedState } from "./shared-state.ts";
import { waitForSessionQuiet } from "./session-quiet.ts";
import { CONTEXT_CAP_TOOL_NAME } from "./env.ts";

export const AGENT_TOOL = "Agent";
export const EXPLORE_TOOL = "Explore";
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

/** Counting semaphore for one group of children (see busyGroup() below). */
interface BusyGroup {
	/** Children currently holding a slot (running or still winding down). */
	active: number;
	/** Max concurrent children; refreshed on every runChildTool call. */
	limit: number;
	/** Sessions still winding down after their tool call returned; each keeps its slot. */
	settling: Set<AgentSession>;
}

// State lives on globalThis, NOT in module scope: pi's extension loader creates a
// fresh jiti instance with `moduleCache: false` per extension file, so subagent.ts
// and explore.ts each import their own *copy* of this module (same reasoning as
// lib/shared-state.ts). Module-level state would split into per-copy islands:
// explorers would be invisible to the F2 watch (registered via subagent.ts's copy)
// and session_shutdown would clear only agent children.
interface SharedState {
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

function watchChild(
	record: ChildRecord,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
): { text(): string; pushStatus(): void; stop(): void } {
	const parts: string[] = [];
	const pushStatus = () => onUpdate?.(textResult(statusLine(record), { id: record.id }));
	const unsub = record.session.subscribe((event: AgentSessionEvent) => {
		record.view.handle(event);
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
			case "message_end":
				if (event.message.role === "assistant") {
					const content = (event.message as { content?: unknown }).content;
					if (Array.isArray(content)) {
						for (const block of content as Array<{ type?: string; text?: string }>) {
							if (block?.type === "text" && block.text?.trim()) parts.push(block.text);
						}
					}
				}
				break;
		}
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

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function countResets(session: AgentSession): number {
	let resets = 0;
	for (const entry of session.sessionManager.getEntries() as Array<{ type?: string }>) {
		if (entry?.type === "compaction") resets++;
	}
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string }>) {
			if (block?.type === "toolCall" && block.name === CONTEXT_CAP_TOOL_NAME) resets++;
		}
	}
	return resets;
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
function writeSpawnEvent(record: ChildRecord, parentSid: string): void {
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
function writeProgressEvent(record: ChildRecord): void {
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
function writeFinishEvent(record: ChildRecord, status: RunStatus): void {
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
function rootSidFor(spawnerSid: string): string {
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

function labelFromPrompt(prompt: string): string {
	const firstLine = prompt.split("\n").find((line) => line.trim()) ?? "agent task";
	const words = firstLine.trim().split(/\s+/).slice(0, 5).join(" ");
	return words.length > 48 ? `${words.slice(0, 47)}\u2026` : words;
}

export function statusLine(record: ChildRecord): string {
	const activity = record.currentTool ? `running ${record.currentTool}` : "thinking";
	return `${record.kind}#${record.id} · ${record.description} · turn ${record.turns + 1} · ${activity}`;
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

/**
 * Env var carrying the parent's explicit extension list (colon-separated absolute
 * paths), set by a launcher that starts pi with `-ne -e <path> ...`.
 */
const CHILD_EXTENSIONS_ENV = "PI_CHILD_EXTENSIONS";

/**
 * Resource loader replicating the parent's `-ne -e ...` flags for a child session.
 *
 * createAgentSession does NOT inherit the parent process's CLI flags: called bare it
 * builds a DefaultResourceLoader that auto-discovers ~/.pi/agent/extensions and
 * <cwd>/.pi/extensions. That is right for a normal host session (the child then has
 * the same extensions as its parent), but wrong wherever the parent deliberately ran
 * with -ne and an explicit -e list. Concretely, the podman-hands devcontainer setup
 * (devcontainer/start-devcontainer.sh) runs pi on the host with every file/shell tool
 * re-registered to execute inside a container; a bare child would miss podman-hands,
 * fall back to pi's builtin bash/read/write/edit and execute on the HOST, outside the
 * sandbox. The launcher exports PI_CHILD_EXTENSIONS with the same paths it passes via
 * -e, and we rebuild that exact extension set here.
 *
 * Returns undefined when the var is unset — plain host sessions keep discovery.
 */
async function childResourceLoader(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<DefaultResourceLoader | undefined> {
	const spec = process.env[CHILD_EXTENSIONS_ENV];
	if (!spec) return undefined;
	const additionalExtensionPaths = spec.split(":").filter((p) => p.length > 0);
	// Hard-fail on a stale path instead of loading a partial set: a missing
	// podman-hands is exactly the sandbox escape this loader exists to prevent, and
	// the loader itself only records such paths as (easily missed) load errors.
	const missing = additionalExtensionPaths.filter((p) => !existsSync(p));
	if (missing.length > 0) {
		throw new Error(`${CHILD_EXTENSIONS_ENV} lists paths that do not exist: ${missing.join(", ")}`);
	}
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths,
		noExtensions: true,
	});
	await loader.reload();
	return loader;
}

/** SessionManager.open failed: the saved transcript is unreadable (not a config problem). */
class ReopenError extends Error {}

/**
 * The dir children's session files (and thus their agent-runs.jsonl rows) land
 * in — the same computation createChildSession's SessionManager.create does.
 * pi's getDefaultSessionDir is not exported from the package root, so ask a
 * throwaway manager (no file is written before a first assistant message).
 */
function childSessionDir(cwd: string): string {
	return SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR).getSessionDir();
}

/**
 * Model and thinking level saved in a reopened child's session, resolved the way
 * pi's createAgentSession restores them (sdk.js): the branch's last model
 * (model_change or assistant message) via the registry, only if its provider has
 * auth configured; the thinking level only if the branch recorded one (pi's
 * buildSessionContext otherwise reports a placeholder "off"). Each field is
 * undefined when absent or unresolvable — the caller falls back.
 */
function savedModelSettings(
	ctx: ExtensionContext,
	sessionManager: SessionManager,
): { model?: ChildModel; thinkingLevel?: ChildThinkingLevel } {
	const context = sessionManager.buildSessionContext();
	const found = context.model
		? ctx.modelRegistry.find(context.model.provider, context.model.modelId)
		: undefined;
	const model = found && ctx.modelRegistry.hasConfiguredAuth(found) ? found : undefined;
	const hasThinkingEntry = sessionManager
		.getBranch()
		.some((entry) => (entry as { type?: string }).type === "thinking_level_change");
	const thinkingLevel = hasThinkingEntry ? (context.thinkingLevel as ChildThinkingLevel) : undefined;
	return { model, thinkingLevel };
}

/**
 * The parent session's ModelRuntime, for a child to share. pi keeps it in
 * ModelRegistry's PRIVATE `runtime` field (no public getter), so this reads a
 * private field on purpose: sharing it gives the child the parent's in-memory
 * credentials — `pi --api-key` lands only there, via setRuntimeApiKey — and its
 * already-loaded model catalog, instead of a fresh runtime rebuilt from agentDir
 * files. If pi renames the field this yields undefined and children silently
 * fall back to a default runtime; test/child-model-runtime.test.ts pins it.
 */
export function parentModelRuntime(ctx: Pick<ExtensionContext, "modelRegistry">): ModelRuntime | undefined {
	return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
}

/**
 * Create a child session — fresh, or reopened from `sessionFile` (an evicted or
 * pre-restart child): SessionManager.open loads the saved entries, createAgentSession
 * restores them into the agent, and new entries keep appending to the same file.
 * A reopened child runs on its saved model/thinking level (savedModelSettings);
 * the options/parent ones are only the fallback when those cannot be resolved.
 */
async function createChildSession(
	ctx: ExtensionContext,
	options: RunChildOptions,
	sessionFile?: string,
): Promise<AgentSession> {
	const cwd = ctx.cwd;
	let sessionManager: SessionManager;
	try {
		sessionManager = sessionFile
			? SessionManager.open(sessionFile)
			: SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
	} catch (error) {
		if (!sessionFile) throw error;
		throw new ReopenError(error instanceof Error ? error.message : String(error));
	}
	// A reopened child keeps ITS model and thinking level, exactly like a live
	// resume does — not the parent's current ones, nor RunChildOptions' (the
	// explorer model may have been reconfigured since).
	const saved = sessionFile ? savedModelSettings(ctx, sessionManager) : {};
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = await childResourceLoader(cwd, agentDir, settingsManager);
	const modelRuntime = parentModelRuntime(ctx);
	// The ALS payload lets extensions loading inside the child know they are in a
	// child and which contract it carries (subagent.ts appends it to the system
	// prompt via before_agent_start — see the comment there).
	const info: ChildSessionInfo = { kind: options.kind, contract: options.contract };
	const { session, extensionsResult } = await runInChildSession(info, () =>
		createAgentSession({
			cwd,
			agentDir,
			model: saved.model ?? options.model ?? ctx.model,
			thinkingLevel: saved.thinkingLevel ?? options.thinkingLevel ?? ctx.thinkingLevel,
			...(options.tools && { tools: options.tools }),
			excludeTools: options.excludeTools,
			sessionManager,
			settingsManager,
			...(resourceLoader && { resourceLoader }),
			...(modelRuntime !== undefined && { modelRuntime }),
		} as Parameters<typeof createAgentSession>[0]),
	);
	// Extension load errors must not stay silent: a child missing e.g. context-cap
	// or the contract injection (subagent.ts) runs with different semantics than the
	// parent and nobody would know. The child still runs — same policy as pi's own
	// startup, which reports load errors and continues.
	for (const { path: extPath, error } of extensionsResult?.errors ?? []) {
		ctx.ui.notify(`${options.kind} child: extension failed to load: ${extPath}: ${error}`, "warning");
	}
	await runInChildSession(info, () => session.bindExtensions({}));
	return session;
}

export function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text }] as TextContent[],
		details,
		...(isError && { isError: true }),
	};
}

/**
 * Finished children kept in memory; the oldest beyond this are evicted on spawn
 * or reopen. Memory cap only — evicted children stay resumable (reopened from
 * their session file, see reopenChild).
 */
const MAX_FINISHED_CHILDREN = 8;

/**
 * Evict the oldest finished children beyond MAX_FINISHED_CHILDREN. Running or
 * settling children (not idle yet) are never evicted. Map iteration order is
 * insertion order, so the first finished entries are the oldest (a reopened
 * child re-enters at the end). Each evicted child leaves a tombstone in
 * state.evicted so a later resume_id can reopen it.
 */
function evictFinishedChildren(): void {
	let finished = 0;
	for (const record of state.liveChildren.values()) {
		if (!record.running && record.session.isIdle) finished++;
	}
	for (const [id, record] of state.liveChildren) {
		if (finished <= MAX_FINISHED_CHILDREN) break;
		if (record.running || !record.session.isIdle) continue;
		state.liveChildren.delete(id);
		finished--;
		state.evicted.set(id, {
			id,
			kind: record.kind,
			sid: record.sid,
			rootSid: record.rootSid,
			sessionFile: record.session.sessionManager.getSessionFile(),
			description: record.description,
			turns: record.turns,
			elapsedMs: record.elapsedMs,
		});
		try {
			record.session.dispose();
		} catch {}
	}
}

const freshHint = (kind: string) => `Start a fresh ${kind} with a self-contained prompt.`;

/**
 * Where to reopen a child that is not in liveChildren, or why it cannot be.
 * Synchronous on purpose: reopenEvictedChild reserves the id right after this,
 * before its first await.
 *  1. Eviction tombstone (this pi session).
 *  2. After a pi restart (`pi -c` clears in-memory state): the child's
 *     agent-runs.jsonl spawn row — accepted only when its `root` is the root a
 *     fresh spawn from this ctx would get (rootSidFor), so a child of another main
 *     session (e.g. before /new) is never picked up. The label only narrows the
 *     search: it is display-only, and `${kind}#${id}` is ambiguous once a kind or
 *     a (caller-supplied) resume id contains "#" — so `spawn.kind` is still checked.
 *  Known loss: after a restart the description is the spawn row's; a newer one
 *  passed on a later resume is not persisted anywhere (finish rows carry none).
 */
function findChildSource(id: string, kind: string, ctx: ExtensionContext): ChildSource | { error: string } {
	let source: ChildSource | undefined;
	const tombstone = state.evicted.get(id);
	if (tombstone?.kind === kind) source = tombstone;
	else {
		const spawnerSid = ctx.sessionManager?.getSessionId();
		if (spawnerSid) {
			const root = rootSidFor(spawnerSid);
			const match = findSpawnsByLabel(childSessionDir(ctx.cwd), `${kind}#${id}`)
				.filter(({ spawn }) => spawn.root === root && spawn.kind === kind)
				.at(-1);
			if (match) {
				source = {
					id,
					kind,
					sid: match.spawn.sid,
					rootSid: match.spawn.root,
					sessionFile: match.spawn.sessionFile,
					description: match.spawn.description,
					turns: match.finish?.turns ?? 0,
					elapsedMs: match.finish?.durationMs ?? 0,
				};
			}
		}
	}
	if (!source) {
		return {
			error: `No ${kind} session with id "${id}" in this pi session (unknown id, or it belongs to another main session, e.g. one before /new). ${freshHint(kind)}`,
		};
	}
	// Empty counts as missing: SessionManager.open would rewrite it as a NEW session.
	const file = source.sessionFile;
	let present = false;
	try {
		present = !!file && statSync(file).size > 0;
	} catch {}
	if (!present) {
		return {
			error: `${kind} "${id}" cannot be resumed: its session file is missing (${
				file ?? "never persisted"
			}) — it likely ended before its first reply, or the file was deleted. ${freshHint(kind)}`,
		};
	}
	return source;
}

/**
 * Reopen an evicted/pre-restart child from its session file and register it in
 * liveChildren (newest entry). Restores the record fields from `source`; writes
 * no spawn row (same sid — the dashboard already knows it) and keeps the
 * persisted session name. The view replays the saved branch first, so the
 * caller's addUserMessage(newPrompt) lands after the history.
 * The record enters liveChildren already `running: true`: the caller's
 * reservation (state.reopening) is released a microtask after this returns, and
 * in that window a second resume must see the child as running — not as an
 * idle finished child it may prompt (or eviction may dispose). From here on the
 * caller owns resetting `running` on failure (runChildRecord's finally).
 * Returns an error text when the file cannot be reopened as this child.
 */
async function reopenChild(
	ctx: ExtensionContext,
	options: RunChildOptions,
	source: ChildSource,
): Promise<ChildRecord | { error: string }> {
	const unreadable = (why: string) => ({
		error: `${source.kind} "${source.id}" cannot be resumed: its session file could not be reopened (${source.sessionFile}: ${why}). ${freshHint(source.kind)}`,
	});
	let session: AgentSession;
	try {
		session = await createChildSession(ctx, options, source.sessionFile);
	} catch (error) {
		if (error instanceof ReopenError) return unreadable(error.message);
		throw error;
	}
	try {
		if (session.sessionManager.getSessionId() !== source.sid) {
			session.dispose();
			return unreadable(`it holds session ${session.sessionManager.getSessionId()}, expected ${source.sid}`);
		}
		if (!session.sessionName) session.setSessionName(`${source.kind}#${source.id}`);
		const view = new ChildView(session, ctx.cwd);
		view.replay(session.sessionManager.getBranch());
		const record: ChildRecord = {
			id: source.id,
			kind: source.kind,
			sid: source.sid,
			rootSid: source.rootSid,
			session,
			view,
			description: source.description,
			turns: source.turns,
			elapsedMs: source.elapsedMs,
			running: true,
		};
		liveChildren.set(record.id, record);
		state.evicted.delete(record.id);
		return record;
	} catch (error) {
		session.dispose();
		throw error;
	}
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

// Counting semaphore per busy group. Agents stay at limit 1: parallel agents would
// share one worktree (they overwrite each other's edits) and one terminal. Explorers
// are readonly, so their group allows N concurrent children (PI_EXPLORER_PARALLEL,
// resolved by explore.ts). The slot is taken synchronously before the first await, so
// two tool calls in the same assistant message cannot both slip past a full semaphore.
// Explorers get their own group also because a subagent's Explore call runs inside a
// still-running Agent tool call, and a single shared latch would reject it as busy.
function busyGroup(name: string): BusyGroup {
	let group = state.busyGroups.get(name);
	if (!group) {
		group = { active: 0, limit: 1, settling: new Set() };
		state.busyGroups.set(name, group);
	}
	return group;
}

/**
 * Cap on how long a settling child may keep its semaphore slot: if waitForIdle()
 * never resolves (hung child), the slot would otherwise be stranded for the rest
 * of the pi session — at limit 1 (Agent group) the tool would be permanently busy.
 */
const SETTLE_TIMEOUT_MS = 60_000;

/** Shared execute() body for child-session tools. */
export async function runChildTool(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
	ctx: ExtensionContext,
) {
	const group = busyGroup(options.busyGroup);
	group.limit = Math.max(1, Math.floor(options.concurrency ?? 1));
	if (group.active >= group.limit) {
		return textResult(
			options.busyMessage ??
				`Another ${options.kind} is already running. ${options.kind} calls are serialized — wait for the running one's result, then call again.`,
			{ error: "child_busy" },
			true,
		);
	}
	group.active++;
	// This call's own child session, captured for the wind-down below. Local per call —
	// a shared slot on the group would cross-wire concurrent explorers.
	let childSession: AgentSession | undefined;
	try {
		return await runChildToolInSlot(params, options, signal, onUpdate, ctx, (session) => {
			childSession = session;
		});
	} finally {
		// Semaphore wind-down: if the child is still draining (abort in flight), its
		// slot stays occupied until it is actually idle — a new child must not overlap
		// it. Released in the background; the result returns now.
		const session = childSession;
		if (session && !session.isIdle) {
			group.settling.add(session);
			// Idempotent: fires from waitForIdle OR the self-expiry timeout, whichever
			// comes first — never both (the slot must be released exactly once).
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				clearTimeout(timeout);
				group.settling.delete(session);
				group.active--;
			};
			const timeout = setTimeout(release, SETTLE_TIMEOUT_MS);
			timeout.unref?.(); // must not keep the process alive
			session.waitForIdle().then(release, release);
		} else {
			group.active--;
		}
	}
}

/** A resolved child for this call, or the tool result that ends the call instead. */
type ResolvedChild = { record: ChildRecord } | { result: ReturnType<typeof textResult> };

async function runChildToolInSlot(
	params: ChildToolParams,
	options: RunChildOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
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
	const unknownResume = (text: string) => ({
		result: textResult(text, { error: "unknown_resume_id" }, true),
	});
	const stillRunning = () => ({
		result: textResult(
			`${options.kind} "${resumeId}" is still running. Wait for its result, then resume it.`,
			{ error: "child_running" },
			true,
		),
	});
	// Reservation first: a reopen in flight is running even once its record is
	// already in liveChildren (inserted with running: true, see reopenChild).
	if (state.reopening.has(resumeId)) return stillRunning();
	const existing = liveChildren.get(resumeId);
	let record: ChildRecord;
	if (existing) {
		if (existing.kind !== options.kind) {
			return unknownResume(
				`No ${options.kind} session with id "${resumeId}" (that id is a ${existing.kind}). ${freshHint(options.kind)}`,
			);
		}
		// With explorers running in parallel, two calls can pass the semaphore and
		// resume the same child at once — session.prompt() on a busy session throws,
		// and the loser's wind-down would mark the winner's record as not running.
		// Also covers a session still draining after an abort.
		// No await between this check and the claim below.
		if (existing.running || !existing.session.isIdle) return stillRunning();
		record = existing;
	} else {
		const reopened = await reopenEvictedChild(resumeId, options, ctx);
		if ("error" in reopened) return unknownResume(reopened.error);
		record = reopened;
	}
	if (description) record.description = description;
	record.running = true;
	return { record };
}

/**
 * Evicted (or from before a pi restart): reopen it from its session file.
 * Another call already reopening the same id counted as running in
 * resumeChildRecord — two SessionManagers appending to one file would corrupt it.
 */
async function reopenEvictedChild(
	resumeId: string,
	options: RunChildOptions,
	ctx: ExtensionContext,
): Promise<ChildRecord | { error: string }> {
	const source = findChildSource(resumeId, options.kind, ctx);
	if ("error" in source) return source;
	// Reserved synchronously (no await since resumeChildRecord's has() check);
	// released on every path. The record reaches liveChildren — already
	// running: true (reopenChild) — before the release.
	state.reopening.add(resumeId);
	try {
		evictFinishedChildren();
		return await reopenChild(ctx, options, source);
	} finally {
		state.reopening.delete(resumeId);
	}
}

/** Spawn a fresh child session, register it (+ spawn row) and claim it (running = true). */
async function spawnChildRecord(
	params: ChildToolParams,
	options: RunChildOptions,
	ctx: ExtensionContext,
): Promise<ChildRecord> {
	evictFinishedChildren();
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
		rootSid: spawnerSid ? rootSidFor(spawnerSid) : sid,
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
	onUpdate: ((partial: ReturnType<typeof textResult>) => void) | undefined,
) {
	let watcher: ReturnType<typeof watchChild>;
	try {
		// The child gets the task verbatim: the delegate contract rides the system
		// prompt (options.contract, injected per turn by subagent.ts), not the prompt.
		record.view.addUserMessage(params.prompt);
		watcher = watchChild(record, onUpdate);
	} catch (error) {
		// Before the run's own finally: never leave a stale running=true record
		// (it would block every later resume and be exempt from eviction).
		record.running = false;
		throw error;
	}
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
		writeFinishEvent(record, signal?.aborted ? "cancelled" : failed ? "error" : "done");
	}
	const text = watcher.text();
	return textResult(
		`${text || `(${options.kind} produced no text output)`}\n\n---\n${options.kind} id: ${record.id} (pass as resume_id to continue)`,
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
