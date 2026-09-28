/**
 * session-view.js — DOM for #/session/<root>: header, time axis, collapsible
 * tree + Gantt bars (layout math in gantt-layout.js). Fetching, live updates
 * and the grow timer stay in app.js; this module only draws.
 */
import { badge, buildBreadcrumb, el, shortSid, viewHref } from "./dom.js";
import {
	barGeometry,
	computeTicks,
	formatCost,
	formatDateTime,
	formatDuration,
	formatTick,
	orderTreeRows,
	timeRange,
} from "./gantt-layout.js";

export function drawSessionPage(mount, root, tree, state) {
	const now = Date.now();
	const ctx = {
		root,
		now,
		range: timeRange(tree.nodes, now),
		toggle: (sid) => {
			if (state.collapsed.has(sid)) state.collapsed.delete(sid);
			else state.collapsed.add(sid);
			drawSessionPage(mount, root, state.lastTree, state); // redraw only — no refetch
		},
	};
	const page = el("div", "page");
	page.append(buildSessionHeader(root, tree, ctx));
	const gantt = el("div", "gantt");
	gantt.append(buildAxisRow(ctx.range));
	const body = el("div", "gantt-body");
	body.append(buildGridlines(ctx.range));
	for (const row of orderTreeRows(tree.nodes, state.collapsed)) body.append(buildGanttRow(row, ctx));
	gantt.append(body);
	page.append(gantt);
	mount.replaceChildren(page);
}

function buildSessionHeader(root, tree, ctx) {
	const rootNode = tree.nodes[0];
	const running = tree.nodes.some((node) => node.status === "running");
	const head = el("div", "session-head");
	head.append(buildBreadcrumb([
		{ text: "sessions", href: "#/" },
		{ text: `session ${shortSid(root)}`, href: null },
	]));
	const meta = el("div", "session-meta");
	meta.append(badge(running));
	meta.append(el("span", "", `started ${formatDateTime(rootNode.startTs)}`));
	meta.append(el("span", "", `span ${formatDuration(ctx.range.maxTs - ctx.range.minTs)}`));
	meta.append(el("span", "", `${tree.nodes.length - 1} children`)); // agents AND explorers, like landing's count
	head.append(meta);
	return head;
}

function buildAxisRow(range) {
	const row = el("div", "gantt-row axis-row");
	row.append(el("div", "tree-cell axis-caption", "agent"));
	const lane = el("div", "lane axis");
	const { stepMs, ticks } = computeTicks(range.minTs, range.maxTs);
	for (const tick of ticks) {
		const label = el("span", "tick-label", formatTick(tick.ts, stepMs));
		label.style.left = `${tick.leftPct}%`;
		lane.append(label);
	}
	row.append(lane);
	return row;
}

/** Vertical tick lines behind the bars, aligned with the axis labels. */
function buildGridlines(range) {
	const overlay = el("div", "gridlines");
	for (const tick of computeTicks(range.minTs, range.maxTs).ticks) {
		const line = el("div", "gridline");
		line.style.left = `${tick.leftPct}%`;
		overlay.append(line);
	}
	return overlay;
}

function buildGanttRow(rowInfo, ctx) {
	const { node, depth, childCount, collapsed } = rowInfo;
	const row = el("div", "gantt-row");
	const cell = el("div", "tree-cell");
	cell.style.paddingLeft = `${depth * 18 + 8}px`;
	const toggle = el("button", "toggle", childCount > 0 ? (collapsed ? "▸" : "▾") : "·");
	if (childCount > 0) toggle.addEventListener("click", () => ctx.toggle(node.sid));
	else toggle.disabled = true;
	cell.append(toggle);
	const link = el("a", "node-label", node.label);
	link.href = viewHref(node.sid, ctx.root);
	link.title = node.description || node.sid;
	cell.append(link);
	cell.append(el("span", "node-kind", node.kind));
	row.append(cell, buildBarLane(node, ctx));
	return row;
}

function buildBarLane(node, ctx) {
	const lane = el("div", "lane");
	const geo = barGeometry(node, ctx.range, ctx.now);
	const bar = el("a", "bar");
	bar.href = viewHref(node.sid, ctx.root);
	bar.dataset.status = node.status; // unknown statuses fall back to the base bar color
	bar.style.left = `${geo.leftPct}%`;
	bar.style.width = `${geo.widthPct}%`;
	bar.title = `${node.label} · ${node.status} · ${formatDuration((node.endTs ?? ctx.now) - node.startTs)}`;
	bar.append(el("span", "bar-label", barLabel(node)));
	lane.append(bar);
	return lane;
}

function barLabel(node) {
	const parts = [node.label, formatCost(node.costUsd)];
	if (node.resets > 0) parts.push(`↺${node.resets}`);
	return parts.join(" · ");
}
