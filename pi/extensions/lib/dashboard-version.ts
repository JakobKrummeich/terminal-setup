/**
 * dashboard-version — code hash of the dashboard daemon's server code, so a
 * pi session can tell whether the running daemon (pi-dash.service) predates
 * the checkout on disk.
 *
 * Why this exists: the daemon reads its static UI from disk per request but
 * loads its server JS once — after a `git pull` it keeps serving old server
 * code until someone restarts it. The daemon hashes its checkout once at
 * startup (served as /api/meta codeHash/codeRoot); agent-dash hashes its own
 * checkout on session_start and restarts the unit on a mismatch.
 *
 * Deliberately over-inclusive: pi/dashboard-daemon.mjs plus EVERY
 * .ts/.js/.mjs under pi/extensions/lib/ (not just the daemon's import
 * closure). A spurious restart is cheap; a missed one is the bug.
 *
 * Pi-free by contract: pi/dashboard-daemon.mjs imports this under plain node
 * (dependency-cruiser rule daemon-closure-no-pi).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface CodeVersion {
	/** Absolute, realpath'd repo root that was hashed. */
	root: string;
	/** sha256 hex (64 chars) over sorted relative paths + contents. */
	hash: string;
}

const DAEMON_ENTRY = "pi/dashboard-daemon.mjs";
const LIB_DIR = "pi/extensions/lib";
const HASHED_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js", ".mjs"]);

/** Repo-relative (posix) paths of every .ts/.js/.mjs under lib/, recursively. */
function libFiles(root: string): string[] {
	const entries = readdirSync(path.join(root, LIB_DIR), { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && HASHED_EXTENSIONS.has(path.extname(entry.name)))
		.map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/**
 * Hash the daemon code of the checkout at `repoRoot`. Throws when the root
 * holds no daemon (callers treat that as "version unknown").
 */
export function computeCodeVersion(repoRoot: string): CodeVersion {
	const root = realpathSync(repoRoot);
	const files = [DAEMON_ENTRY, ...libFiles(root)].sort();
	const hash = createHash("sha256");
	for (const rel of files) {
		const content = readFileSync(path.join(root, rel));
		// Length-prefixed so no path/content split can collide with another.
		hash.update(`${rel}\0${content.length}\0`);
		hash.update(content);
	}
	return { root, hash: hash.digest("hex") };
}
