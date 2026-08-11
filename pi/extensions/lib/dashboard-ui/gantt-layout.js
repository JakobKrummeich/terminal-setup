/**
 * gantt-layout — pure layout/format math for the dashboard UI.
 *
 * No DOM, no fetch, no Date.now(): every function is (data, now?) → data, so
 * node tests (test/dashboard-ui.test.ts) import this file directly. app.js is
 * the only other consumer. Shapes mirror lib/dashboard-api.ts (TreeNode).
 */

/** @typedef {{ sid: string, parentSid: string | null, startTs: number, endTs: number | null }} BarNode */

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

/**
 * Time window of a tree: min startTs → max endTs, open bars (endTs null)
 * extend to `now`. span is never 0 so percentage math stays finite even for a
 * single-instant tree.
 */
export function timeRange(nodes, now) {
	let minTs = Infinity;
	let maxTs = -Infinity;
	for (const node of nodes) {
		minTs = Math.min(minTs, node.startTs);
		maxTs = Math.max(maxTs, node.endTs ?? now, node.startTs);
	}
	if (!Number.isFinite(minTs)) {
		minTs = now;
		maxTs = now;
	}
	return { minTs, maxTs, span: Math.max(1, maxTs - minTs) };
}

/**
 * Bar position/size as percentages of the range. Running bars (endTs null)
 * end at `now`. Width has a 0.4% floor so zero-duration bars stay visible;
 * left is capped so the floor still fits inside 100%.
 */
export function barGeometry(node, range, now) {
	const start = Math.max(node.startTs, range.minTs);
	const end = Math.max(node.endTs ?? now, start);
	const leftPct = clamp(((start - range.minTs) / range.span) * 100, 0, 99.6);
	const rawWidthPct = ((end - start) / range.span) * 100;
	return { leftPct, widthPct: clamp(rawWidthPct, 0.4, 100 - leftPct) };
}

/** Round tick intervals, smallest first: 1s … 1d. */
const TICK_STEPS_MS = [
	1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
	86_400_000,
];

/**
 * Axis ticks: smallest round step giving ≤10 ticks, placed at epoch multiples
 * of the step (so labels land on :00/:15/... clock times), capped at 12 for
 * multi-day spans. A sub-second span may yield zero ticks — fine.
 */
export function computeTicks(minTs, maxTs) {
	const span = Math.max(1, maxTs - minTs);
	const stepMs = TICK_STEPS_MS.find((step) => span / step <= 10) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
	const ticks = [];
	for (let ts = Math.ceil(minTs / stepMs) * stepMs; ts <= maxTs && ticks.length < 12; ts += stepMs) {
		ticks.push({ ts, leftPct: ((ts - minTs) / span) * 100 });
	}
	return { stepMs, ticks };
}

/**
 * Flatten /api/tree nodes into display rows: depth-first from the root
 * (nodes[0]), children in index order, depth = parent-chain length. Collapsed
 * sids keep their row but drop their subtree. No node ever disappears:
 * orphans (parentSid unknown or self-referential) reattach under the root, and
 * parentSid cycles (corrupt index) that the root walk can't reach are appended
 * at depth 1.
 */
export function orderTreeRows(nodes, collapsed = new Set()) {
	if (nodes.length === 0) return [];
	const sids = new Set(nodes.map((node) => node.sid));
	const rootSid = nodes[0].sid;
	const children = new Map();
	for (const node of nodes.slice(1)) {
		const parent = node.parentSid !== null && node.parentSid !== node.sid && sids.has(node.parentSid)
			? node.parentSid
			: rootSid;
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent).push(node);
	}
	const rows = [];
	const visited = new Set();
	/** Collapsed subtrees emit no rows but still count as reached — otherwise the
	 * cycle fallback below would resurrect them at depth 1. */
	const markHidden = (node) => {
		if (visited.has(node.sid)) return;
		visited.add(node.sid);
		for (const child of children.get(node.sid) ?? []) markHidden(child);
	};
	const walk = (node, depth) => {
		if (visited.has(node.sid)) return; // cycle guard
		visited.add(node.sid);
		const kids = children.get(node.sid) ?? [];
		const isCollapsed = collapsed.has(node.sid);
		rows.push({ node, depth, childCount: kids.length, collapsed: isCollapsed });
		for (const child of kids) {
			if (isCollapsed) markHidden(child);
			else walk(child, depth + 1);
		}
	};
	walk(nodes[0], 0);
	for (const node of nodes) {
		if (!visited.has(node.sid)) walk(node, 1); // parentSid cycle: unreachable from root
	}
	return rows;
}

/** "$0.42" / "$0.012" (3 decimals under 10¢) / "—" for unknown (null) cost. */
export function formatCost(usd) {
	if (usd === null || usd === undefined) return "—";
	return "$" + (usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2));
}

/** "42s" / "4m 05s" / "1h 02m". */
export function formatDuration(ms) {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m ${String(totalSec % 60).padStart(2, "0")}s`;
	return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

/** Local "YYYY-MM-DD HH:MM". */
export function formatDateTime(ts) {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local "HH:MM:SS". */
export function formatClock(ts) {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Tick label matching the step: date for day steps, HH:MM for ≥1m, else HH:MM:SS. */
export function formatTick(ts, stepMs) {
	if (stepMs >= 86_400_000) return formatDateTime(ts).slice(0, 10);
	if (stepMs >= 60_000) return formatClock(ts).slice(0, 5);
	return formatClock(ts);
}
