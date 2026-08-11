/**
 * agent-dash — agent-dashboard extension: main-session index hook + HTTP server
 * (docs/agent-dashboard-spec.md).
 *
 * Two jobs, main session only:
 *  1. Write the main session's `session-start` rows into the per-project
 *     agent-runs.jsonl index (spawn/progress/finish come from
 *     lib/child-session.ts, reset from context-cap.ts).
 *  2. Auto-start the dashboard HTTP server (lib/dashboard-server.ts) —
 *     0.0.0.0, port PI_AGENT_DASH_PORT or 7357. One server per port per
 *     machine: when another pi instance already bound it (EADDRINUSE), we only
 *     print the URL (spec decision 7 — any instance serves the whole project).
 *
 * Auto-start is SKIPPED when PI_OFFLINE or PI_AGENT_DASH_DISABLE is set:
 * the test suite exports PI_OFFLINE=1 (test/run.sh) and must never spawn
 * listening sockets; PI_AGENT_DASH_DISABLE is the user-facing opt-out.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./lib/agent-runs.ts";
import { inChildSession } from "./lib/child-session.ts";
import { startDashboardServer } from "./lib/dashboard-server.ts";

const DEFAULT_PORT = 7357;

/**
 * Cross-copy once-guard. session_start fires again on /new, /resume, /fork and
 * extension reload — and a reload gives this file a fresh jiti module copy
 * (AGENTS.md), so the guard lives on globalThis. Bump the key when the shape
 * changes. A reload's orphaned server keeps serving correct data (it is a
 * stateless disk reader), so "started once ever" is the right semantics.
 */
const STATE_KEY = Symbol.for("terminal-setup.agent-dash.v1");
type DashState = { startAttempted: boolean };
const globals = globalThis as unknown as Record<symbol, DashState | undefined>;
function dashState(): DashState {
	return (globals[STATE_KEY] ??= { startAttempted: false });
}

/** PI_AGENT_DASH_PORT, else 7357. Non-numeric/non-positive values fall back. */
function dashPort(env: NodeJS.ProcessEnv): number {
	const port = Number(env.PI_AGENT_DASH_PORT);
	return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function maybeStartServer(ctx: ExtensionContext, dir: string): void {
	if (process.env.PI_OFFLINE || process.env.PI_AGENT_DASH_DISABLE) return;
	if (!dir) return; // in-memory session: no project dir to serve
	const state = dashState();
	if (state.startAttempted) return;
	state.startAttempted = true;
	const port = dashPort(process.env);
	startDashboardServer({ dir, port })
		.then((result) => {
			const url = `http://localhost:${result.started ? result.server.port : port}/`;
			if (result.started) ctx.ui.notify(`agent dashboard: ${url}`, "info");
			else ctx.ui.notify(`agent dashboard: port ${port} in use (another pi instance?) — dashboard may be at ${url}`, "info");
		})
		.catch((error) => {
			ctx.ui.notify(`agent dashboard failed to start: ${String(error)}`, "warning");
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
		maybeStartServer(ctx, dir);
	});
}
