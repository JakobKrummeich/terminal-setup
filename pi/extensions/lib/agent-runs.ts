/**
 * agent-runs.jsonl — on-disk event index for the agent dashboard
 * (docs/agent-dashboard-spec.md, "Data layer").
 *
 * One file per project, living beside the session JSONLs it indexes
 * (`<session dir>/agent-runs.jsonl`), append-only, one JSON object per line.
 * Several pi processes may share it (any instance can serve the dashboard), so:
 *  - writes are single appendFileSync calls (one whole line per write — small
 *    enough that POSIX O_APPEND keeps concurrent writers from interleaving),
 *  - the reader is tolerant: damaged or foreign lines are skipped, never fatal,
 *  - nothing ever rewrites the file. "Pruning" is reader-side filtering only;
 *    rewriting a shared append-only file would need cross-process locking.
 *
 * Writers: lib/child-session.ts (spawn/progress/finish), context-cap.ts (reset),
 * agent-dash.ts (session-start).
 *
 * Deliberately stateless — no module-level mutable state. pi loads every
 * extension file with its own jiti instance (moduleCache: false), so this module
 * exists as several copies at runtime; the file on disk is the only shared state.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How a run ended. `cancelled` = the caller aborted the tool call. */
export type RunStatus = "done" | "error" | "cancelled";

/**
 * Main pi session began (startup, /new, /resume, /fork, extension reload).
 * The main session is a tree root: its `root` IS its `sid`, so the field is
 * omitted. Re-logged with the same sid on resume/reload — readRuns dedupes.
 */
export interface RunSessionStart {
	ts: number;
	event: "session-start";
	/** Session uuid (SessionManager.getSessionId()) — unique across pi instances. */
	sid: string;
	/** Absolute path of the session JSONL; vanished file ⇒ row is pruned on read. */
	sessionFile: string;
}

/** A child session (agent or explorer) was created. Written once per child; resumes reuse the sid. */
export interface RunSpawn {
	ts: number;
	event: "spawn";
	/** The child's session uuid. */
	sid: string;
	/** The main session's sid — groups one spawn tree. */
	root: string;
	/**
	 * Sid of the session whose tool call spawned this child. Always set:
	 * equals `root` when the main session spawned it, and the agent child's own
	 * sid when that agent spawned an explorer.
	 */
	parentSid: string;
	/** "agent" | "explorer" today (RunChildOptions.kind — open set by design). */
	kind: string;
	/** Display-only, e.g. "agent#3ce02a1b" (kind + 8-char child id). */
	label: string;
	/** Absolute path of the child's session JSONL. */
	sessionFile: string;
	/** Task description as shown in the F2 overlay. */
	description: string;
}

/** Low-rate heartbeat while a child runs (per turn / per tool change, throttled). */
export interface RunProgress {
	ts: number;
	event: "progress";
	sid: string;
	/** 1-based turn currently in flight (or just ended, on the turn-end heartbeat). */
	turn: number;
	/** Tool being executed; absent between tools / at turn boundaries. */
	tool?: string;
}

/** A context-cap handoff swap happened in this session (main or child). */
export interface RunReset {
	ts: number;
	event: "reset";
	sid: string;
}

/**
 * A child run settled (tool call returned). A resumed child writes one finish
 * row per settle; all numbers are cumulative over the child's whole life, so
 * the LAST finish row per sid is the authoritative total.
 *
 * Not necessarily the sid's LAST row, though: rows can legally trail a finish —
 * e.g. a context-cap `reset` written during the post-abort drain window, while
 * the settling child still holds its semaphore slot. Consumers must tolerate
 * rows after finish; such a late swap also means the finish row's cumulative
 * `resets` may undercount by one.
 */
export interface RunFinish {
	ts: number;
	event: "finish";
	sid: string;
	status: RunStatus;
	turns: number;
	costUsd: number;
	contextTokens: number | null;
	contextPercent: number | null;
	resets: number;
	durationMs: number;
}

export type AgentRunEvent = RunSessionStart | RunSpawn | RunProgress | RunReset | RunFinish;

const RUNS_FILE = "agent-runs.jsonl";

/** Index file path for a session dir (exported for tests/server). */
export function runsFilePath(dir: string): string {
	return join(dir, RUNS_FILE);
}

/**
 * Append one event line. Best-effort telemetry: a failed index write must never
 * break the session it describes, so errors are swallowed. `dir` is the session
 * dir (SessionManager.getSessionDir()); in-memory sessions report "" — skipped.
 */
