/**
 * deriveSessions / deriveTree as pure functions: edge cases the HTTP-level
 * tests in dashboard-server.test.ts don't reach — root rows pruned (firstTs
 * fallback, no stats), first-wins intro rows, latest-wins finish rows
 * regardless of file order, resumed-then-settled children.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunEvent, RunFinish, RunSpawn } from "../lib/agent-runs.ts";
import { ACTIVE_WINDOW_MS, deriveSessions, deriveTree, type SessionFileStats, type TreeNode } from "../lib/dashboard-api.ts";
import { at } from "./assert-helpers.ts";

const PROJECT = { projectId: "--p--", project: "/p" };
const NOW = 10_000_000;
const OLD = NOW - 10 * ACTIVE_WINDOW_MS;

function spawn(sid: string, ts: number, overrides: Partial<RunSpawn> = {}): RunSpawn {
	return {
		ts,
		event: "spawn",
		sid,
		root: "root",
		parentSid: "root",
		kind: "agent",
		label: `agent#${sid}`,
		sessionFile: `/s/${sid}.jsonl`,
		description: `task ${sid}`,
		...overrides,
	};
}

function finish(sid: string, ts: number, overrides: Partial<RunFinish> = {}): RunFinish {
	return {
		ts,
		event: "finish",
		sid,
		status: "done",
		turns: 1,
		costUsd: 0.1,
		contextTokens: null,
		contextPercent: null,
		resets: 0,
		durationMs: 1,
		...overrides,
	};
}

const noStats = (): SessionFileStats | null => null;

function nodeBySid(nodes: TreeNode[], sid: string): TreeNode {
	const node = nodes.find((candidate) => candidate.sid === sid);
	assert.ok(node, `node ${sid}`);
	return node;
}

test("root rows pruned: startTs falls back to earliest tree ts; no stats → cost 0 row / null node, resets 0", () => {
	const events: AgentRunEvent[] = [spawn("a", OLD + 500), finish("a", OLD + 900, { costUsd: 0.25 })];
	const row = at(deriveSessions(events, NOW, noStats, PROJECT), 0);
	assert.equal(row.sid, "root");
	assert.equal(row.startTs, OLD + 500);
	assert.equal(row.running, false);
	assert.equal(row.durationMs, 400);
	assert.equal(row.costUsd, 0.25, "children's finish cost only");
	assert.equal(row.agentCount, 1);
	assert.equal(row.resetCount, 0);

	const tree = deriveTree(events, "root", NOW, noStats);
	assert.ok(tree);
	const root = at(tree.nodes, 0);
	assert.equal(root.sid, "root", "root node is synthesized first even without its own rows");
	assert.equal(root.startTs, OLD + 500);
	assert.equal(root.endTs, OLD + 900);
	assert.equal(root.status, "done");
	assert.equal(root.costUsd, null);
	assert.equal(root.turns, 0);
	assert.equal(root.resets, 0);
});

test("root stats: file mtime keeps the tree running; running duration runs to now; root resets counted", () => {
	const events: AgentRunEvent[] = [
		{ ts: OLD, event: "session-start", sid: "root", sessionFile: "/s/root.jsonl" },
		{ ts: OLD + 5, event: "session-start", sid: "root", sessionFile: "/s/other.jsonl" },
		{ ts: OLD + 10, event: "reset", sid: "root" },
	];
	const seen: string[] = [];
	const statsFor = (file: string): SessionFileStats => {
		seen.push(file);
		return { costUsd: 0.5, turns: 4, mtimeMs: NOW - 1000 };
	};
	const row = at(deriveSessions(events, NOW, statsFor, PROJECT), 0);
	assert.equal(row.running, true);
	assert.equal(row.durationMs, NOW - OLD);
	assert.equal(row.costUsd, 0.5);
	assert.equal(row.agentCount, 0);
	assert.equal(row.resetCount, 1);
	assert.deepEqual(seen, ["/s/root.jsonl"], "first session-start wins");

	const tree = deriveTree(events, "root", NOW, statsFor);
	assert.ok(tree);
	const root = at(tree.nodes, 0);
	assert.equal(root.status, "running");
	assert.equal(root.endTs, null);
	assert.equal(root.costUsd, 0.5);
	assert.equal(root.turns, 4);
	assert.equal(root.resets, 1);
});

test("child finish: latest ts wins regardless of file order; resumed then settled again → finish status", () => {
	const events: AgentRunEvent[] = [
		spawn("a", OLD),
		finish("a", OLD + 300, { status: "error", costUsd: 0.3, turns: 3 }),
		finish("a", OLD + 200, { costUsd: 0.2, turns: 2 }),
		spawn("b", OLD),
		finish("b", OLD + 100, { costUsd: 0.1 }),
		{ ts: OLD + 150, event: "progress", sid: "b", turn: 7 },
		finish("b", OLD + 400, { status: "cancelled", costUsd: 0.4, turns: 6 }),
		{ ts: OLD + 450, event: "reset", sid: "b" },
	];
	const tree = deriveTree(events, "root", NOW, noStats);
	assert.ok(tree);
	const a = nodeBySid(tree.nodes, "a");
	assert.equal(a.status, "error");
	assert.equal(a.endTs, OLD + 300);
	assert.equal(a.costUsd, 0.3);
	assert.equal(a.turns, 3);
	const b = nodeBySid(tree.nodes, "b");
	assert.equal(b.status, "cancelled", "a reset trailing the finish does not unsettle it");
	assert.equal(b.endTs, OLD + 400);
	assert.equal(b.turns, 7, "max of progress turn and finish turns");
	assert.equal(b.resets, 1);
	assert.equal(at(deriveSessions(events, NOW, noStats, PROJECT), 0).costUsd, 0.3 + 0.4);
});

test("unknown root → null tree; foreign sids (no intro row) are dropped", () => {
	const events: AgentRunEvent[] = [{ ts: OLD, event: "progress", sid: "stray", turn: 1 }];
	assert.equal(deriveTree(events, "root", NOW, noStats), null);
	assert.deepEqual(deriveSessions(events, NOW, noStats, PROJECT), []);
});
