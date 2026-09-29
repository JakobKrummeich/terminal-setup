// Child eviction and reopening: finished children beyond MAX_FINISHED_CHILDREN
// leave liveChildren for a tombstone, and a later resume_id reopens an evicted (or
// pre-restart) child from its session file. Operates on child-session.ts's
// shared registry, passed in explicitly (this module owns no state).
import { statSync } from "node:fs";
import { type AgentSession, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { findSpawnsByLabel } from "./agent-runs.ts";
import { createChildSession, ReopenError } from "./child-create.ts";
import { rootSidFor } from "./child-runs.ts";
import type { ChildRecord, ChildRegistry, ChildSource, RunChildOptions } from "./child-types.ts";
import { ChildView } from "./child-view.ts";

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
 * registry.evicted so a later resume_id can reopen it.
 */
export function evictFinishedChildren(registry: ChildRegistry): void {
	let finished = 0;
	for (const record of registry.liveChildren.values()) {
		if (isFinished(record)) finished++;
	}
	for (const [id, record] of registry.liveChildren) {
		if (finished <= MAX_FINISHED_CHILDREN) break;
		if (!isFinished(record)) continue;
		registry.liveChildren.delete(id);
		finished--;
		registry.evicted.set(id, tombstoneOf(id, record));
		try {
			record.session.dispose();
		} catch {
			// Best-effort teardown of an evicted finished child; a throwing dispose must not stop the eviction loop.
		}
	}
}

/** Finished = not running and not settling (idle): the only evictable state. */
function isFinished(record: ChildRecord): boolean {
	return !record.running && record.session.isIdle;
}

/** Everything needed to reopen an evicted child from disk. */
function tombstoneOf(id: string, record: ChildRecord): ChildSource {
	return {
		id,
		kind: record.kind,
		sid: record.sid,
		rootSid: record.rootSid,
		sessionFile: record.session.sessionManager.getSessionFile(),
		description: record.description,
		turns: record.turns,
		elapsedMs: record.elapsedMs,
	};
}

/**
 * The dir children's session files (and thus their agent-runs.jsonl rows) land
 * in — the same computation createChildSession's SessionManager.create does.
 * pi's getDefaultSessionDir is not exported from the package root, so ask a
 * throwaway manager (it writes no file before the first conversation message:
 * user message on pi >= 0.99, assistant message on 0.87).
 */
function childSessionDir(cwd: string): string {
	return SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR).getSessionDir();
}

export const freshHint = (kind: string) => `Start a fresh ${kind} with a self-contained prompt.`;

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
function findChildSource(
	id: string,
	kind: string,
	ctx: ExtensionContext,
	registry: ChildRegistry,
): ChildSource | { error: string } {
	const tombstone = registry.evicted.get(id);
	const source = tombstone?.kind === kind ? tombstone : spawnRowSource(id, kind, ctx, registry);
	if (!source) {
		return {
			error: `No ${kind} session with id "${id}" in this pi session (unknown id, or it belongs to another main session, e.g. one before /new). ${freshHint(kind)}`,
		};
	}
	const file = source.sessionFile;
	if (!hasSessionFile(file)) {
		return {
			error: `${kind} "${id}" cannot be resumed: its session file is missing (${
				file ?? "never persisted"
			}) — it likely ended before pi first wrote it, or the file was deleted. ${freshHint(kind)}`,
		};
	}
	return source;
}

/** Source 2 of findChildSource: the newest matching agent-runs.jsonl spawn row. */
function spawnRowSource(
	id: string,
	kind: string,
	ctx: ExtensionContext,
	registry: ChildRegistry,
): ChildSource | undefined {
	const spawnerSid = ctx.sessionManager?.getSessionId();
	if (!spawnerSid) return undefined;
	const root = rootSidFor(registry.liveChildren, spawnerSid);
	const match = findSpawnsByLabel(childSessionDir(ctx.cwd), `${kind}#${id}`)
		.filter(({ spawn }) => spawn.root === root && spawn.kind === kind)
		.at(-1);
	return match && spawnRowToSource(id, kind, match);
}

function spawnRowToSource(id: string, kind: string, match: ReturnType<typeof findSpawnsByLabel>[number]): ChildSource {
	return {
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

/** Empty counts as missing: SessionManager.open would rewrite it as a NEW session. */
function hasSessionFile(file: string | undefined): boolean {
	try {
		return !!file && statSync(file).size > 0;
	} catch {
		// Unreadable/absent file = not present; the caller reports it.
		return false;
	}
}

/**
 * Reopen an evicted/pre-restart child from its session file and register it in
 * liveChildren (newest entry). Restores the record fields from `source`; writes
 * no spawn row (same sid — the dashboard already knows it) and keeps the
 * persisted session name. The view replays the saved branch first, so the
 * caller's addUserMessage(newPrompt) lands after the history.
 * The record enters liveChildren already `running: true`: the caller's
 * reservation (registry.reopening) is released a microtask after this returns, and
 * in that window a second resume must see the child as running — not as an
 * idle finished child it may prompt (or eviction may dispose). From here on the
 * caller owns resetting `running` on failure (runChildRecord's finally).
 * Returns an error text when the file cannot be reopened as this child.
 */
async function reopenChild(
	ctx: ExtensionContext,
	options: RunChildOptions,
	source: ChildSource,
	registry: ChildRegistry,
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
		registry.liveChildren.set(record.id, record);
		registry.evicted.delete(record.id);
		return record;
	} catch (error) {
		session.dispose();
		throw error;
	}
}

/**
 * Evicted (or from before a pi restart): reopen it from its session file.
 * Another call already reopening the same id counted as running in
 * resumeChildRecord — two SessionManagers appending to one file would corrupt it.
 */
export async function reopenEvictedChild(
	resumeId: string,
	options: RunChildOptions,
	ctx: ExtensionContext,
	registry: ChildRegistry,
): Promise<ChildRecord | { error: string }> {
	const source = findChildSource(resumeId, options.kind, ctx, registry);
	if ("error" in source) return source;
	// Reserved synchronously (no await since resumeChildRecord's has() check);
	// released on every path. The record reaches liveChildren — already
	// running: true (reopenChild) — before the release.
	registry.reopening.add(resumeId);
	try {
		evictFinishedChildren(registry);
		return await reopenChild(ctx, options, source, registry);
	} finally {
		registry.reopening.delete(resumeId);
	}
}
