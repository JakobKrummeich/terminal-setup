/**
 * lib/agent-dir.ts: the one resolver of pi's agent dir outside pi (env.ts,
 * explore.ts, dashboard-server.ts, context-cap.ts). Must match pi's getAgentDir
 * for the env override and resolve per call — context-cap's handoff files used
 * to ignore PI_CODING_AGENT_DIR and land in the real home dir.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agentDir, contextCapDir } from "../lib/agent-dir.ts";

const HOME_AGENT_DIR = path.join(homedir(), ".pi", "agent");

test("agentDir: PI_CODING_AGENT_DIR wins; unset or empty falls back to ~/.pi/agent", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent");
	assert.equal(agentDir({}), HOME_AGENT_DIR);
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "" }), HOME_AGENT_DIR, "empty counts as unset, as in pi");
});

test("contextCapDir follows the agent dir override", () => {
	assert.equal(contextCapDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/context-cap");
	assert.equal(contextCapDir({}), path.join(HOME_AGENT_DIR, "context-cap"));
});

test("defaults read process.env at call time, not at import", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-a";
		assert.equal(contextCapDir(), "/tmp/agent-a/context-cap");
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-b";
		assert.equal(agentDir(), "/tmp/agent-b");
		assert.equal(contextCapDir(), "/tmp/agent-b/context-cap");
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});
