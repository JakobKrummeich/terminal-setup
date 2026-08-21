/**
 * dashboard-server — stateless HTTP server for the machine-global agent
 * dashboard (docs/agent-dashboard-spec.md decisions 5–7; response shapes in
 * lib/dashboard-api.ts).
 *
 * Serves ALL projects: every request enumerates the subdirs of `sessionsRoot`
 * (default ~/.pi/agent/sessions) that contain an agent-runs.jsonl and
 * re-derives its answer from disk (readRuns + session JSONLs via
 * session-transcript). No in-memory session state, no caches — dirs appearing
 * or vanishing between requests are simply picked up or skipped. Sids are
 * session uuids (globally unique), so /api/tree and /api/transcript resolve a
 * sid by scanning the enumerated indexes.
 *
 * Runs under plain node in the standalone daemon (pi/dashboard-daemon.mjs):
 * this module and everything it imports must stay free of pi runtime imports
 * (type-only imports are fine). The test suite also embeds it in-process.
 *
 * Lifecycle: by default the listening socket and every accepted connection are
 * unref()ed so an embedded server never keeps its host process (tests — see
 * AGENTS.md on keep-alive sockets) alive; the daemon passes
 * `keepProcessAlive: true`, which skips the unrefs so the process stays up.
 * close() destroys open sockets so tests shut down deterministically.
 * EADDRINUSE resolves as { started: false }: the port is taken (daemon
 * already running, or a squatter); the caller decides what that means.
 */
import { type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { type AgentRunEvent, readRuns, runsFilePath } from "./agent-runs.ts";
import {
	decodeProjectDirName,
	deriveSessions,
	deriveSpawnAnchors,
	deriveTree,
	type MetaResponse,
	type SessionRow,
	sessionFileFor,
	type SessionsResponse,
	type TranscriptAnchor,
	type TranscriptResponse,
} from "./dashboard-api.ts";
import { parseTranscript, readSessionStats } from "./session-transcript.ts";

/** Literal extension → content-type map for the static UI files. */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

/**
 * Static UI dir. Resolved through the agent dir, not import.meta/__dirname:
 * tsc checks these files as CJS (import.meta = syntax error) while the test
 * runner executes them as ESM (no __dirname) — explore.ts documents the same
 * trap. `~/.pi/agent/extensions` is a symlink into this repo, so the join
 * lands on lib/dashboard-ui/ here. Tests override via options.uiDir; the
 * daemon passes its repo-relative UI dir explicitly.
 */
function defaultUiDir(env: NodeJS.ProcessEnv): string {
	// `||` not `??`: pi's own getAgentDir treats an empty env var as unset.
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "extensions", "lib", "dashboard-ui");
}

/** ~/.pi/agent/sessions (PI_CODING_AGENT_DIR respected) — pi's per-cwd session dirs live under it. */
export function defaultSessionsRoot(env: NodeJS.ProcessEnv): string {
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "sessions");
}

export interface DashboardServerOptions {
	/** Root holding one session dir per project; default ~/.pi/agent/sessions. */
	sessionsRoot?: string;
	/** 0 = ephemeral (tests/smoke). */
	port: number;
	/** Default 0.0.0.0 (decision 6: user maps container ports). */
	host?: string;
	/** Static file root; default resolves lib/dashboard-ui via the agent dir. */
	uiDir?: string;
	/** SSE change-coalescing window; default 500ms. Tests shrink it. */
	sseDebounceMs?: number;
	/**
	 * Daemon mode: keep the listening socket ref'd so the process stays alive.
	 * Default false — embedded servers (tests) must never hold their host up.
	 */
	keepProcessAlive?: boolean;
}

export interface DashboardServer {
	/** Actual bound port (differs from options.port when that was 0). */
	port: number;
	/** Stop listening and destroy open sockets (incl. SSE streams). */
	close(): Promise<void>;
}

export type StartResult = { started: true; server: DashboardServer } | { started: false; reason: "port-in-use" };

