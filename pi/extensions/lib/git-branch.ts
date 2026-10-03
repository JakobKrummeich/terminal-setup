// Git branch for the F2 child footer (lib/child-watch.ts). Sync fs reads only — no
// git subprocess; the caller resolves it once per watch open, not per frame.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Branch for the child footer. Finds the repo the way pi's own footer does
 * (core/footer-data-provider.js findGitPaths) so F2 and the main footer agree:
 * nearest .git walking up from cwd. Detached HEAD shows the short sha.
 */
export function gitBranch(cwd: string): string | null {
	const gitDir = findGitDir(cwd);
	if (!gitDir) return null;
	try {
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		return match?.[1] ?? head.slice(0, 7);
	} catch {
		return null;
	}
}

/** Git dir of the nearest repo at or above cwd: `.git` itself, or what its `gitdir:` pointer names. */
function findGitDir(cwd: string): string | null {
	let dir = resolve(cwd);
	while (!existsSync(join(dir, ".git"))) {
		if (dirname(dir) === dir) return null;
		dir = dirname(dir);
	}
	return gitDirPointer(dir) ?? join(dir, ".git");
}

/** Target of a `.git` FILE (worktree/submodule); undefined when .git is a directory. */
function gitDirPointer(dir: string): string | undefined {
	try {
		const pointer = readFileSync(join(dir, ".git"), "utf8").match(/^gitdir: (.+)$/m);
		// Relative pointers (submodules, relative worktrees) are relative to the .git
		// file's dir — resolving against process.cwd() reads the wrong HEAD.
		return pointer?.[1] ? resolve(dir, pointer[1].trim()) : undefined;
	} catch {
		return undefined;
	}
}
