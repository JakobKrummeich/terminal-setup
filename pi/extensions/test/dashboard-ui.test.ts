/**
 * dashboard-ui — phase 3 browser UI (lib/dashboard-ui/).
 *
 * Two layers, no DOM faked:
 *  - gantt-layout.js is pure math (bar %, ticks, tree rows, formatting) and is
 *    imported directly. It is plain browser JS outside tsconfig (allowJs off),
 *    so the import uses a computed file URL — tsc types the result as any.
 *  - server smoke: the real dashboard server serves the real UI files with the
 *    right content types; index.html wires app.js, app.js imports gantt-layout.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep anything env-sensitive away from the live ~/.pi/agent (suite convention).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-dashui-agentdir-"));
process.env.PI_OFFLINE = "1";

import { startDashboardServer } from "../lib/dashboard-server.ts";

const UI_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../lib/dashboard-ui");

// Browser module, deliberately outside tsconfig — computed specifier keeps tsc away.
const gantt = await import(pathToFileURL(path.join(UI_DIR, "gantt-layout.js")).href);
const { barGeometry, computeTicks, formatCost, formatDuration, formatTick, orderTreeRows, timeRange } = gantt;

function assertClose(actual: number, expected: number, what: string): void {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} !== ${expected}`);
}

function barNode(sid: string, startTs: number, endTs: number | null, parentSid: string | null = null) {
	return { sid, parentSid, startTs, endTs, label: sid, kind: "agent", status: "done", costUsd: 0, resets: 0, turns: 0 };
}

// --- gantt-layout: bar math --------------------------------------------------

test("gantt-layout: barGeometry maps start/end to % of the tree range", () => {
	const nodes = [barNode("root", 1000, 5000), barNode("child", 2000, 3000, "root")];
	const range = timeRange(nodes, 99_999);
	assert.equal(range.minTs, 1000);
	assert.equal(range.maxTs, 5000, "all bars closed: `now` must not stretch the range");
	assert.equal(range.span, 4000);
	const child = barGeometry(nodes[1], range, 99_999);
	assertClose(child.leftPct, 25, "child left");
	assertClose(child.widthPct, 25, "child width");
	const root = barGeometry(nodes[0], range, 99_999);
	assertClose(root.leftPct, 0, "root left");
	assertClose(root.widthPct, 100, "root width");
});

test("gantt-layout: endTs null = running — bar grows with `now`, and extends the range", () => {
	const running = barNode("run", 2000, null, "root");
	const nodes = [barNode("root", 1000, 5000), running];
	const early = timeRange(nodes, 5000);
	assertClose(barGeometry(running, early, 5000).widthPct, 75, "running bar to now=5000");
	const late = timeRange(nodes, 9000);
	assert.equal(late.maxTs, 9000, "running bar pushes maxTs to now");
	assert.equal(late.span, 8000);
	const geo = barGeometry(running, late, 9000);
	assertClose(geo.leftPct, 12.5, "left within the wider range");
	assertClose(geo.widthPct, 87.5, "grew relative to now=9000");
});

test("gantt-layout: degenerate single-instant tree stays finite and visible", () => {
	const instant = barNode("only", 1000, 1000);
	const range = timeRange([instant], 1000);
	assert.equal(range.span, 1, "span floor prevents division by zero");
	const geo = barGeometry(instant, range, 1000);
	assert.ok(Number.isFinite(geo.leftPct) && Number.isFinite(geo.widthPct), "no NaN/Infinity");
	assert.equal(geo.leftPct, 0);
	assert.ok(geo.widthPct >= 0.4, "zero-duration bar keeps the visibility floor");
	assert.deepEqual(timeRange([], 777), { minTs: 777, maxTs: 777, span: 1 }, "empty tree collapses to now");
});

// --- gantt-layout: ticks -----------------------------------------------------

test("gantt-layout: computeTicks picks a round step and epoch-aligned offsets", () => {
	// 60s span → 15s step (60/5s = 12 > 10 ticks; 60/15s = 4 ≤ 10).
	const aligned = computeTicks(0, 60_000);
	assert.equal(aligned.stepMs, 15_000);
	assert.deepEqual(
		aligned.ticks.map((t: { ts: number }) => t.ts),
		[0, 15_000, 30_000, 45_000, 60_000],
	);
	assert.deepEqual(
		aligned.ticks.map((t: { leftPct: number }) => t.leftPct),
		[0, 25, 50, 75, 100],
	);
	// Unaligned start: first tick rounds UP to the next step multiple.
	const offset = computeTicks(1234, 61_234);
	assert.equal(offset.stepMs, 15_000);
	assert.equal(offset.ticks[0].ts, 15_000, "ceil to the next multiple of the step");
	assertClose(offset.ticks[0].leftPct, ((15_000 - 1234) / 60_000) * 100, "offset in %");
	// Degenerate instant span: zero ticks is legal, never an error.
	assert.deepEqual(computeTicks(500, 500).ticks, []);
	// Multi-day spans cap the tick count instead of flooding the axis.
	assert.ok(computeTicks(0, 30 * 86_400_000).ticks.length <= 12);
});

// --- gantt-layout: tree rows -------------------------------------------------

test("gantt-layout: orderTreeRows walks depth-first with depths; collapse hides subtrees; orphans reattach to root", () => {
	const nodes = [
		barNode("root", 0, 100),
		barNode("a1", 10, 50, "root"),
		barNode("e1", 20, 30, "a1"),
		barNode("a2", 40, 90, "root"),
		barNode("orphan", 60, 70, "gone-parent"), // parent's rows pruned from the index
	];
	const rows = orderTreeRows(nodes, new Set());
	assert.deepEqual(
		rows.map((r: { node: { sid: string }; depth: number }) => [r.node.sid, r.depth]),
		[["root", 0], ["a1", 1], ["e1", 2], ["a2", 1], ["orphan", 1]],
		"DFS order: children grouped under parents, orphan under root",
	);
	assert.equal(rows[1].childCount, 1, "a1 has one explorer");
	const collapsed = orderTreeRows(nodes, new Set(["a1"]));
	assert.deepEqual(
		collapsed.map((r: { node: { sid: string } }) => r.node.sid),
		["root", "a1", "a2", "orphan"],
		"collapsing a1 keeps its row, drops e1",
	);
	assert.equal(collapsed[1].collapsed, true);
	assert.deepEqual(orderTreeRows([], new Set()), []);
	// Mutual parentSid cycle (corrupt index): unreachable from the root walk, but
	// both rows must still be emitted — appended at depth 1 (partner nests below).
	const cyclic = [
		barNode("root", 0, 100),
		barNode("cycle-a", 10, 20, "cycle-b"),
		barNode("cycle-b", 10, 20, "cycle-a"),
	];
	assert.deepEqual(
		orderTreeRows(cyclic, new Set()).map((r: { node: { sid: string }; depth: number }) => [r.node.sid, r.depth]),
		[["root", 0], ["cycle-a", 1], ["cycle-b", 2]],
		"A↔B cycle: both rows survive, no infinite walk",
	);
});

// --- gantt-layout: formatting ------------------------------------------------

test("gantt-layout: formatters — cost null → '—', durations, tick labels", () => {
	assert.equal(formatCost(null), "—", "unknown cost renders as em dash");
	assert.equal(formatCost(undefined), "—");
	assert.equal(formatCost(0.42), "$0.42");
	assert.equal(formatCost(1.5), "$1.50");
	assert.equal(formatCost(0.0123), "$0.012", "sub-10¢ costs get 3 decimals");
	assert.equal(formatDuration(12_000), "12s");
	assert.equal(formatDuration(245_000), "4m 05s");
	assert.equal(formatDuration(3_720_000), "1h 02m");
	assert.equal(formatDuration(-5), "0s", "negative clamps to zero");
	// Tick labels honor the step granularity (local-time; noon avoids TZ day edges).
	const noon = new Date(2026, 0, 2, 12, 34, 56).getTime();
	assert.equal(formatTick(noon, 1_000), "12:34:56");
	assert.equal(formatTick(noon, 60_000), "12:34");
	assert.equal(formatTick(noon, 86_400_000), "2026-01-02");
});

// --- server smoke: the real UI is served -------------------------------------

function get(port: number, rawPath: string): Promise<{ status: number; contentType: string; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					contentType: String(res.headers["content-type"] ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

test("dashboard-ui: server serves shell + assets with correct content types; wiring is intact", async () => {
	const result = await startDashboardServer({
		dir: mkdtempSync(path.join(tmpdir(), "pi-dashui-project-")),
		port: 0,
		host: "127.0.0.1",
		uiDir: UI_DIR,
	});
	assert.ok(result.started, "server must bind an ephemeral port");
	try {
		const assets: [string, RegExp][] = [
			["/", /text\/html/],
			["/app.js", /text\/javascript/],
			["/gantt-layout.js", /text\/javascript/],
			["/style.css", /text\/css/],
		];
		for (const [rawPath, typePattern] of assets) {
			const res = await get(result.server.port, rawPath);
			assert.equal(res.status, 200, `${rawPath} must be served`);
			assert.match(res.contentType, typePattern, `${rawPath} content-type`);
			assert.ok(res.body.length > 100, `${rawPath} must not be empty`);
		}
		const shell = await get(result.server.port, "/");
		assert.match(shell.body, /<script type="module" src="\/app\.js">/, "shell loads the SPA entry as a module");
		const appJs = readFileSync(path.join(UI_DIR, "app.js"), "utf8");
		assert.match(appJs, /from "\.\/gantt-layout\.js"/, "app.js imports the pure layout module");
		for (const route of ["#/view/", "#/session/"]) {
			assert.ok(appJs.includes(route), `route table keeps literal prefix ${route}`);
		}
	} finally {
		await result.server.close();
	}
});
