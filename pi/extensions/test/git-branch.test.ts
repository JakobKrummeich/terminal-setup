/**
 * gitBranch (lib/git-branch.ts): the branch shown in the F2 child footer. That
 * footer mirrors the main one (custom-footer.ts), whose branch comes from pi's
 * own lookup (core/footer-data-provider.js findGitPaths) — so the two must find
 * the same repo: walk up from cwd, and resolve a relative `gitdir:` pointer
 * (submodules, relative worktrees) against the .git file's dir, never against
 * process.cwd().
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitBranch } from "../lib/git-branch.ts";

/** A fresh dir holding `<gitDir>/HEAD` with `head` as its content. */
function repoWithHead(head: string): { root: string; gitDir: string } {
	const root = mkdtempSync(path.join(tmpdir(), "pi-gitbranch-"));
	const gitDir = path.join(root, ".git");
	mkdirSync(gitDir);
	writeFileSync(path.join(gitDir, "HEAD"), `${head}\n`);
	return { root, gitDir };
}

test("gitBranch: plain repo → branch name; detached HEAD → short sha", () => {
	assert.equal(gitBranch(repoWithHead("ref: refs/heads/feature/x").root), "feature/x");
	assert.equal(gitBranch(repoWithHead("0123456789abcdef0123456789abcdef01234567").root), "0123456");
});

test("gitBranch: no repo anywhere above cwd → null", () => {
	assert.equal(gitBranch(mkdtempSync(path.join(tmpdir(), "pi-gitbranch-none-"))), null);
});

test("gitBranch: cwd below the repo root walks up like pi's main footer", () => {
	const { root } = repoWithHead("ref: refs/heads/main");
	const sub = path.join(root, "pi", "extensions");
	mkdirSync(sub, { recursive: true });
	assert.equal(gitBranch(sub), "main");
});

test("gitBranch: absolute gitdir pointer (default `git worktree add`)", () => {
	const { gitDir } = repoWithHead("ref: refs/heads/wt");
	const worktree = mkdtempSync(path.join(tmpdir(), "pi-gitbranch-wt-"));
	writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	assert.equal(gitBranch(worktree), "wt");
});

test("gitBranch: relative gitdir pointer resolves against the .git file's dir, not process.cwd()", () => {
	// Submodule layout: <super>/.git/modules/sub holds the git dir, <super>/sub/.git points at it.
	const { root } = repoWithHead("ref: refs/heads/main");
	const moduleDir = path.join(root, ".git", "modules", "sub");
	mkdirSync(moduleDir, { recursive: true });
	writeFileSync(path.join(moduleDir, "HEAD"), "ref: refs/heads/sub-branch\n");
	const sub = path.join(root, "sub");
	mkdirSync(sub);
	writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
	assert.notEqual(process.cwd(), root, "test must not pass by accident of the process cwd");
	assert.equal(gitBranch(sub), "sub-branch");
});
