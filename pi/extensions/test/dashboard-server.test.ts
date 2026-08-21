/**
 * dashboard-server — HTTP API over a synthetic sessions root (multi-project).
 *
 * Contract under test (lib/dashboard-api.ts shapes): project-dir enumeration,
 * /api/sessions rows (with project identity), /api/tree node derivation
 * (done / running / abandoned) with cross-dir sid resolution, /api/transcript
 * parsing + anchors, /api/meta identity, vanished-dir pruning, parameter/
 * unknown-id errors, static-file traversal rejection, and SSE change
 * notification (root + per-dir watches). Everything runs against temp roots
 * with hand-written agent-runs.jsonl + session JSONL fixtures; servers bind
 * port 0 on 127.0.0.1 and are closed in finally blocks (their sockets are
 * unref'd, so a leak would not hang the suite — but don't leak anyway).
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Keep everything (incl. transitive pi imports from agent-dash → child-session)
// away from the live ~/.pi/agent and off the network.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-dash-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-dash-sessions-"));
process.env.PI_OFFLINE = "1";

import * as agentDashModule from "../agent-dash.ts";
import { appendEvent } from "../lib/agent-runs.ts";
import type { MetaResponse, SessionsResponse, TranscriptResponse, TreeResponse } from "../lib/dashboard-api.ts";
import { type DashboardServer, startDashboardServer } from "../lib/dashboard-server.ts";

/** The repo's real static UI (also sanity-checked by a test below). */
const REAL_UI_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../lib/dashboard-ui");

function tempSessionsRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-dash-root-"));
}

