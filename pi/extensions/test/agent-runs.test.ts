/**
 * agent-runs.jsonl — the dashboard's on-disk event index (docs/agent-dashboard-spec.md).
 *
 * Reader contract: tolerate concurrent-writer damage (corrupt lines), dedupe
 * repeated session-start rows (resume/reload re-log them), and drop rows whose
 * session transcript vanished (retention follows the session JSONLs).
 *
 * Writer integration runs runChildTool for real (explore.test.ts's fake-ctx
 * pattern: real child sessions, scripted model stream) and checks the rows —
 * including parentSid/root threading for a child spawned from inside a child.
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Children resolve their config dir and session dir from the environment; point both
// at temp dirs so the tests never touch (or load extensions from) the live ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-agent-runs-agentdir-"));
const SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-agent-runs-sessions-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
// No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests and
// hang the test process.
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as agentDashModule from "../agent-dash.ts";
import {
	type AgentRunEvent,
	appendEvent,
	readRuns,
	type RunFinish,
	type RunProgress,
	type RunSpawn,
	runsFilePath,
} from "../lib/agent-runs.ts";
import { liveChildren, runChildTool } from "../lib/child-session.ts";
import { sleep } from "./harness.ts";

// --- pure reader/writer tests -----------------------------------------------

function tempIndexDir(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-agent-runs-index-"));
}

/** A stand-in session transcript; readRuns only checks that the file exists. */
function touchSession(dir: string, name: string): string {
	const file = path.join(dir, name);
	writeFileSync(file, '{"type":"session"}\n');
	return file;
}

const spawnRow = (dir: string, sid: string, sessionFile: string, ts = 1): RunSpawn => ({
	ts,
	event: "spawn",
	sid,
	root: "root-sid",
	parentSid: "root-sid",
	kind: "agent",
	label: `agent#${sid}`,
	sessionFile,
	description: `task ${sid}`,
});

test("appendEvent/readRuns roundtrip preserves every event verbatim, in order", () => {
	const dir = tempIndexDir();
	const mainFile = touchSession(dir, "main.jsonl");
	const childFile = touchSession(dir, "child.jsonl");
	const events: AgentRunEvent[] = [
		{ ts: 1, event: "session-start", sid: "main-1", sessionFile: mainFile },
		{
			ts: 2,
			event: "spawn",
			sid: "child-1",
			root: "main-1",
			parentSid: "main-1",
			kind: "agent",
			label: "agent#ab12cd34",
			sessionFile: childFile,
			description: "do the thing",
		},
		{ ts: 3, event: "progress", sid: "child-1", turn: 2, tool: "edit" },
		{ ts: 4, event: "reset", sid: "child-1" },
		{
			ts: 5,
			event: "finish",
			sid: "child-1",
			status: "done",
			turns: 9,
			costUsd: 0.42,
			contextTokens: 91_000,
			contextPercent: 45,
			resets: 1,
			durationMs: 245_000,
		},
	];
	for (const event of events) appendEvent(dir, event);
	assert.deepEqual(readRuns(dir), events);
});

test("readRuns: missing index file → empty list; appendEvent with no dir writes nothing", () => {
	assert.deepEqual(readRuns(tempIndexDir()), []);
	// In-memory sessions report dir "" — nothing may land in the process cwd.
	appendEvent("", { ts: 1, event: "reset", sid: "x" });
	assert.equal(existsSync("agent-runs.jsonl"), false);
});

