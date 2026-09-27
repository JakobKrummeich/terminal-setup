import os from "node:os";
import path from "node:path";

/**
 * pi's agent config dir (~/.pi/agent), honoring PI_CODING_AGENT_DIR like pi's
 * own getAgentDir. Re-implemented rather than imported: the dashboard daemon
 * loads lib/dashboard-server.ts outside pi (pi/dashboard-daemon.mjs), so this
 * module must stay free of pi imports.
 *
 * `||` not `??`: pi treats an empty env var as unset. Known difference: pi also
 * expands a leading `~` / `file://` in the env value; this does not (a shell
 * expands `~` before pi or we ever see it).
 *
 * Read at call time, never cached: tests point PI_CODING_AGENT_DIR at a temp dir.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/**
 * Where context-cap.ts writes handoff documents: <agent dir>/context-cap, next to
 * the sessions they belong to. Lives here, not in context-cap.ts, so tests can
 * import it without loading the extension (its env levers resolve at import).
 */
export function contextCapDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), "context-cap");
}