/** One encoded-cwd project dir under a sessions root (default name decodes to "/tmp/project"). */
function projectDir(root: string, name = "--tmp-project--"): string {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function startServer(root: string, extra: { uiDir?: string; sseDebounceMs?: number } = {}): Promise<DashboardServer> {
	const result = await startDashboardServer({ sessionsRoot: root, port: 0, host: "127.0.0.1", uiDir: REAL_UI_DIR, ...extra });
	assert.ok(result.started, "server must bind an ephemeral port");
	return result.server;
}

/**
 * Raw GET — node's http client sends the path verbatim (fetch would normalize
 * "/../" away and defeat the traversal tests). agent:false: no keep-alive
 * client sockets lingering in the suite.
 */
function get(port: number, rawPath: string, method = "GET"): Promise<{ status: number; contentType: string; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					contentType: String(res.headers["content-type"] ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

async function getJson<T>(port: number, rawPath: string): Promise<T> {
	const res = await get(port, rawPath);
	assert.equal(res.status, 200, `${rawPath} → ${res.status}: ${res.body}`);
	assert.match(res.contentType, /application\/json/);
	return JSON.parse(res.body) as T;
}

function assertClose(actual: number, expected: number, what: string): void {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} !== ${expected}`);
}

// --- session JSONL fixtures (shape mirrored from lib/session-transcript.ts docs) ---

let entrySeq = 0;
function jsonlEntry(ts: number, fields: Record<string, unknown>): Record<string, unknown> {
	entrySeq += 1;
	return { id: `e${entrySeq}`, parentId: `e${entrySeq - 1}`, timestamp: new Date(ts).toISOString(), ...fields };
}

function usage(costTotal: number): Record<string, unknown> {
	return {
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function writeJsonl(file: string, lines: Record<string, unknown>[]): string {
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return file;
}

function header(sid: string, ts: number): Record<string, unknown> {
	return { type: "session", version: 3, id: sid, timestamp: new Date(ts).toISOString(), cwd: "/tmp/project" };
}

function userLine(ts: number, text: string): Record<string, unknown> {
	return jsonlEntry(ts, { type: "message", message: { role: "user", content: text, timestamp: ts } });
}

/** Minimal but realistic session file: header + one user message. */
function writeMinimalSession(dir: string, name: string, sid: string, ts: number): string {
	return writeJsonl(path.join(dir, name), [header(sid, ts), userLine(ts, "child task")]);
}

/**
 * One finished tree, ~10 minutes old:
 *   root-1 (cost 0.2+0.3, 2 turns, mtime T0+4000, handoff marker)
 *   └─ agent-1  (spawn T0+2100, reset, finish done T0+5000, cost 0.42)
 *      └─ exp-1 (spawn T0+2200, finish done T0+2900, cost 0.05)
 */
function buildFinishedTree(dir: string): { T0: number } {
	const T0 = Date.now() - 10 * 60_000;
	const rootFile = path.join(dir, "root-1.jsonl");
	writeJsonl(rootFile, [
		header("root-1", T0),
		userLine(T0 + 100, "hello"),
		jsonlEntry(T0 + 2000, {
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "working" },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -la" } },
				],
				usage: usage(0.2),
				stopReason: "toolUse",
				timestamp: T0 + 2000,
			},
		}),
		jsonlEntry(T0 + 2500, {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: "x".repeat(3000) }],
				isError: false,
				timestamp: T0 + 2500,
			},
		}),
		jsonlEntry(T0 + 2600, { type: "custom_message", customType: "context-cap-swap", content: "swap", display: true }),
		jsonlEntry(T0 + 4000, {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: usage(0.3),
				stopReason: "stop",
				timestamp: T0 + 4000,
			},
		}),
	]);
	utimesSync(rootFile, new Date(T0 + 4000), new Date(T0 + 4000));
	const agentFile = writeMinimalSession(dir, "agent-1.jsonl", "agent-1", T0 + 2150);
	const expFile = writeMinimalSession(dir, "exp-1.jsonl", "exp-1", T0 + 2250);
	appendEvent(dir, { ts: T0, event: "session-start", sid: "root-1", sessionFile: rootFile });
	appendEvent(dir, {
		ts: T0 + 2100,
		event: "spawn",
		sid: "agent-1",
		root: "root-1",
		parentSid: "root-1",
		kind: "agent",
		label: "agent#00000001",
		sessionFile: agentFile,
		description: "refactor the parser",
	});
	appendEvent(dir, {
		ts: T0 + 2200,
		event: "spawn",
		sid: "exp-1",
		root: "root-1",
		parentSid: "agent-1",
		kind: "explorer",
		label: "explorer#00000002",
		sessionFile: expFile,
		description: "find the config",
	});
	appendEvent(dir, {
		ts: T0 + 2900,
		event: "finish",
		sid: "exp-1",
		status: "done",
		turns: 2,
		costUsd: 0.05,
		contextTokens: 1000,
		contextPercent: 5,
		resets: 0,
		durationMs: 700,
	});
	appendEvent(dir, { ts: T0 + 3000, event: "reset", sid: "agent-1" });
	appendEvent(dir, {
		ts: T0 + 5000,
		event: "finish",
		sid: "agent-1",
		status: "done",
		turns: 9,
		costUsd: 0.42,
		contextTokens: 91_000,
		contextPercent: 45,
		resets: 1,
		durationMs: 2900,
	});
	return { T0 };
}

// --- /api/sessions -----------------------------------------------------------

test("GET /api/sessions: rows aggregate cost/agents/resets; newest first; recent activity → running", async () => {
	const root = tempSessionsRoot();
	const dir = projectDir(root);
	const { T0 } = buildFinishedTree(dir);
	const now = Date.now();
	const root2File = writeMinimalSession(dir, "root-2.jsonl", "root-2", now - 30_000);
	appendEvent(dir, { ts: now - 30_000, event: "session-start", sid: "root-2", sessionFile: root2File });
	const server = await startServer(root);
	try {
		const { sessions } = await getJson<SessionsResponse>(server.port, "/api/sessions");
		assert.equal(sessions.length, 2);
		// Newest first: root-2 started ~30s ago, root-1 ~10min ago.
		assert.equal(sessions[0].sid, "root-2");
		assert.equal(sessions[0].running, true, "fresh mtime + fresh event → running");
		const row = sessions[1];
		assert.equal(row.sid, "root-1");
		assert.equal(row.running, false, "10-minute-old activity → finished");
		assert.equal(row.startTs, T0);
		assert.equal(row.durationMs, 5000, "start → last tree activity (agent-1 finish at T0+5000)");
		assertClose(row.costUsd, 0.2 + 0.3 + 0.42 + 0.05, "own JSONL cost + children finish costs");
		assert.equal(row.agentCount, 2, "agent + explorer spawns");
		assert.equal(row.resetCount, 1);
		assert.equal(row.projectId, "--tmp-project--", "raw dir name is the stable project id");
		assert.equal(row.project, "/tmp/project", "display path decoded from the dir name");
	} finally {
		await server.close();
	}
});

// --- /api/tree ---------------------------------------------------------------

test("GET /api/tree: root + child nodes with status done, parent links, costs, turns", async () => {
	const root = tempSessionsRoot();
	const { T0 } = buildFinishedTree(projectDir(root));
	const server = await startServer(root);
	try {
		const tree = await getJson<TreeResponse>(server.port, "/api/tree?root=root-1");
		assert.equal(tree.root, "root-1");
		const bySid = new Map(tree.nodes.map((node) => [node.sid, node]));
		assert.equal(tree.nodes.length, 3);

		const root = bySid.get("root-1")!;
		assert.equal(root.kind, "main");
		assert.equal(root.label, "main");
		assert.equal(root.parentSid, null);
		assert.equal(root.status, "done");
		assert.equal(root.startTs, T0);
		assert.equal(root.endTs, T0 + 5000, "root end = last tree activity");
		assertClose(root.costUsd ?? -1, 0.5, "root cost = own JSONL usage");
		assert.equal(root.turns, 2, "two assistant messages");
		assert.equal(root.resets, 0);

		const agent = bySid.get("agent-1")!;
		assert.equal(agent.kind, "agent");
		assert.equal(agent.parentSid, "root-1");
		assert.equal(agent.description, "refactor the parser");
		assert.equal(agent.status, "done");
		assert.equal(agent.startTs, T0 + 2100);
		assert.equal(agent.endTs, T0 + 5000);
		assertClose(agent.costUsd ?? -1, 0.42, "agent cost from finish row");
		assert.equal(agent.resets, 1);
		assert.equal(agent.turns, 9);

		const explorer = bySid.get("exp-1")!;
		assert.equal(explorer.kind, "explorer");
		assert.equal(explorer.parentSid, "agent-1");
		assert.equal(explorer.status, "done");
		assert.equal(explorer.endTs, T0 + 2900);
	} finally {
		await server.close();
	}
});

test("GET /api/tree: unsettled children are running when fresh, abandoned when stale", async () => {
	const sessionsRoot = tempSessionsRoot();
	const dir = projectDir(sessionsRoot);
	const now = Date.now();
	const old = now - 10 * 60_000;
	const rootFile = writeMinimalSession(dir, "root-3.jsonl", "root-3", now - 60_000);
	const runFile = writeMinimalSession(dir, "run.jsonl", "child-run", now - 50_000);
	const abFile = writeMinimalSession(dir, "ab.jsonl", "child-ab", old);
	appendEvent(dir, { ts: now - 60_000, event: "session-start", sid: "root-3", sessionFile: rootFile });
	appendEvent(dir, {
		ts: now - 50_000,
		event: "spawn",
		sid: "child-run",
		root: "root-3",
		parentSid: "root-3",
		kind: "agent",
		label: "agent#run",
		sessionFile: runFile,
		description: "still going",
	});
	appendEvent(dir, { ts: now - 1000, event: "progress", sid: "child-run", turn: 3, tool: "edit" });
	appendEvent(dir, {
		ts: old,
		event: "spawn",
		sid: "child-ab",
		root: "root-3",
		parentSid: "root-3",
		kind: "agent",
		label: "agent#ab",
		sessionFile: abFile,
		description: "died mid-run",
	});
	appendEvent(dir, {
		ts: old + 1000,
		event: "finish",
		sid: "child-ab",
		status: "done",
		turns: 1,
		costUsd: 0.01,
		contextTokens: null,
		contextPercent: null,
		resets: 0,
		durationMs: 900,
	});
	// Activity AFTER the finish (resume) that never settled again → abandoned once stale.
	appendEvent(dir, { ts: old + 2000, event: "progress", sid: "child-ab", turn: 5 });
	const server = await startServer(sessionsRoot);
	try {
		const tree = await getJson<TreeResponse>(server.port, "/api/tree?root=root-3");
		const bySid = new Map(tree.nodes.map((node) => [node.sid, node]));
		assert.equal(bySid.get("root-3")!.status, "running");
		assert.equal(bySid.get("root-3")!.endTs, null);

		const running = bySid.get("child-run")!;
		assert.equal(running.status, "running");
		assert.equal(running.endTs, null);
		assert.equal(running.turns, 3, "turns from progress while unsettled");
		assert.equal(running.costUsd, null, "no finish row yet");

		const abandoned = bySid.get("child-ab")!;
		assert.equal(abandoned.status, "abandoned");
		assert.equal(abandoned.endTs, old + 2000, "abandoned end = last observed activity");
		assert.equal(abandoned.turns, 5);
	} finally {
		await server.close();
	}
});

// --- /api/transcript ---------------------------------------------------------

test("GET /api/transcript: entries, tool output truncation, handoff + spawn anchors", async () => {
	const root = tempSessionsRoot();
	const { T0 } = buildFinishedTree(projectDir(root));
	const server = await startServer(root);
	try {
		const transcript = await getJson<TranscriptResponse>(server.port, "/api/transcript?sid=root-1");
		assert.equal(transcript.sid, "root-1");
		assert.equal(transcript.entries.length, 3, "user, assistant+tool, assistant — toolResult is no entry");
		assert.deepEqual(
			transcript.entries.map((entry) => entry.role),
			["user", "assistant", "assistant"],
		);
		assert.equal(transcript.entries[0].text, "hello");
		assert.equal(transcript.entries[0].tsMs, T0 + 100);

		const [call] = transcript.entries[1].toolCalls;
		assert.equal(call.name, "bash");
		assert.match(call.argsSummary, /ls -la/);
		assert.ok(call.output.startsWith("x".repeat(2000)), "output keeps the first 2000 chars");
		assert.ok(call.output.endsWith("… [truncated]"), "3000-char output is marked truncated");
		assert.equal(call.output.length, 2000 + "… [truncated]".length);

		const handoff = transcript.anchors.find((anchor) => anchor.type === "handoff");
		assert.ok(handoff, "context-cap-swap custom_message → handoff anchor");
		assert.equal(handoff.entryIndex, 2, "anchored at the entry after the marker");

		const spawn = transcript.anchors.find((anchor) => anchor.type === "agent-spawn");
		assert.ok(spawn, "child spawned by this sid → anchor");
		assert.equal(spawn.targetSid, "agent-1");
		assert.equal(spawn.entryIndex, 1, "nearest entry at/before spawn ts");
		assert.equal(spawn.label, "agent#00000001");
		assert.equal(spawn.description, "refactor the parser");
		assert.ok(
			!transcript.anchors.some((anchor) => anchor.targetSid === "exp-1"),
			"grandchild (spawned by agent-1) is not anchored in root-1",
		);

		// The agent's own transcript anchors its explorer spawn.
		const child = await getJson<TranscriptResponse>(server.port, "/api/transcript?sid=agent-1");
		const explorerSpawn = child.anchors.find((anchor) => anchor.type === "explorer-spawn");
		assert.ok(explorerSpawn, "explorer child → explorer-spawn anchor");
		assert.equal(explorerSpawn.targetSid, "exp-1");
	} finally {
		await server.close();
	}
});

// --- errors ------------------------------------------------------------------

test("API errors: missing params 400, unknown ids 404, non-GET 405, empty root ok", async () => {
	const server = await startServer(tempSessionsRoot());
	try {
		const empty = await getJson<SessionsResponse>(server.port, "/api/sessions");
		assert.deepEqual(empty.sessions, [], "no project dirs yet → empty list, not an error");
		assert.equal((await get(server.port, "/api/tree")).status, 400);
		assert.equal((await get(server.port, "/api/tree?root=nope")).status, 404);
		assert.equal((await get(server.port, "/api/transcript")).status, 400);
		assert.equal((await get(server.port, "/api/transcript?sid=nope")).status, 404);
		assert.equal((await get(server.port, "/", "POST")).status, 405);
		assert.match((await get(server.port, "/api/tree")).contentType, /application\/json/, "errors are JSON too");
	} finally {
		await server.close();
	}
});

// --- static files ------------------------------------------------------------

test("static: serves the repo UI shell at /", async () => {
	assert.ok(existsSync(path.join(REAL_UI_DIR, "index.html")), "repo must ship lib/dashboard-ui/index.html");
	const server = await startServer(tempSessionsRoot());
	try {
		const res = await get(server.port, "/");
		assert.equal(res.status, 200);
		assert.match(res.contentType, /text\/html/);
		assert.match(res.body, /app\.js/, "shell loads the SPA entry (asset coverage in dashboard-ui.test.ts)");
	} finally {
		await server.close();
	}
});

test("static: path traversal (raw, encoded, absolute) is rejected; unknown files 404", async () => {
	const base = mkdtempSync(path.join(tmpdir(), "pi-dash-ui-"));
	const uiDir = path.join(base, "ui");
	mkdirSync(uiDir);
	writeFileSync(path.join(uiDir, "index.html"), "<html>ok</html>");
	writeFileSync(path.join(uiDir, "app.js"), "console.log(1);");
	writeFileSync(path.join(base, "secret.txt"), "MUST-NOT-LEAK");
	const server = await startServer(tempSessionsRoot(), { uiDir });
	try {
		assert.equal((await get(server.port, "/app.js")).contentType, "text/javascript; charset=utf-8");
		for (const attempt of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "//etc/passwd", "/sub/../../secret.txt"]) {
			const res = await get(server.port, attempt);
			assert.equal(res.status, 404, `traversal must 404: ${attempt}`);
			assert.ok(!res.body.includes("MUST-NOT-LEAK"), `leaked through ${attempt}`);
		}
		assert.equal((await get(server.port, "/missing.css")).status, 404);
	} finally {
		await server.close();
	}
});

// --- SSE ---------------------------------------------------------------------

/** Connect, run `trigger` once the stream is up, resolve on the first change event. */
function sseExpectChange(port: number, rawPath: string, trigger: () => void): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		let triggered = false;
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", agent: false }, (res) => {
			assert.match(String(res.headers["content-type"]), /text\/event-stream/);
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				if (!triggered && buffer.includes(":connected")) {
					triggered = true;
					trigger();
				}
				if (buffer.includes('data: {"changed":true}')) {
					clearTimeout(guard);
					req.destroy();
					resolve();
				}
			});
		});
		const guard = setTimeout(() => {
			req.destroy();
			reject(new Error(`no SSE change within 10s; got: ${JSON.stringify(buffer)}`));
		}, 10_000);
		guard.unref?.();
		req.on("error", () => {}); // destroy() after resolve races an ECONNRESET; already settled
		req.end();
	});
}

test("GET /api/events: index append emits a debounced change; ?sid= also watches that session file", async () => {
	const sessionsRoot = tempSessionsRoot();
	const dir = projectDir(sessionsRoot);
	const now = Date.now();
	const rootFile = writeMinimalSession(dir, "root-sse.jsonl", "root-sse", now);
	const childFile = writeMinimalSession(dir, "child-sse.jsonl", "child-sse", now);
	appendEvent(dir, { ts: now, event: "session-start", sid: "root-sse", sessionFile: rootFile });
	appendEvent(dir, {
		ts: now,
		event: "spawn",
		sid: "child-sse",
		root: "root-sse",
		parentSid: "root-sse",
		kind: "agent",
		label: "agent#sse",
		sessionFile: childFile,
		description: "sse fixture",
	});
	const server = await startServer(sessionsRoot, { sseDebounceMs: 50 });
	try {
		await sseExpectChange(server.port, "/api/events", () =>
			appendEvent(dir, { ts: Date.now(), event: "reset", sid: "root-sse" }),
		);
		await sseExpectChange(server.port, "/api/events?sid=child-sse", () =>
			appendFileSync(childFile, JSON.stringify(userLine(Date.now(), "more")) + "\n"),
		);
	} finally {
		await server.close();
	}
});

test("GET /api/events: a project dir born after connect notifies, and its later appends are watched", async () => {
	const sessionsRoot = tempSessionsRoot();
	projectDir(sessionsRoot, "--existing--");
	const server = await startServer(sessionsRoot, { sseDebounceMs: 50 });
	try {
		// Dir creation alone must notify (the root watcher): /api/sessions changed.
		await sseExpectChange(server.port, "/api/events", () => {
			const born = projectDir(sessionsRoot, "--born-later--");
			appendEvent(born, { ts: Date.now(), event: "reset", sid: "any" });
		});
		// A fresh connection scans the new dir; an append inside it (no root-level
		// event at all) must still notify via the per-dir watcher.
		await sseExpectChange(server.port, "/api/events", () =>
			appendEvent(path.join(sessionsRoot, "--born-later--"), { ts: Date.now(), event: "reset", sid: "other" }),
		);
	} finally {
		await server.close();
	}
});

/** Persistent SSE client: counts change events, reports stream close, destroyable. */
function sseConnect(port: number): {
	count: () => number;
	isClosed: () => boolean;
	connected: Promise<void>;
	destroy: () => void;
} {
	let buffer = "";
	let closed = false;
	let onConnected = (): void => {};
	const connected = new Promise<void>((resolve) => (onConnected = resolve));
	const req = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET", agent: false }, (res) => {
		res.setEncoding("utf8");
		res.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.includes(":connected")) onConnected();
		});
		res.on("close", () => (closed = true));
		res.on("error", () => {});
	});
	req.on("error", () => {}); // our destroy() / server close may reset the socket
	req.end();
	return {
		count: () => buffer.split('data: {"changed":true}').length - 1,
		isClosed: () => closed,
		connected,
		destroy: () => req.destroy(),
	};
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(cond(), `timed out waiting for ${what}`);
}

test("GET /api/events: appends in a deleted-then-recreated project dir still notify the same stream", async () => {
	const sessionsRoot = tempSessionsRoot();
	const dir = projectDir(sessionsRoot, "--reborn--");
	appendEvent(dir, { ts: Date.now(), event: "reset", sid: "seed" });
	const server = await startServer(sessionsRoot, { sseDebounceMs: 50 });
	const client = sseConnect(server.port);
	try {
		await client.connected;
		rmSync(dir, { recursive: true, force: true });
		await waitFor(() => client.count() >= 1, "dir-delete notification (root watcher)");
		projectDir(sessionsRoot, "--reborn--");
		// Let the recreate notification (and its debounce window) fully drain so the
		// next count bump can only come from the append below.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const base = client.count();
		appendEvent(dir, { ts: Date.now(), event: "reset", sid: "again" });
		// Before the stale-watcher fix this timed out: the dead dir watcher
		// (bound to the deleted inode) blocked re-watching the recreated dir.
		await waitFor(() => client.count() > base, "append notification from the recreated dir");
	} finally {
		client.destroy();
		await server.close();
	}
});

test("GET /api/events: the stream folds when the sessions root vanishes; reconnect fails clean", async () => {
	const sessionsRoot = tempSessionsRoot();
	projectDir(sessionsRoot, "--doomed--");
	const server = await startServer(sessionsRoot, { sseDebounceMs: 50 });
	const client = sseConnect(server.port);
	try {
		await client.connected;
		rmSync(sessionsRoot, { recursive: true, force: true });
		// fs.watch on Linux emits only 'rename' (no 'error') when the watched root
		// vanishes — the server must fold the stream itself, not go silently dead.
		await waitFor(() => client.isClosed(), "stream close after sessions-root deletion");
		// Reconnect while the root is missing: clean 500 (EventSource then falls
		// back to polling), never a dead-air stream.
		assert.equal((await get(server.port, "/api/events")).status, 500);
	} finally {
		client.destroy();
		await server.close();
	}
});

test("GET /api/events: client disconnect during the debounce window raises nothing", async () => {
	const sessionsRoot = tempSessionsRoot();
	const dir = projectDir(sessionsRoot);
	// Long debounce: the client hangs up while the change emit is still pending.
	// An unhandled write-after-destroy would crash this (shared) test process.
	const server = await startServer(sessionsRoot, { sseDebounceMs: 200 });
	try {
		await new Promise<void>((resolve) => {
			const req = http.request({ host: "127.0.0.1", port: server.port, path: "/api/events", method: "GET", agent: false }, (res) => {
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					if (!chunk.includes(":connected")) return;
					appendEvent(dir, { ts: Date.now(), event: "reset", sid: "whoever" }); // schedules the debounced write
					setTimeout(() => req.destroy(), 50); // hang up mid-window
				});
				res.on("error", () => {});
				res.on("close", () => resolve());
			});
			req.on("error", () => {}); // our own destroy() may reset the socket
			req.end();
		});
		// Outlive the debounce window; a raced timer write must be a no-op.
		await new Promise((resolve) => setTimeout(resolve, 400));
	} finally {
		await server.close();
	}
});

// --- multi-project -----------------------------------------------------------

test("multi-project: /api/sessions merges all indexed dirs (skipping index-less ones); sids resolve across dirs", async () => {
	const root = tempSessionsRoot();
	const dirA = projectDir(root, "--home-a-proj--");
	const { T0 } = buildFinishedTree(dirA); // root-1 tree, ~10min old
	const dirB = projectDir(root, "--home-a-other--");
	const now = Date.now();
	const freshFile = writeMinimalSession(dirB, "fresh.jsonl", "fresh-root", now - 20_000);
	appendEvent(dirB, { ts: now - 20_000, event: "session-start", sid: "fresh-root", sessionFile: freshFile });
	projectDir(root, "--no-index-yet--"); // dir without agent-runs.jsonl: not a project (yet)
	writeFileSync(path.join(root, "stray-file"), "not a dir"); // junk directly under the root
	const server = await startServer(root);
	try {
		const { sessions } = await getJson<SessionsResponse>(server.port, "/api/sessions");
		assert.deepEqual(
			sessions.map((row) => [row.sid, row.projectId, row.project]),
			[
				["fresh-root", "--home-a-other--", "/home/a/other"],
				["root-1", "--home-a-proj--", "/home/a/proj"],
			],
			"both projects merged, newest first, index-less dir and stray file skipped",
		);
		// Sid resolution scans dirs: root-1/agent-1 live in dirA, fresh-root in dirB.
		const tree = await getJson<TreeResponse>(server.port, "/api/tree?root=root-1");
		assert.equal(tree.nodes.length, 3, "tree resolved in its own dir");
		const freshTree = await getJson<TreeResponse>(server.port, "/api/tree?root=fresh-root");
		assert.equal(freshTree.nodes.length, 1);
		const transcript = await getJson<TranscriptResponse>(server.port, "/api/transcript?sid=agent-1");
		assert.equal(transcript.sid, "agent-1");
		assert.equal(transcript.entries.length, 1, "child transcript from dirA");
		assert.equal(sessions[1].startTs, T0, "dirA row keeps its own tree's start time");
	} finally {
		await server.close();
	}
});

test("multi-project: a project dir vanishing between requests is pruned from /api/sessions", async () => {
	const root = tempSessionsRoot();
	const keepDir = projectDir(root, "--keep--");
	const goneDir = projectDir(root, "--gone--");
	const now = Date.now();
	const keepFile = writeMinimalSession(keepDir, "keep.jsonl", "keep-root", now);
	appendEvent(keepDir, { ts: now, event: "session-start", sid: "keep-root", sessionFile: keepFile });
	const goneFile = writeMinimalSession(goneDir, "gone.jsonl", "gone-root", now);
	appendEvent(goneDir, { ts: now, event: "session-start", sid: "gone-root", sessionFile: goneFile });
	const server = await startServer(root);
	try {
		const before = await getJson<SessionsResponse>(server.port, "/api/sessions");
		assert.deepEqual(before.sessions.map((row) => row.sid).sort(), ["gone-root", "keep-root"]);
		rmSync(goneDir, { recursive: true, force: true });
		const after = await getJson<SessionsResponse>(server.port, "/api/sessions");
		assert.deepEqual(
			after.sessions.map((row) => row.sid),
			["keep-root"],
			"stateless re-enumeration drops the vanished dir",
		);
		assert.equal((await get(server.port, "/api/tree?root=gone-root")).status, 404, "its sids stop resolving");
	} finally {
		await server.close();
	}
});

// --- /api/meta ---------------------------------------------------------------

test("GET /api/meta: daemon identity — hostname, resolved sessionsRoot, pid, startedAt", async () => {
	const root = tempSessionsRoot();
	const before = Date.now();
	const server = await startServer(root);
	try {
		const meta = await getJson<MetaResponse>(server.port, "/api/meta");
		assert.equal(meta.hostname, hostname());
		assert.equal(meta.sessionsRoot, path.resolve(root));
		assert.equal(meta.pid, process.pid, "embedded server: our own pid");
		assert.ok(meta.startedAt >= before && meta.startedAt <= Date.now(), "startedAt is the bind time");
	} finally {
		await server.close();
	}
});

// --- extension probe gating --------------------------------------------------

test("agent-dash: PI_OFFLINE gates the daemon probe; the session-start row is still written", async () => {
	const dir = projectDir(tempSessionsRoot());
	const sessionFile = writeMinimalSession(dir, "main.jsonl", "main-sid", Date.now());
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const fakePi = { on: (name: string, handler: never) => void handlers.set(name, handler) };
	type DashFn = (pi: unknown) => void;
	const d = (agentDashModule as unknown as { default: DashFn | { default: DashFn } }).default;
	(typeof d === "function" ? d : d.default)(fakePi);
	const notifications: string[] = [];
	const ctx = {
		ui: { notify: (message: string) => void notifications.push(message) },
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => "main-sid",
			getSessionFile: () => sessionFile,
		},
	};
	assert.equal(process.env.PI_OFFLINE, "1", "suite precondition");
	handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(notifications, [], "gated probe must neither touch sockets nor notify");
	const index = readFileSync(path.join(dir, "agent-runs.jsonl"), "utf8");
	assert.match(index, /"session-start"/, "index row is written regardless of the probe gate");
});