/** Bundle of resolved config the route handlers need. */
interface ServerContext {
	sessionsRoot: string;
	uiDir: string;
	sseDebounceMs: number;
	startedAt: number;
}

/** Resolves once listening (or once EADDRINUSE is known); rejects on other errors. */
export function startDashboardServer(options: DashboardServerOptions): Promise<StartResult> {
	const ctx: ServerContext = {
		sessionsRoot: path.resolve(options.sessionsRoot ?? defaultSessionsRoot(process.env)),
		uiDir: path.resolve(options.uiDir ?? defaultUiDir(process.env)),
		sseDebounceMs: options.sseDebounceMs ?? 500,
		startedAt: Date.now(),
	};
	const keepProcessAlive = options.keepProcessAlive ?? false;
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		try {
			route(req, res, ctx);
		} catch (error) {
			if (res.headersSent) res.destroy();
			else fail(res, 500, `internal error: ${String(error)}`);
		}
	});
	server.on("connection", (socket) => {
		// Embedded: a lingering keep-alive/SSE socket must not hold the process.
		// Daemon: the ref'd listening socket keeps the process up regardless.
		if (!keepProcessAlive) socket.unref();
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	if (!keepProcessAlive) server.unref();
	return new Promise((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") resolve({ started: false, reason: "port-in-use" });
			else reject(error);
		});
		server.listen(options.port, options.host ?? "0.0.0.0", () => {
			const port = (server.address() as AddressInfo).port;
			const close = (): Promise<void> =>
				new Promise((done) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => done());
				});
			resolve({ started: true, server: { port, close } });
		});
	});
}