export function appendEvent(dir: string, event: AgentRunEvent): void {
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(runsFilePath(dir), `${JSON.stringify(event)}\n`);
	} catch {
		// Disk full / permissions: the dashboard loses a row, the session lives on.
	}
}

/**
 * Per-event required fields, one literal check per event type — the cast in
 * parseLine is only as honest as this switch. Unknown event types fail here.
 */
function hasEventFields(event: { event: string } & Record<string, unknown>): boolean {
	switch (event.event) {
		case "session-start":
			// sessionFile is load-bearing for pruning: an intro row without it is useless.
			return typeof event.sessionFile === "string";
		case "spawn":
			return (
				typeof event.root === "string" &&
				typeof event.parentSid === "string" &&
				typeof event.kind === "string" &&
				typeof event.label === "string" &&
				typeof event.sessionFile === "string" &&
				typeof event.description === "string"
			);
		case "progress":
			return typeof event.turn === "number" && (event.tool === undefined || typeof event.tool === "string");
		case "reset":
			return true; // ts/sid only, already checked by parseLine
		case "finish":
			return (
				(event.status === "done" || event.status === "error" || event.status === "cancelled") &&
				typeof event.turns === "number" &&
				typeof event.costUsd === "number" &&
				(event.contextTokens === null || typeof event.contextTokens === "number") &&
				(event.contextPercent === null || typeof event.contextPercent === "number") &&
				typeof event.resets === "number" &&
				typeof event.durationMs === "number"
			);
		default:
			return false;
	}
}

/** Shape check for one index line; anything off is skipped, not fatal. */
function parseLine(line: string): AgentRunEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const event = parsed as { ts?: unknown; event?: unknown; sid?: unknown } & Record<string, unknown>;
	if (typeof event.ts !== "number" || typeof event.sid !== "string") return undefined;
	if (typeof event.event !== "string") return undefined;
	if (!hasEventFields(event as { event: string } & Record<string, unknown>)) return undefined;
	return event as unknown as AgentRunEvent;
}

/**
 * Read the index for one session dir, cleaned for rendering:
 *  - corrupt/foreign lines skipped (tolerant multi-writer file),
 *  - repeated session-start per sid deduped (resume/reload re-log it; the FIRST
 *    row wins — its ts is the true session start),
 *  - rows whose session file no longer exists are dropped (spec decision 10:
 *    retention follows the session JSONLs), as are rows for sids that never had
 *    an intro row (session-start/spawn) carrying a sessionFile.
 *
 * Note: pi creates a session file on the first assistant message. So a
 * just-started session is invisible here for a few seconds — and a child
 * aborted BEFORE its first assistant message never gets a file at all, so its
 * rows are pruned forever, not just temporarily. Accepted in v1.
 * File order is preserved; the file itself is never modified.
 */
export function readRuns(dir: string): AgentRunEvent[] {
	let content: string;
	try {
		content = readFileSync(runsFilePath(dir), "utf8");
	} catch {
		return []; // no index yet (or unreadable): nothing to render
	}
	const events: AgentRunEvent[] = [];
	const seenStart = new Set<string>();
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const event = parseLine(line);
		if (!event) continue;
		if (event.event === "session-start") {
			if (seenStart.has(event.sid)) continue;
			seenStart.add(event.sid);
		}
		events.push(event);
	}
	return pruneVanished(events);
}

/**
 * Drop rows whose session transcript is gone (and orphan rows with no intro).
 * "Gone" includes never-created: a child aborted before its first assistant
 * message has no session file, so its rows stay pruned permanently.
 */
function pruneVanished(events: AgentRunEvent[]): AgentRunEvent[] {
	const fileBySid = new Map<string, string>();
	for (const event of events) {
		if (event.event !== "session-start" && event.event !== "spawn") continue;
		if (!fileBySid.has(event.sid)) fileBySid.set(event.sid, event.sessionFile);
	}
	const aliveByFile = new Map<string, boolean>();
	const sidAlive = (sid: string): boolean => {
		const file = fileBySid.get(sid);
		if (file === undefined) return false;
		let alive = aliveByFile.get(file);
		if (alive === undefined) {
			alive = existsSync(file);
			aliveByFile.set(file, alive);
		}
		return alive;
	};
	return events.filter((event) => sidAlive(event.sid));
}
