/**
 * agent-dash — agent-dashboard extension: main-session index hook + daemon probe
 * (docs/agent-dashboard-spec.md).
 *
 * Two jobs, main session only:
 *  1. Write the main session's `session-start` rows into the per-project
 *     agent-runs.jsonl index (spawn/progress/finish come from
 *     lib/child-session.ts, reset from context-cap.ts).
 *  2. Probe the machine-global dashboard daemon (pi/dashboard-daemon.mjs,
 *     systemd user unit pi-dash.service) once per process and print its URL.
 *     pi itself NEVER serves the dashboard (spec decisions 6/7): the daemon
 *     owns port PI_AGENT_DASH_PORT (default 7357) machine-wide.
 *
 * The probe is SKIPPED when PI_OFFLINE or PI_AGENT_DASH_DISABLE is set: the
 * test suite exports PI_OFFLINE=1 (test/run.sh) and must not touch sockets;
 * PI_AGENT_DASH_DISABLE is the user-facing opt-out.
 */
import http from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./lib/agent-runs.ts";
import { inChildSession } from "./lib/child-session.ts";

const DEFAULT_PORT = 7357;
const PROBE_TIMEOUT_MS = 1000;

/**
 * Cross-copy once-guard. session_start fires again on /new, /resume, /fork and
 * extension reload — and a reload gives this file a fresh jiti module copy
 * (AGENTS.md), so the guard lives on globalThis. Bump the key when the shape
 * changes (v1 guarded a server start; v2 guards the daemon probe). One probe
 * per process is right: the daemon's presence doesn't change per session, and
 * repeating the URL notify on every /new would be noise.
 */
const STATE_KEY = Symbol.for("terminal-setup.agent-dash.v2");
type DashState = { probeAttempted: boolean };
const globals = globalThis as unknown as Record<symbol, DashState | undefined>;
function dashState(): DashState {
	return (globals[STATE_KEY] ??= { probeAttempted: false });
}

/** PI_AGENT_DASH_PORT, else 7357. Non-numeric/non-positive values fall back. */
function dashPort(env: NodeJS.ProcessEnv): number {
	const port = Number(env.PI_AGENT_DASH_PORT);
	return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

/**
 * GET /api/meta from the daemon on localhost; resolves the daemon's hostname,
 * or null when nothing (or something that isn't the daemon) answers within
 * ~1s. agent:false — no keep-alive client socket may outlive the probe
 * (AGENTS.md: lingering sockets hang the test suite).
 */
function probeDaemon(port: number): Promise<{ hostname: string } | null> {
	return new Promise((resolve) => {
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/api/meta", agent: false, timeout: PROBE_TIMEOUT_MS },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					if (res.statusCode !== 200) return resolve(null);
					try {
						const meta = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { hostname?: unknown };
						resolve(typeof meta.hostname === "string" ? { hostname: meta.hostname } : null);
					} catch {
						resolve(null); // squatter speaking non-JSON on our port
					}
				});
				res.on("error", () => resolve(null));
			},
		);
		req.on("timeout", () => req.destroy()); // destroy surfaces as 'error' below
		req.on("error", () => resolve(null));
	});
}

function maybeProbeDaemon(ctx: ExtensionContext): void {
	if (process.env.PI_OFFLINE || process.env.PI_AGENT_DASH_DISABLE) return;
	const state = dashState();
	if (state.probeAttempted) return;
	state.probeAttempted = true;
	const port = dashPort(process.env);
	void probeDaemon(port).then((meta) => {
		if (meta) ctx.ui.notify(`agent dashboard: http://localhost:${port}/ (host ${meta.hostname})`, "info");
		else ctx.ui.notify("agent dashboard daemon not running — re-run install-pi.sh to enable it", "warning");
	});
}

export default function agentDashExtension(pi: ExtensionAPI) {
	// Children are indexed by their spawn rows; a session-start row from a child
	// would register it as a second tree root. inChildSession() is only meaningful
	// during extension load/bind (ALS scope) — exactly where this code runs (same
	// pattern as subagent.ts).
	if (inChildSession()) return;

	// Fires on startup and again on /new, /resume, /fork and extension reload,
	// each time with the then-current sid — so every main session file gets a row.
	// Repeats for one sid (resume, reload) are deduped by readRuns; a row per
	// resume is deliberate anyway: its sessionFile keeps the index self-healing.
	pi.on("session_start", (_event, ctx) => {
		const manager = ctx.sessionManager;
		const dir = manager.getSessionDir();
		const sessionFile = manager.getSessionFile();
		if (sessionFile) {
			appendEvent(dir, {
				ts: Date.now(),
				event: "session-start",
				sid: manager.getSessionId(),
				sessionFile,
			});
		}
		maybeProbeDaemon(ctx);
	});
}