/** The route table. Literal paths only — grep the path, land here. */
function route(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): void {
	if (req.method !== "GET") return fail(res, 405, "GET only");
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/api/meta") return handleMeta(res, ctx);
	if (url.pathname === "/api/sessions") return handleSessions(res, ctx.sessionsRoot);
	if (url.pathname === "/api/tree") return handleTree(res, ctx.sessionsRoot, url.searchParams.get("root"));
	if (url.pathname === "/api/transcript") return handleTranscript(res, ctx.sessionsRoot, url.searchParams.get("sid"));
	if (url.pathname === "/api/events") return handleEvents(req, res, ctx, url.searchParams.get("sid"));
	return handleStatic(res, ctx.uiDir, url.pathname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, message: string): void {
	json(res, status, { error: message });
}

// --- project enumeration -----------------------------------------------------

interface ProjectDir {
	/** Raw dir name (stable project id). */
	id: string;
	/** Absolute path of the project's session dir. */
	dir: string;
}

/**
 * Session dirs under the root that currently have an index. Re-scanned per
 * request (stateless by contract): new projects appear immediately, dirs whose
 * index vanished are skipped. Non-dirs and index-less dirs are ignored via the
 * existsSync-equivalent check on the runs file itself.
 */
function projectDirs(sessionsRoot: string): ProjectDir[] {
	let names: string[];
	try {
		names = readdirSync(sessionsRoot);
	} catch {
		return []; // root missing/unreadable: nothing to serve, not an error
	}
	const dirs: ProjectDir[] = [];
	for (const name of names.sort()) {
		const dir = path.join(sessionsRoot, name);
		try {
			statSync(runsFilePath(dir));
		} catch {
			continue; // no index (never had one, or vanished): skip
		}
		dirs.push({ id: name, dir });
	}
	return dirs;
}

/** First project dir whose index has an intro row for this sid (sids are uuids — globally unique). */
function findSession(sessionsRoot: string, sid: string): { file: string; events: AgentRunEvent[] } | null {
	for (const project of projectDirs(sessionsRoot)) {
		const events = readRuns(project.dir);
		const file = sessionFileFor(events, sid);
		if (file) return { file, events };
	}
	return null;
}

// --- api handlers ------------------------------------------------------------

/** GET /api/meta → MetaResponse */
function handleMeta(res: ServerResponse, ctx: ServerContext): void {
	const body: MetaResponse = {
		hostname: os.hostname(),
		sessionsRoot: ctx.sessionsRoot,
		pid: process.pid,
		startedAt: ctx.startedAt,
	};
	json(res, 200, body);
}

/** GET /api/sessions → SessionsResponse (all projects merged, newest first) */
function handleSessions(res: ServerResponse, sessionsRoot: string): void {
	const now = Date.now();
	const sessions: SessionRow[] = [];
	for (const project of projectDirs(sessionsRoot)) {
		const ref = { projectId: project.id, project: decodeProjectDirName(project.id) };
		sessions.push(...deriveSessions(readRuns(project.dir), now, readSessionStats, ref));
	}
	sessions.sort((a, b) => b.startTs - a.startTs);
	const body: SessionsResponse = { sessions };
	json(res, 200, body);
}

/** GET /api/tree?root=<sid> → TreeResponse */
function handleTree(res: ServerResponse, sessionsRoot: string, root: string | null): void {
	if (!root) return fail(res, 400, "missing ?root=<sid>");
	const now = Date.now();
	for (const project of projectDirs(sessionsRoot)) {
		const tree = deriveTree(readRuns(project.dir), root, now, readSessionStats);
		if (tree) return json(res, 200, tree);
	}
	return fail(res, 404, `unknown root: ${root}`);
}

/** GET /api/transcript?sid=<sid> → TranscriptResponse */
function handleTranscript(res: ServerResponse, sessionsRoot: string, sid: string | null): void {
	if (!sid) return fail(res, 400, "missing ?sid=<sid>");
	const found = findSession(sessionsRoot, sid);
	if (!found) return fail(res, 404, `unknown sid: ${sid}`);
	const parsed = parseTranscript(found.file);
	if (!parsed) return fail(res, 404, `transcript unreadable: ${sid}`);
	const anchors: TranscriptAnchor[] = [
		...parsed.handoffEntryIndexes.map((entryIndex): TranscriptAnchor => ({ type: "handoff", entryIndex })),
		...deriveSpawnAnchors(
			found.events,
			sid,
			parsed.entries.map((entry) => entry.tsMs),
		),
	].sort((a, b) => a.entryIndex - b.entryIndex);
	const body: TranscriptResponse = { sid, entries: parsed.entries, anchors };
	json(res, 200, body);
}

/**
 * GET /api/events[?sid=<sid>] — SSE, deliberately dumb: any relevant change
 * emits one debounced `data: {"changed":true}` and clients refetch. No replay,
 * no payloads. Watches:
 *  - the sessions ROOT (project dirs appearing/vanishing → change + rescan),
 *  - every project dir, filtered to agent-runs.jsonl basenames (+ the sid's
 *    session file basename when ?sid= is given — it lives beside its index).
 * A project dir vanishing mid-stream kills only that dir's watcher (and emits
 * a change — its rows just disappeared); the stream lives while the root
 * watcher lives. fs.watch on a not-yet-existing file throws, hence dir watches
 * filtered by basename.
 */
function handleEvents(req: IncomingMessage, res: ServerResponse, ctx: ServerContext, sid: string | null): void {
	const names = new Set([path.basename(runsFilePath(ctx.sessionsRoot))]);
	if (sid) {
		const found = findSession(ctx.sessionsRoot, sid);
		if (found) names.add(path.basename(found.file));
	}
	const dirWatchers = new Map<string, FSWatcher>();
	let timer: NodeJS.Timeout | null = null;
	const emitChange = (): void => {
		if (timer) return; // change already pending — coalesce
		timer = setTimeout(() => {
			timer = null;
			// Client can vanish inside the debounce window, racing the 'close'
			// handler's clearTimeout — never write into a dead stream.
			if (res.writableEnded || res.destroyed) return;
			res.write('data: {"changed":true}\n\n');
		}, ctx.sseDebounceMs);
		timer.unref?.();
	};
	const watchProjectDir = (dir: string): void => {
		if (dirWatchers.has(dir)) return;
		let watcher: FSWatcher;
		try {
			watcher = watch(dir, (_type, filename) => {
				if (typeof filename === "string" && !names.has(filename)) return; // null/Buffer filename: over-notify, never miss
				emitChange();
			});
		} catch {
			return; // dir vanished between scan and watch: skipped, rescan re-tries
		}
		watcher.on("error", () => {
			// Dir deleted / inotify hiccup: its rows are gone — that IS a change.
			watcher.close();
			dirWatchers.delete(dir);
			emitChange();
		});
		watcher.unref();
		dirWatchers.set(dir, watcher);
	};
	const scanProjectDirs = (): void => {
		let entries: string[];
		try {
			entries = readdirSync(ctx.sessionsRoot);
		} catch {
			// Root gone. fs.watch (Linux) emits only 'rename' for self-deletion,
			// never 'error' — the root watcher is silently dead, so fold the stream
			// ourselves: the client reconnects, gets a clean 500 while the root is
			// missing (EventSource falls back to polling) and a live stream once
			// it is back.
			foldStream();
			return;
		}
		for (const name of entries) {
			const dir = path.join(ctx.sessionsRoot, name);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue; // vanished between readdir and stat
			}
			watchProjectDir(dir); // index-less dirs too: their index may appear later
		}
	};
	const stopAll = (): void => {
		rootWatcher.close();
		for (const watcher of dirWatchers.values()) watcher.close();
		dirWatchers.clear();
		if (timer) clearTimeout(timer);
		timer = null;
	};
	/** Tear down and end the stream (500 when it never started) — the client's cue to reconnect. */
	const foldStream = (): void => {
		stopAll();
		if (!res.headersSent) fail(res, 500, "sessions root vanished");
		else if (!res.writableEnded && !res.destroyed) res.end();
	};
	// The watch backend can fail at connect (root missing, inotify limits) —
	// that's a request failure. At runtime it must never throw unhandled: this
	// server may run inside a test host process; fold the stream quietly, the
	// client just reconnects.
	let rootWatcher: FSWatcher;
	try {
		rootWatcher = watch(ctx.sessionsRoot, (_type, filename) => {
			emitChange(); // a project appearing/vanishing changes /api/sessions
			// A deleted dir's watcher stays open on its dead inode WITHOUT erroring
			// (Linux) and would block re-watching a recreated dir of the same name.
			// Root events name the touched entry: drop its watcher; the rescan
			// re-adds a live one if the dir (still) exists.
			if (typeof filename === "string") {
				const dir = path.join(ctx.sessionsRoot, filename);
				dirWatchers.get(dir)?.close();
				dirWatchers.delete(dir);
			} else {
				// No filename (platform edge): can't tell which — rebuild them all.
				for (const watcher of dirWatchers.values()) watcher.close();
				dirWatchers.clear();
			}
			scanProjectDirs(); // pick up new dirs so their future appends are seen
		});
	} catch (error) {
		return fail(res, 500, `cannot watch sessions root: ${String(error)}`);
	}
	rootWatcher.on("error", foldStream);
	rootWatcher.unref();
	scanProjectDirs();
	if (res.writableEnded) return; // root vanished during setup: already folded as a 500
	res.on("error", () => {}); // client reset mid-write: cleanup happens via req 'close'
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(":connected\n\n");
	req.on("close", stopAll);
}

/**
 * Static UI files. Traversal-safe: decode, resolve against the UI root, then
 * require the result to stay under it — anything else (../, %2e%2e, absolute
 * paths) 404s without touching the filesystem.
 */
function handleStatic(res: ServerResponse, uiDir: string, pathname: string): void {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return fail(res, 400, "malformed path");
	}
	const target = path.resolve(uiDir, decoded === "/" ? "index.html" : decoded.slice(1));
	if (!target.startsWith(uiDir + path.sep)) return fail(res, 404, "not found");
	let body: Buffer;
	try {
		body = readFileSync(target);
	} catch {
		return fail(res, 404, "not found");
	}
	res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream" });
	res.end(body);
}
