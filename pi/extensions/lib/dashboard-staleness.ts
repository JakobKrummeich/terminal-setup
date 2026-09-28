/**
 * dashboard-staleness — does the running dashboard daemon serve THIS
 * checkout's code? Used by agent-dash after a successful /api/meta probe; on
 * "stale" it restarts the systemd unit (lib/dashboard-version.ts has the why).
 *
 * Verdicts:
 *  - unknown: this pi's own checkout can't be located or hashed → do nothing.
 *  - foreign: the daemon runs on another host (e.g. a stray `ssh -L` tunnel on
 *    the port) or from another checkout → never restart it (the unit belongs
 *    to whoever installed it); agent-dash only mentions it.
 *  - stale:   this host, same checkout (or a daemon too old to report
 *    codeRoot) and the hash differs or is missing → `systemctl --user try-restart`.
 *  - current: nothing to do.
 *
 * Known gap: try-restart is a no-op when pi-dash.service is inactive (a daemon
 * started by hand); that still reports "restarted". Accepted — the unit is the
 * only supported way to run the daemon (install-pi.sh).
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDir } from "./agent-dir.ts";
import { type CodeVersion, computeCodeVersion } from "./dashboard-version.ts";

/** The identity part of /api/meta (MetaResponse). codeHash/codeRoot absent on old daemons. */
export interface DaemonCode {
	hostname: string;
	codeHash?: string;
	codeRoot?: string;
}

export type Staleness =
	| { kind: "unknown" }
	| { kind: "foreign"; where: string }
	| { kind: "stale" }
	| { kind: "current" };

const RESTART_TIMEOUT_MS = 10_000;

/**
 * Code version of the checkout this pi loads its extensions from. Located via
 * the agent dir (<agent dir>/extensions/agent-dash.ts → realpath → three dirs
 * up), not import.meta: tsc checks extensions as CJS (explore.ts has the
 * trap). Resolving the FILE, not the dir, works whether install linked the
 * extensions dir or single files. Null when that isn't a repo checkout.
 */
export function ownCheckoutVersion(env: NodeJS.ProcessEnv = process.env): CodeVersion | null {
	try {
		const entry = realpathSync(path.join(agentDir(env), "extensions", "agent-dash.ts"));
		return computeCodeVersion(path.dirname(path.dirname(path.dirname(entry))));
	} catch {
		return null; // no symlinked checkout (or it lacks the daemon): can't judge
	}
}

function realpathOr(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir; // daemon's checkout gone from disk: compare verbatim (it's foreign then)
	}
}

export function assessDaemon(daemon: DaemonCode, own: CodeVersion | null): Staleness {
	if (!own) return { kind: "unknown" };
	if (daemon.hostname !== os.hostname()) {
		return { kind: "foreign", where: `host ${daemon.hostname}` };
	}
	// Missing codeRoot = daemon predates the field; the unit is the only daemon
	// install, so assume it's ours (and, lacking codeHash too, stale).
	if (daemon.codeRoot !== undefined && realpathOr(daemon.codeRoot) !== own.root) {
		return { kind: "foreign", where: daemon.codeRoot };
	}
	return daemon.codeHash === own.hash ? { kind: "current" } : { kind: "stale" };
}

/**
 * `systemctl --user try-restart pi-dash.service` (try-: never starts a unit
 * the user stopped). Resolves null on success, else a one-line reason; never
 * rejects. PI_AGENT_DASH_SYSTEMCTL overrides the binary — WHY an env var: the
 * test suite must never restart the user's real daemon, and an env var reaches
 * every jiti module copy of this file (a module-level setter would not).
 */
export function restartDaemonUnit(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const systemctl = env.PI_AGENT_DASH_SYSTEMCTL || "systemctl";
	return new Promise((resolve) => {
		execFile(
			systemctl,
			["--user", "try-restart", "pi-dash.service"],
			{ timeout: RESTART_TIMEOUT_MS },
			(error, _stdout, stderr) => {
				if (!error) return resolve(null);
				resolve(String(stderr).trim().split("\n")[0] || error.message);
			},
		);
	});
}