test("readRuns skips corrupt and foreign lines but keeps the valid ones around them", () => {
	const dir = tempIndexDir();
	const file = touchSession(dir, "a.jsonl");
	const good = spawnRow(dir, "sid-a", file);
	appendFileSync(runsFilePath(dir), "{{{ not json at all\n");
	appendEvent(dir, good);
	appendFileSync(
		runsFilePath(dir),
		'{"ts":1,"sid":"sid-a","event":"no-such-event"}\n' + // unknown event type
			'{"ts":2,"event":"progress","turn":1}\n' + // missing sid
			'{"ts":"three","sid":"sid-a","event":"reset"}\n' + // ts not a number
			'{"ts":4,"sid":"sid-b","event":"spawn","root":"r"}\n' + // spawn without sessionFile
			'{"ts":5,"sid":"sid-a","event":"finish","status":"done"}\n' + // finish missing turns/costUsd/…
			'{"ts":6,"sid":"sid-a","event":"progress","tool":"edit"}\n' + // progress without turn
			"null\n" + // valid JSON, not an object
			"\n", // blank line
	);
	const reset: AgentRunEvent = { ts: 7, event: "reset", sid: "sid-a" };
	appendEvent(dir, reset);
	assert.deepEqual(readRuns(dir), [good, reset]);
});

test("readRuns dedupes repeated session-start per sid — first row (true start time) wins", () => {
	const dir = tempIndexDir();
	const fileA = touchSession(dir, "a.jsonl");
	const fileB = touchSession(dir, "b.jsonl");
	appendEvent(dir, { ts: 10, event: "session-start", sid: "main-a", sessionFile: fileA });
	appendEvent(dir, { ts: 20, event: "session-start", sid: "main-b", sessionFile: fileB });
	appendEvent(dir, { ts: 30, event: "session-start", sid: "main-a", sessionFile: fileA }); // resume
	const events = readRuns(dir);
	assert.deepEqual(
		events.map((e) => [e.event, e.sid, e.ts]),
		[
			["session-start", "main-a", 10],
			["session-start", "main-b", 20],
		],
	);
});

test("readRuns prunes rows whose session file vanished, and orphan rows without an intro", () => {
	const dir = tempIndexDir();
	const keepFile = touchSession(dir, "keep.jsonl");
	const goneFile = touchSession(dir, "gone.jsonl");
	const keepSpawn = spawnRow(dir, "sid-keep", keepFile);
	const keepFinish: AgentRunEvent = {
		ts: 9,
		event: "finish",
		sid: "sid-keep",
		status: "done",
		turns: 1,
		costUsd: 0,
		contextTokens: null,
		contextPercent: null,
		resets: 0,
		durationMs: 10,
	};
	appendEvent(dir, keepSpawn);
	appendEvent(dir, spawnRow(dir, "sid-gone", goneFile, 2));
	appendEvent(dir, { ts: 3, event: "progress", sid: "sid-gone", turn: 1 });
	appendEvent(dir, { ts: 4, event: "progress", sid: "ghost", turn: 1 }); // no intro row at all
	appendEvent(dir, keepFinish);
	rmSync(goneFile);
	assert.deepEqual(readRuns(dir), [keepSpawn, keepFinish]);
	// Pruning is reader-side only: the shared append-only file is never rewritten.
	assert.equal(readFileSync(runsFilePath(dir), "utf8").split("\n").filter(Boolean).length, 5);
});

// --- agent-dash session-start writer ----------------------------------------

test("agent-dash writes a session-start row for the main session", async () => {
	const dir = tempIndexDir();
	const sessionFile = touchSession(dir, "main.jsonl");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const fakePi = { on: (name: string, handler: never) => void handlers.set(name, handler) };
	// This test dir is ESM but the extension is checked as CJS; unwrap the
	// interop default like explore.test.ts does.
	type DashFn = (pi: unknown) => void;
	const d = (agentDashModule as unknown as { default: DashFn | { default: DashFn } }).default;
	(typeof d === "function" ? d : d.default)(fakePi);
	const ctx = {
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => "main-sid-1",
			getSessionFile: () => sessionFile,
		},
	};
	handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	const events = readRuns(dir);
	assert.equal(events.length, 1);
	assert.equal(events[0].event, "session-start");
	assert.equal(events[0].sid, "main-sid-1");
	assert.equal((events[0] as { sessionFile?: string }).sessionFile, sessionFile);
});

