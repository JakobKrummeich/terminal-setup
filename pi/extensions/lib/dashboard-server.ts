/**
 * dashboard-server — stateless HTTP server for the agent dashboard
 * (docs/agent-dashboard-spec.md decisions 6/7; response shapes in
 * lib/dashboard-api.ts).
 *
 * Stateless by contract: every request re-derives its answer from disk
 * (agent-runs.jsonl via readRuns + session JSONLs via session-transcript), so
 * ANY pi instance can serve the whole project history, including trees written
 * by other processes. No in-memory session state, no caches.
 *
 * Lifecycle: the listening socket and every accepted connection are unref()ed —
 * the server must never keep a pi process (or the test suite, see AGENTS.md on
 * keep-alive sockets) alive. close() destroys open sockets so tests shut down
 * deterministically. EADDRINUSE resolves as { started: false }: another pi
 * instance already serves this project; the caller just prints the URL.
 */
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { readRuns, runsFilePath } from "./agent-runs.ts";
import {
	deriveSessions,
	deriveSpawnAnchors,
	deriveTree,
	sessionFileFor,
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
 * lands on lib/dashboard-ui/ here. Tests override via options.uiDir.
 */
function defaultUiDir(env: NodeJS.ProcessEnv): string {
	// `||` not `??`: pi's own getAgentDir treats an empty env var as unset.
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "extensions", "lib", "dashboard-ui");
}

export interface DashboardServerOptions {
	/** Session dir holding agent-runs.jsonl and the session JSONLs. */
	dir: string;
	/** 0 = ephemeral (tests). */
	port: number;
	/** Default 0.0.0.0 (decision 6: user maps container ports). */
	host?: string;
	/** Static file root; default resolves lib/dashboard-ui via the agent dir. */
	uiDir?: string;
	/** SSE change-coalescing window; default 500ms. Tests shrink it. */
	sseDebounceMs?: number;
}

export interface DashboardServer {
	/** Actual bound port (differs from options.port when that was 0). */
	port: number;
	/** Stop listening and destroy open sockets (incl. SSE streams). */
	close(): Promise<void>;
}

export type StartResult = { started: true; server: DashboardServer } | { started: false; reason: "port-in-use" };

/** Resolves once listening (or once EADDRINUSE is known); rejects on other errors. */
export function startDashboardServer(options: DashboardServerOptions): Promise<StartResult> {
	const uiDir = path.resolve(options.uiDir ?? defaultUiDir(process.env));
	const sseDebounceMs = options.sseDebounceMs ?? 500;
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		try {
			route(req, res, options.dir, uiDir, sseDebounceMs);
		} catch (error) {
			if (res.headersSent) res.destroy();
			else fail(res, 500, `internal error: ${String(error)}`);
		}
	});
	server.on("connection", (socket) => {
		socket.unref(); // a lingering keep-alive/SSE socket must not hold the process
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.unref();
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
function route(req: IncomingMessage, res: ServerResponse, dir: string, uiDir: string, sseDebounceMs: number): void {
	if (req.method !== "GET") return fail(res, 405, "GET only");
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/api/sessions") return handleSessions(res, dir);
	if (url.pathname === "/api/tree") return handleTree(res, dir, url.searchParams.get("root"));
	if (url.pathname === "/api/transcript") return handleTranscript(res, dir, url.searchParams.get("sid"));
	if (url.pathname === "/api/events") return handleEvents(req, res, dir, url.searchParams.get("sid"), sseDebounceMs);
	return handleStatic(res, uiDir, url.pathname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, message: string): void {
	json(res, status, { error: message });
}

/** GET /api/sessions → SessionsResponse */
function handleSessions(res: ServerResponse, dir: string): void {
	json(res, 200, deriveSessions(readRuns(dir), Date.now(), readSessionStats));
}

/** GET /api/tree?root=<sid> → TreeResponse */
function handleTree(res: ServerResponse, dir: string, root: string | null): void {
	if (!root) return fail(res, 400, "missing ?root=<sid>");
	const tree = deriveTree(readRuns(dir), root, Date.now(), readSessionStats);
	if (!tree) return fail(res, 404, `unknown root: ${root}`);
	json(res, 200, tree);
}

/** GET /api/transcript?sid=<sid> → TranscriptResponse */
function handleTranscript(res: ServerResponse, dir: string, sid: string | null): void {
	if (!sid) return fail(res, 400, "missing ?sid=<sid>");
	const events = readRuns(dir);
	const file = sessionFileFor(events, sid);
	if (!file) return fail(res, 404, `unknown sid: ${sid}`);
	const parsed = parseTranscript(file);
	if (!parsed) return fail(res, 404, `transcript unreadable: ${sid}`);
	const anchors: TranscriptAnchor[] = [
		...parsed.handoffEntryIndexes.map((entryIndex): TranscriptAnchor => ({ type: "handoff", entryIndex })),
		...deriveSpawnAnchors(
			events,
			sid,
			parsed.entries.map((entry) => entry.tsMs),
		),
	].sort((a, b) => a.entryIndex - b.entryIndex);
	const body: TranscriptResponse = { sid, entries: parsed.entries, anchors };
	json(res, 200, body);
}

/**
 * GET /api/events[?sid=<sid>] — SSE, deliberately dumb: any change to the index
 * (or, with ?sid=, that sid's session file) emits one debounced
 * `data: {"changed":true}` and clients refetch. No replay, no payloads.
 * Watches the session DIR (fs.watch on a not-yet-existing file throws) and
 * filters by basename; session files live beside the index (spec decision 4).
 */
function handleEvents(
	req: IncomingMessage,
	res: ServerResponse,
	dir: string,
	sid: string | null,
	sseDebounceMs: number,
): void {
	const names = new Set([path.basename(runsFilePath(dir))]);
	if (sid) {
		const file = sessionFileFor(readRuns(dir), sid);
		if (file) names.add(path.basename(file));
	}
	let watcher: FSWatcher;
	let timer: NodeJS.Timeout | null = null;
	const stop = (): void => {
		watcher.close();
		if (timer) clearTimeout(timer);
		timer = null;
	};
	try {
		watcher = watch(dir, (_type, filename) => {
			if (typeof filename === "string" && !names.has(filename)) return; // null/Buffer filename: over-notify, never miss
			if (timer) return; // change already pending — coalesce
			timer = setTimeout(() => {
				timer = null;
				// Client can vanish inside the debounce window, racing the 'close'
				// handler's clearTimeout — never write into a dead stream.
				if (res.writableEnded || res.destroyed) return;
				res.write('data: {"changed":true}\n\n');
			}, sseDebounceMs);
			timer.unref?.();
		});
	} catch (error) {
		return fail(res, 500, `cannot watch session dir: ${String(error)}`);
	}
	// The watch backend can fail at runtime (dir deleted, inotify limits). This
	// server runs inside the user's live pi process: an unhandled 'error' there
	// is unacceptable — fold the stream quietly, the client just reconnects.
	watcher.on("error", () => {
		stop();
		if (!res.writableEnded && !res.destroyed) res.end();
	});
	res.on("error", () => {}); // client reset mid-write: cleanup happens via req 'close'
	watcher.unref();
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(":connected\n\n");
	req.on("close", stop);
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
