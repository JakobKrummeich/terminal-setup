/**
 * dashboard-daemon + agent-dash probe — the standalone-daemon path
 * (docs/agent-dashboard-spec.md decisions 6/7).
 *
 * Two contracts:
 *  - pi/dashboard-daemon.mjs runs under PLAIN node (no pi, no jiti): spawning
 *    it as a subprocess proves the dashboard-server import chain stays free of
 *    pi runtime imports and that node's native type stripping handles the
 *    `.ts` imports. Bound to 127.0.0.1 via PI_AGENT_DASH_HOST — the suite
 *    must not open all-interface sockets.
 *  - agent-dash probes the daemon once per process: URL + hostname notify when
 *    /api/meta answers, install hint when nothing listens. (The PI_OFFLINE
 *    gate is covered in dashboard-server.test.ts.) The probe tests clear
 *    PI_OFFLINE around the handler call — safe because tests in one file run
 *    sequentially — and reset agent-dash's globalThis once-guard between runs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Keep everything (incl. transitive pi imports from agent-dash → child-session)
// away from the live ~/.pi/agent and off the network.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-daemon-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-daemon-sessions-"));
process.env.PI_OFFLINE = "1";

import * as agentDashModule from "../agent-dash.ts";
import type { MetaResponse, SessionsResponse } from "../lib/dashboard-api.ts";
import { startDashboardServer } from "../lib/dashboard-server.ts";
import { sleep } from "./harness.ts";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const DAEMON = path.resolve(TEST_DIR, "../../dashboard-daemon.mjs");
/** agent-dash's cross-copy once-guard (same literal key — bump both together). */
const STATE_KEY = Symbol.for("terminal-setup.agent-dash.v2");

function resetProbeGuard(): void {
	delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
}

function getJson<T>(port: number, rawPath: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				if (res.statusCode !== 200) return reject(new Error(`${rawPath} → ${res.statusCode}: ${body}`));
				resolve(JSON.parse(body) as T);
			});
		});
		req.on("error", reject);
		req.end();
	});
}

// --- the daemon entry under plain node ---------------------------------------

test("dashboard-daemon.mjs: plain node serves /api/meta and /api/sessions (pi-free import chain)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-daemon-root-"));
	const child = spawn(process.execPath, [DAEMON], {
		env: {
			...process.env,
			PI_AGENT_DASH_PORT: "0", // ephemeral — never squat 7357 from the suite
			PI_AGENT_DASH_HOST: "127.0.0.1",
			PI_AGENT_DASH_SESSIONS_ROOT: root,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	try {
		const deadline = Date.now() + 10_000;
		let port: number | null = null;
		while (Date.now() < deadline) {
			const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
			if (match) {
				port = Number(match[1]);
				break;
			}
			assert.equal(child.exitCode, null, `daemon exited early; stderr: ${stderr}`);
			await sleep(50);
		}
		assert.ok(port, `no startup line within 10s; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
		const meta = await getJson<MetaResponse>(port, "/api/meta");
		assert.equal(meta.hostname, hostname());
		assert.equal(meta.sessionsRoot, root, "daemon serves the env-selected sessions root");
		assert.equal(meta.pid, child.pid, "meta.pid is the daemon subprocess, not us");
		const sessions = await getJson<SessionsResponse>(port, "/api/sessions");
		assert.deepEqual(sessions.sessions, [], "empty root → empty list over the daemon");
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) return resolve();
			child.once("exit", () => resolve());
		});
	}
});

// --- agent-dash probe --------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => void;

function bindAgentDash(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const fakePi = { on: (name: string, handler: never) => void handlers.set(name, handler) };
	// This test dir is ESM but the extension is checked as CJS; unwrap the
	// interop default like explore.test.ts does.
	type DashFn = (pi: unknown) => void;
	const d = (agentDashModule as unknown as { default: DashFn | { default: DashFn } }).default;
	(typeof d === "function" ? d : d.default)(fakePi);
	return handlers;
}

function fakeCtx(notifications: string[]) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-daemon-probe-dir-"));
	const sessionFile = path.join(dir, "main.jsonl");
	writeFileSync(sessionFile, '{"type":"session"}\n');
	return {
		ui: { notify: (message: string) => void notifications.push(message) },
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => "probe-main",
			getSessionFile: () => sessionFile,
		},
	};
}

async function awaitNotification(notifications: string[]): Promise<string> {
	const deadline = Date.now() + 5000;
	while (notifications.length === 0 && Date.now() < deadline) await sleep(20);
	assert.ok(notifications.length > 0, "probe must notify within 5s");
	return notifications[0];
}

/** Run one probe against `port` with PI_OFFLINE lifted; restores env + guard. */
async function runProbe(port: number, notifications: string[], secondStart = false): Promise<void> {
	const handlers = bindAgentDash();
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_AGENT_DASH_PORT = String(port);
	delete process.env.PI_OFFLINE;
	resetProbeGuard();
	try {
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, fakeCtx(notifications));
		await awaitNotification(notifications);
		if (secondStart) {
			// /new, /resume etc. re-fire session_start — the probe must not repeat.
			handlers.get("session_start")!({ type: "session_start", reason: "new" }, fakeCtx(notifications));
			await sleep(150);
		}
	} finally {
		process.env.PI_OFFLINE = savedOffline;
		delete process.env.PI_AGENT_DASH_PORT;
		resetProbeGuard();
	}
}

test("agent-dash probe: daemon answering → URL + hostname notify, once per process", async () => {
	const result = await startDashboardServer({
		sessionsRoot: mkdtempSync(path.join(tmpdir(), "pi-daemon-probe-root-")),
		port: 0,
		host: "127.0.0.1",
	});
	assert.ok(result.started, "in-process daemon stand-in must bind");
	const notifications: string[] = [];
	try {
		await runProbe(result.server.port, notifications, true);
	} finally {
		await result.server.close();
	}
	assert.deepEqual(notifications, [
		`agent dashboard: http://localhost:${result.server.port}/ (host ${hostname()})`,
	]);
});

test("agent-dash probe: nothing listening → install hint", async () => {
	// Bind-then-close: a port that just proved free (nothing re-binds it in-test).
	const port = await new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const bound = (probe.address() as net.AddressInfo).port;
			probe.close(() => resolve(bound));
		});
	});
	const notifications: string[] = [];
	await runProbe(port, notifications);
	assert.deepEqual(notifications, ["agent dashboard daemon not running — re-run install-pi.sh to enable it"]);
});
