#!/usr/bin/env node
/**
 * dashboard-daemon — machine-global agent-dashboard server entry
 * (docs/agent-dashboard-spec.md decisions 5–7; systemd user unit
 * pi/pi-dash.service, installed by install-pi.sh).
 *
 * Runs under PLAIN node — no pi, no jiti. That works because
 * lib/dashboard-server.ts and everything it imports uses only node:* modules
 * (pi imports are type-only) and node ≥22.18 strips TS types natively. Keep it
 * that way: a runtime pi import in that chain breaks this daemon.
 *
 * Env:
 *   PI_AGENT_DASH_PORT           port, default 7357 (0 = ephemeral, smoke tests)
 *   PI_AGENT_DASH_HOST           bind address, default 0.0.0.0
 *   PI_AGENT_DASH_SESSIONS_ROOT  default ~/.pi/agent/sessions
 *
 * A squatter on the port (e.g. an ssh -L tunnel bound to 7357) makes this exit
 * 1; the unit's Restart=on-failure + RestartSec=30 retries calmly — never
 * forward a remote dashboard onto your own daemon's port (README).
 */
import path from "node:path";
import { defaultSessionsRoot, startDashboardServer } from "./extensions/lib/dashboard-server.ts";

function envPort(raw) {
	// Unset/empty means default (repo convention: empty env var == unset) —
	// Number("") is 0, which would silently mean "ephemeral port" instead.
	if (raw === undefined || raw.trim() === "") return 7357;
	const port = Number(raw);
	return Number.isInteger(port) && port >= 0 ? port : 7357;
}

const port = envPort(process.env.PI_AGENT_DASH_PORT);
const host = process.env.PI_AGENT_DASH_HOST || "0.0.0.0";
const sessionsRoot = process.env.PI_AGENT_DASH_SESSIONS_ROOT || defaultSessionsRoot(process.env);
// UI resolved relative to this file: the daemon runs from the repo checkout,
// which needs no ~/.pi/agent/extensions symlink to serve its own static files.
const uiDir = path.join(import.meta.dirname, "extensions", "lib", "dashboard-ui");

const result = await startDashboardServer({ sessionsRoot, port, host, uiDir, keepProcessAlive: true });
if (!result.started) {
	console.error(`pi-dash: port ${port} on ${host} already in use — exiting (systemd retries in 30s)`);
	process.exit(1);
}
console.log(
	`pi-dash: serving ${sessionsRoot} at http://${host}:${result.server.port}/ (pid ${process.pid})`,
);
