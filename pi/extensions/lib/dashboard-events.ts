/**
 * dashboard-events — the /api/events SSE stream of lib/dashboard-server.ts
 * (plain node only, like the server: see its header).
 *
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
import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export interface EventStreamOptions {
	sessionsRoot: string;
	debounceMs: number;
	/** Basenames inside project dirs that count as a change. */
	names: ReadonlySet<string>;
}

/** 500 with dashboard-server's `{ error }` JSON body — the stream never started. */
function fail500(res: ServerResponse, message: string): void {
	res.writeHead(500, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: message }));
}

export function openEventStream(req: IncomingMessage, res: ServerResponse, options: EventStreamOptions): void {
	const stream: EventStream = {
		res,
		...options,
		dirWatchers: new Map(),
		rootWatcher: null,
		timer: null,
	};
	// The watch backend can fail at connect (root missing, inotify limits) —
	// that's a request failure. At runtime it must never throw unhandled: this
	// server may run inside a test host process; fold the stream quietly, the
	// client just reconnects.
	let rootWatcher: FSWatcher;
	try {
		rootWatcher = watch(options.sessionsRoot, (_type, filename) => onRootChange(stream, filename));
	} catch (error) {
		return fail500(res, `cannot watch sessions root: ${String(error)}`);
	}
	stream.rootWatcher = rootWatcher;
	rootWatcher.on("error", () => foldStream(stream));
	rootWatcher.unref();
	scanProjectDirs(stream);
	if (res.writableEnded) return; // root vanished during setup: already folded as a 500
	res.on("error", () => {}); // client reset mid-write: cleanup happens via req 'close'
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(":connected\n\n");
	req.on("close", () => stopStream(stream));
}

/** One /api/events connection's watchers and pending debounce. */
interface EventStream extends EventStreamOptions {
	res: ServerResponse;
	dirWatchers: Map<string, FSWatcher>;
	/** Set right after connect; null only while openEventStream is creating it. */
	rootWatcher: FSWatcher | null;
	timer: NodeJS.Timeout | null;
}

function emitChange(stream: EventStream): void {
	if (stream.timer) return; // change already pending — coalesce
	stream.timer = setTimeout(() => {
		stream.timer = null;
		// Client can vanish inside the debounce window, racing the 'close'
		// handler's clearTimeout — never write into a dead stream.
		if (stream.res.writableEnded || stream.res.destroyed) return;
		stream.res.write('data: {"changed":true}\n\n');
	}, stream.debounceMs);
	stream.timer.unref?.();
}

/** Root watcher callback: a project dir appeared/vanished/was touched. */
function onRootChange(stream: EventStream, filename: string | null): void {
	emitChange(stream); // a project appearing/vanishing changes /api/sessions
	// A deleted dir's watcher stays open on its dead inode WITHOUT erroring
	// (Linux) and would block re-watching a recreated dir of the same name.
	// Root events name the touched entry: drop its watcher; the rescan
	// re-adds a live one if the dir (still) exists.
	if (typeof filename === "string") {
		const dir = path.join(stream.sessionsRoot, filename);
		stream.dirWatchers.get(dir)?.close();
		stream.dirWatchers.delete(dir);
	} else {
		// No filename (platform edge): can't tell which — rebuild them all.
		for (const watcher of stream.dirWatchers.values()) watcher.close();
		stream.dirWatchers.clear();
	}
	scanProjectDirs(stream); // pick up new dirs so their future appends are seen
}

function watchProjectDir(stream: EventStream, dir: string): void {
	if (stream.dirWatchers.has(dir)) return;
	let watcher: FSWatcher;
	try {
		watcher = watch(dir, (_type, filename) => {
			if (typeof filename === "string" && !stream.names.has(filename)) return; // null/Buffer filename: over-notify, never miss
			emitChange(stream);
		});
	} catch {
		return; // dir vanished between scan and watch: skipped, rescan re-tries
	}
	watcher.on("error", () => {
		// Dir deleted / inotify hiccup: its rows are gone — that IS a change.
		watcher.close();
		stream.dirWatchers.delete(dir);
		emitChange(stream);
	});
	watcher.unref();
	stream.dirWatchers.set(dir, watcher);
}

function scanProjectDirs(stream: EventStream): void {
	let entries: string[];
	try {
		entries = readdirSync(stream.sessionsRoot);
	} catch {
		// Root gone. fs.watch (Linux) emits only 'rename' for self-deletion,
		// never 'error' — the root watcher is silently dead, so fold the stream
		// ourselves: the client reconnects, gets a clean 500 while the root is
		// missing (EventSource falls back to polling) and a live stream once
		// it is back.
		foldStream(stream);
		return;
	}
	for (const name of entries) {
		const dir = path.join(stream.sessionsRoot, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue; // vanished between readdir and stat
		}
		watchProjectDir(stream, dir); // index-less dirs too: their index may appear later
	}
}

function stopStream(stream: EventStream): void {
	stream.rootWatcher?.close();
	for (const watcher of stream.dirWatchers.values()) watcher.close();
	stream.dirWatchers.clear();
	if (stream.timer) clearTimeout(stream.timer);
	stream.timer = null;
}

/** Tear down and end the stream (500 when it never started) — the client's cue to reconnect. */
function foldStream(stream: EventStream): void {
	stopStream(stream);
	if (!stream.res.headersSent) fail500(stream.res, "sessions root vanished");
	else if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.end();
}
