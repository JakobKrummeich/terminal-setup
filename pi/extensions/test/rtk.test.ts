/**
 * rtk.ts: which bash commands are handed to `rtk rewrite` at all, and — end to
 * end, through a real pi session and its real bash tool — what the extension
 * does with each `rtk rewrite` outcome. rtk.ts sits in front of EVERY bash call
 * of every session, so its fail-open contract is pinned here: only exit 0/3
 * with output rewrites; anything else (no equivalent, unknown exit, a hung rtk,
 * an rtk too old to have `rewrite`) runs the command unchanged.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRewriteCandidate } from "../rtk.ts";
import { createTestSession, textStep, toolStep } from "./harness.ts";

test("isRewriteCandidate: non-empty commands not already prefixed with rtk; RTK_DISABLED=1 disables", () => {
	const saved = process.env.RTK_DISABLED;
	try {
		delete process.env.RTK_DISABLED;
		assert.equal(isRewriteCandidate("git status"), true);
		assert.equal(isRewriteCandidate("rtkx ls"), true, "only the `rtk ` prefix counts");
		assert.equal(isRewriteCandidate("rtk git status"), false);
		assert.equal(isRewriteCandidate("   "), false);
		assert.equal(isRewriteCandidate(""), false);
		assert.equal(isRewriteCandidate(undefined), false);
		assert.equal(isRewriteCandidate(42), false);
		process.env.RTK_DISABLED = "0";
		assert.equal(isRewriteCandidate("ls"), true);
		process.env.RTK_DISABLED = "1";
		assert.equal(isRewriteCandidate("ls"), false);
	} finally {
		if (saved === undefined) delete process.env.RTK_DISABLED;
		else process.env.RTK_DISABLED = saved;
	}
});

// --- end to end: the `rtk rewrite` exit-code contract -------------------------

const RTK_EXTENSION = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../rtk.ts");

// A fake `rtk` first on PATH. Logs every call; `--version` reports
// $RTK_STUB_VERSION; `rewrite` answers by command. "slow" outlives rtk.ts's 2s
// rewrite timeout (exec: pi's SIGTERM must hit the process holding the pipe).
// pi.exec's un-unref'd 5s SIGKILL fallback keeps this file's process alive ~5s
// past its last test; harmless, the runner runs test files in parallel.
const RTK_STUB = `#!/bin/sh
echo "$*" >> "$RTK_STUB_LOG"
if [ "$1" = "--version" ]; then echo "rtk $RTK_STUB_VERSION"; exit 0; fi
case "$2" in
  "echo exit0") echo "echo REWRITTEN-0"; exit 0 ;;
  "echo exit3") echo "echo REWRITTEN-3"; exit 3 ;;
  "echo exit3-empty") exit 3 ;;
  "echo exit2") echo "echo MUST-NOT-RUN"; exit 2 ;;
  "echo slow") exec sleep 3 ;;
esac
exit 1
`;

/** Run `commands` through the bash tool with the stub rtk reporting `version`; bash outputs + stub calls. */
async function runWithStubRtk(version: string, commands: string[]): Promise<{ outputs: string[]; calls: string[] }> {
	const dir = mkdtempSync(path.join(tmpdir(), "rtk-stub-"));
	writeFileSync(path.join(dir, "rtk"), RTK_STUB, { mode: 0o755 });
	const log = path.join(dir, "calls.log");
	writeFileSync(log, "");
	const vars = { PATH: `${dir}:${process.env.PATH}`, RTK_STUB_LOG: log, RTK_STUB_VERSION: version };
	const saved = Object.fromEntries(["RTK_DISABLED", ...Object.keys(vars)].map((k) => [k, process.env[k]]));
	delete process.env.RTK_DISABLED;
	Object.assign(process.env, vars);
	try {
		const t = await createTestSession({
			extensionPaths: [RTK_EXTENSION], // loading it runs the `rtk --version` probe
			tools: ["bash"],
			llmDelayMs: 1,
			script: [...commands.map((command, i) => toolStep(`b${i}`, "bash", { command })), textStep("done")],
		});
		try {
			await t.session.prompt("run them");
			const outputs = (t.session.messages as Array<{ role: string; content?: Array<{ text?: string }> }>)
				.filter((m) => m.role === "toolResult")
				.map((m) => (m.content ?? []).map((c) => c.text ?? "").join("").trim());
			return { outputs, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
		} finally {
			t.dispose();
		}
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("rewrite contract: exit 0/3 with output rewrites; no equivalent, empty, unknown exit or a hung rtk pass through", async () => {
	const commands = ["echo exit0", "echo exit3", "echo plain", "echo exit3-empty", "echo exit2", "echo slow"];
	const { outputs, calls } = await runWithStubRtk("0.50.0", commands);
	assert.deepEqual(
		outputs,
		["REWRITTEN-0", "REWRITTEN-3", "plain", "exit3-empty", "exit2", "slow"],
		"exit 0 and 3 (advisory) run the rewrite; 1 (no equivalent), 3 without output, other exits and a timed-out rtk run the original",
	);
	assert.deepEqual(calls, ["--version", ...commands.map((c) => `rewrite ${c}`)], "one version probe at load, one rewrite per command");
});

test("rtk older than 0.23.0 (no `rtk rewrite`): extension disabled at load, commands run unchanged", async () => {
	const { outputs, calls } = await runWithStubRtk("0.22.9", ["echo exit0"]);
	assert.deepEqual(outputs, ["exit0"]);
	assert.deepEqual(calls, ["--version"], "no rewrite is ever attempted");
});
