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
 *  - stale-code restart: /api/meta reports the daemon's codeHash/codeRoot;
 *    agent-dash restarts the unit (PI_AGENT_DASH_SYSTEMCTL → a stub script
 *    that logs its argv, set for the WHOLE file so no test can ever reach the
 *    real systemctl) iff the daemon runs other code from this same checkout.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const STUB_DIR = mkdtempSync(path.join(tmpdir(), "pi-daemon-systemctl-"));
const SYSTEMCTL_LOG = path.join(STUB_DIR, "calls.log");
const SYSTEMCTL_STUB = path.join(STUB_DIR, "systemctl");
// Logs argv; STUB_SYSTEMCTL_FAIL=1 makes it fail like a missing user bus.
writeFileSync(
	SYSTEMCTL_STUB,
	`#!/bin/sh\necho "$*" >> '${SYSTEMCTL_LOG}'\n` +
		`if [ -n "$STUB_SYSTEMCTL_FAIL" ]; then echo 'Failed to connect to bus: No medium found' >&2; exit 1; fi\n`,
);
chmodSync(SYSTEMCTL_STUB, 0o755);
process.env.PI_AGENT_DASH_SYSTEMCTL = SYSTEMCTL_STUB;

import * as agentDashModule from "../agent-dash.ts";
import type { MetaResponse, SessionsResponse } from "../lib/dashboard-api.ts";
import { startDashboardServer } from "../lib/dashboard-server.ts";
import { type CodeVersion, computeCodeVersion } from "../lib/dashboard-version.ts";
import { sleep } from "./harness.ts";
import { at } from "./assert-helpers.ts";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const DAEMON = path.resolve(TEST_DIR, "../../dashboard-daemon.mjs");
const REPO_ROOT = realpathSync(path.resolve(TEST_DIR, "../../.."));
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
		assert.match(meta.codeHash ?? "", /^[0-9a-f]{64}$/, "codeHash is a sha256 hex digest");
		assert.equal(meta.codeRoot, REPO_ROOT, "codeRoot is the daemon's own checkout");
		assert.equal(meta.codeHash, computeCodeVersion(REPO_ROOT).hash, "same code on disk → same hash");
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

async function awaitNotifications(notifications: string[], count: number): Promise<string> {
	const deadline = Date.now() + 5000;
	while (notifications.length < count && Date.now() < deadline) await sleep(20);
	assert.ok(notifications.length >= count, `probe must notify ${count}x within 5s; got ${JSON.stringify(notifications)}`);
	return at(notifications, 0);
}

/** Run one probe against `port` with PI_OFFLINE lifted; restores env + guard. */
async function runProbe(port: number, notifications: string[], secondStart = false, expected = 1): Promise<void> {
	const handlers = bindAgentDash();
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_AGENT_DASH_PORT = String(port);
	delete process.env.PI_OFFLINE;
	resetProbeGuard();
	try {
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, fakeCtx(notifications));
		await awaitNotifications(notifications, expected);
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

// --- stale-code restart ------------------------------------------------------

function systemctlCalls(): string[] {
	return existsSync(SYSTEMCTL_LOG) ? readFileSync(SYSTEMCTL_LOG, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * Probe an in-process daemon stand-in serving `codeVersion`, with the agent
 * dir's extensions/ linked to this checkout (how install-pi.sh links it) so
 * agent-dash can hash "its own" code. Returns notifications + systemctl calls.
 */
async function probeWithCode(
	codeVersion: CodeVersion | undefined,
	expected: number,
): Promise<{ port: number; notifications: string[]; calls: string[] }> {
	const link = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions");
	symlinkSync(path.join(REPO_ROOT, "pi", "extensions"), link);
	rmSync(SYSTEMCTL_LOG, { force: true });
	const result = await startDashboardServer({
		sessionsRoot: mkdtempSync(path.join(tmpdir(), "pi-daemon-stale-root-")),
		port: 0,
		host: "127.0.0.1",
		codeVersion,
	});
	assert.ok(result.started, "in-process daemon stand-in must bind");
	const notifications: string[] = [];
	try {
		await runProbe(result.server.port, notifications, false, expected);
		await sleep(200); // a wrongly-fired restart would land in the log by now
	} finally {
		await result.server.close();
		rmSync(link);
	}
	return { port: result.server.port, notifications, calls: systemctlCalls() };
}

const RESTART_CALL = "--user try-restart pi-dash.service";

test("agent-dash stale check: same checkout, different hash → try-restart once", async () => {
	const { port, notifications, calls } = await probeWithCode({ root: REPO_ROOT, hash: "0".repeat(64) }, 2);
	assert.deepEqual(calls, [RESTART_CALL]);
	assert.deepEqual(notifications, [
		`agent dashboard: http://localhost:${port}/ (host ${hostname()})`,
		"dashboard daemon was running stale code — restarted",
	]);
});

test("agent-dash stale check: old daemon without codeHash/codeRoot counts as stale", async () => {
	const { notifications, calls } = await probeWithCode(undefined, 2);
	assert.deepEqual(calls, [RESTART_CALL]);
	assert.equal(at(notifications, 1), "dashboard daemon was running stale code — restarted");
});

test("agent-dash stale check: failed restart → warning with reason + install hint", async () => {
	process.env.STUB_SYSTEMCTL_FAIL = "1";
	try {
		const { notifications, calls } = await probeWithCode({ root: REPO_ROOT, hash: "0".repeat(64) }, 2);
		assert.deepEqual(calls, [RESTART_CALL]);
		assert.equal(
			at(notifications, 1),
			"dashboard daemon was running stale code; restart failed: Failed to connect to bus: No medium found — re-run install-pi.sh",
		);
	} finally {
		delete process.env.STUB_SYSTEMCTL_FAIL;
	}
});

test("agent-dash stale check: matching hash → no restart", async () => {
	const { port, notifications, calls } = await probeWithCode(computeCodeVersion(REPO_ROOT), 1);
	assert.deepEqual(calls, []);
	assert.deepEqual(notifications, [`agent dashboard: http://localhost:${port}/ (host ${hostname()})`]);
});

test("agent-dash stale check: daemon from another checkout → no restart, noted in the URL notify", async () => {
	const foreign = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-daemon-foreign-checkout-")));
	const { port, notifications, calls } = await probeWithCode({ root: foreign, hash: "0".repeat(64) }, 1);
	assert.deepEqual(calls, []);
	assert.deepEqual(notifications, [
		`agent dashboard: http://localhost:${port}/ (host ${hostname()}; daemon runs code from ${foreign}, not this checkout)`,
	]);
});