// --- child-session writers (real runChildTool, scripted LLM) -----------------

const parentModel = getModel("anthropic", "claude-sonnet-4-5")!;

/**
 * Fake ExtensionContext with a scripted model stream (explore.test.ts pattern)
 * plus a sessionManager stub so the spawn writer sees a spawner sid.
 */
async function makeCtx(spawnerSid: string): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-runs-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(30);
			output.content = [{ type: "text", text: "child done" }];
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		})();
		return stream;
	};
	return {
		cwd: dir,
		model: parentModel,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => spawnerSid },
	} as unknown as ExtensionContext;
}

/** Child sessions hold open handles; drop them or the test process never exits. */
function disposeChildren() {
	for (const record of liveChildren.values()) record.session.dispose();
	liveChildren.clear();
}

const AGENT_OPTIONS = { kind: "agent", busyGroup: "agent", excludeTools: ["Agent"] };

test("runChildTool writes spawn/progress/finish rows; a child-spawned child threads parentSid/root", async () => {
	try {
		const mainCtx = await makeCtx("main-sid");
		const first = await runChildTool(
			{ prompt: "quick task", description: "index check" },
			AGENT_OPTIONS,
			undefined,
			undefined,
			mainCtx,
		);
		const firstId = (first.details as { id: string }).id;
		const firstRecord = liveChildren.get(firstId)!;
		assert.ok(firstRecord, "child record must exist");

		let events = readRuns(SESSION_DIR);
		const spawn = events.find((e): e is RunSpawn => e.event === "spawn");
		assert.ok(spawn, "spawn row must be written");
		assert.equal(spawn.sid, firstRecord.sid);
		assert.equal(spawn.root, "main-sid", "main-spawned child: root = main sid");
		assert.equal(spawn.parentSid, "main-sid", "main-spawned child: parentSid = main sid (== root)");
		assert.equal(spawn.kind, "agent");
		assert.equal(spawn.label, `agent#${firstId}`);
		assert.equal(spawn.description, "index check");
		assert.ok(existsSync(spawn.sessionFile), "spawn row points at the child's real session file");

		const progress = events.filter((e): e is RunProgress => e.event === "progress");
		assert.ok(progress.length >= 1, "at least one progress heartbeat");
		assert.equal(progress[0].sid, firstRecord.sid);
		assert.equal(progress[0].turn, 1, "single-turn child: heartbeat says turn 1");

		const finish = events.find((e): e is RunFinish => e.event === "finish");
		assert.ok(finish, "finish row must be written");
		assert.equal(finish.sid, firstRecord.sid);
		assert.equal(finish.status, "done");
		assert.equal(finish.turns, 1);
		assert.equal(finish.resets, 0);
		assert.equal(typeof finish.costUsd, "number");
		assert.ok(finish.durationMs >= 0);

		// Spawn from inside the first child (an agent calling Explore): the spawner's
		// ctx is the child's own context, so parentSid = that child's sid and root
		// stays the main session's sid.
		const childCtx = await makeCtx(firstRecord.sid);
		const second = await runChildTool(
			{ prompt: "nested lookup", description: "nested check" },
			{ kind: "explorer", busyGroup: "explorer", excludeTools: [] },
			undefined,
			undefined,
			childCtx,
		);
		const secondId = (second.details as { id: string }).id;
		const secondRecord = liveChildren.get(secondId)!;
		events = readRuns(SESSION_DIR);
		const nested = events.find(
			(e): e is RunSpawn => e.event === "spawn" && e.sid === secondRecord.sid,
		);
		assert.ok(nested, "nested spawn row must be written");
		assert.equal(nested.parentSid, firstRecord.sid, "nested child: parentSid = spawning child's sid");
		assert.equal(nested.root, "main-sid", "nested child: root stays the main session's sid");
		assert.equal(nested.kind, "explorer");
	} finally {
		disposeChildren();
	}
});
