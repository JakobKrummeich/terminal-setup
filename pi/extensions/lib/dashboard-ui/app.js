/**
 * app.js — agent dashboard single-page UI
 * (docs/agent-dashboard-spec.md "Browser UI"; API shapes in lib/dashboard-api.ts).
 *
 * Hash routes — literal table in renderRoute():
 *   #/                        landing: collapsible per-project sections, one row per session tree
 *   #/session/<root>          collapsible tree + Gantt for one tree
 *   #/view/<sid>?root=<root>  transcript of one node
 *
 * The server is the machine-global daemon (all projects under one sessions
 * root); /api/meta identifies it — host badge in the header, hostname in
 * document.title. Sids are globally unique, so session/view routes need no
 * project component.
 *
 * Safety rule: EVERY server-derived string reaches the DOM via textContent
 * (the el() helper) — never innerHTML. Transcripts contain arbitrary markup
 * and the server binds 0.0.0.0 (spec "Risks": exposure); this is the XSS
 * boundary.
 *
 * Live updates: /api/events SSE → refetch; startLive() degrades to polling
 * when SSE errors. Session pages add a 5s timer while running so bars grow.
 * 404 mid-view (session pruned) → back to the landing page with a notice.
 */
import {
	barGeometry,
	computeTicks,
	formatClock,
	formatCost,
	formatDateTime,
	formatDuration,
	formatTick,
	orderTreeRows,
	timeRange,
} from "./gantt-layout.js";

const app = document.getElementById("app");

// --- tiny helpers ------------------------------------------------------------

/** The one DOM factory: text always goes through textContent. */
function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

class HttpError extends Error {
	constructor(status, url) {
		super(`${url} → HTTP ${status}`);
		this.status = status;
	}
}

async function fetchJson(url) {
	const res = await fetch(url);
	if (!res.ok) throw new HttpError(res.status, url);
	return res.json();
}

function safeDecode(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

function shortSid(sid) {
	return sid.length > 10 ? sid.slice(0, 8) : sid;
}

function sessionHref(root) {
	return `#/session/${encodeURIComponent(root)}`;
}

function viewHref(sid, root) {
	const base = `#/view/${encodeURIComponent(sid)}`;
	return root ? `${base}?root=${encodeURIComponent(root)}` : base;
}

function badge(running) {
	const span = el("span", "badge", running ? "running" : "finished");
	span.dataset.status = running ? "running" : "finished";
	return span;
}

// --- daemon identity (/api/meta) ---------------------------------------------

/** MetaResponse payload; null until loaded (badge stays empty, titles fall back). */
let meta = null;

function baseTitle() {
	return meta ? `pi dash · ${meta.hostname}` : "pi dash";
}

/** One fetch at boot — daemon identity doesn't change while the tab lives. */
async function loadMeta() {
	try {
		meta = await fetchJson("/api/meta");
		document.getElementById("host-badge").textContent = `${meta.hostname} · ${meta.sessionsRoot}`;
	} catch {
		// no /api/meta (daemon restarting?): badge stays empty, pages still work
	}
}

/** parts: [{ text, href|null }] — null href renders the current (plain) crumb. */
function buildBreadcrumb(parts) {
	const nav = el("nav", "crumbs");
	parts.forEach((part, i) => {
		if (i > 0) nav.append(el("span", "crumb-sep", "/"));
		if (!part.href) return nav.append(el("span", "crumb current", part.text));
		const link = el("a", "crumb", part.text);
		link.href = part.href;
		nav.append(link);
	});
	return nav;
}

// --- live updates (SSE with polling fallback) --------------------------------

/**
 * Drive `onChange` from /api/events (optionally watching one sid's session
 * file too). SSE failure starts a 7s poll instead — the EventSource keeps
 * auto-reconnecting alongside; refetches are idempotent so overlap is fine.
 * Returns a stop function.
 */
function startLive(sid, onChange) {
	let poll = null;
	const startPoll = () => {
		if (!poll) poll = setInterval(onChange, 7000);
	};
	let source = null;
	try {
		source = new EventSource(sid ? `/api/events?sid=${encodeURIComponent(sid)}` : "/api/events");
		source.onmessage = onChange;
		source.onerror = startPoll;
	} catch {
		startPoll();
	}
	return () => {
		if (source) source.close();
		if (poll) clearInterval(poll);
	};
}

// --- routing -----------------------------------------------------------------

/** Cleanup callbacks (SSE, timers) for the current page; run on navigation. */
let pageCleanups = [];
/** Bumped per navigation; in-flight refetches from a left page check it and bail. */
let navToken = 0;
/** One-shot banner for the landing page ("session vanished"). */
let pendingNotice = null;

function onPageLeave(cleanup) {
	pageCleanups.push(cleanup);
}

/** The route table. Literal hash prefixes only — grep the prefix, land here. */
function renderRoute() {
	for (const cleanup of pageCleanups.splice(0)) cleanup();
	navToken += 1;
	window.scrollTo(0, 0);
	const hash = location.hash || "#/";
	if (hash !== "#/") pendingNotice = null; // the landing banner dies on navigation
	if (hash.startsWith("#/view/")) return renderTranscriptPage(hash);
	if (hash.startsWith("#/session/")) return renderSessionPage(hash);
	return renderLandingPage();
}

function goLandingWithNote(note) {
	pendingNotice = note;
	if ((location.hash || "#/") === "#/") renderRoute();
	else location.hash = "#/";
}

function renderError(error) {
	app.replaceChildren(el("div", "error", `fetch failed: ${error}`));
}

/** Shared fetch-failure policy: 404 → landing + notice; anything else inline. */
function pageError(error, vanishedNote) {
	if (error instanceof HttpError && error.status === 404) {
		return goLandingWithNote(`${vanishedNote} — returned to the session list.`);
	}
	renderError(error);
}

// --- #/ landing --------------------------------------------------------------

function renderLandingPage() {
	document.title = baseTitle();
	const token = navToken;
	onPageLeave(startLive(null, refresh));
	refresh();
	async function refresh() {
		let data;
		try {
			data = await fetchJson("/api/sessions");
		} catch (error) {
			return token === navToken ? renderError(error) : undefined;
		}
		if (token === navToken) drawLanding(data.sessions);
	}
}

function drawLanding(sessions) {
	const page = el("div", "page");
	if (pendingNotice) page.append(el("div", "notice", pendingNotice));
	page.append(el("h1", "page-title", "sessions"));
	if (sessions.length === 0) page.append(el("div", "empty", "no sessions recorded yet"));
	for (const group of groupByProject(sessions)) page.append(buildProjectSection(group));
	app.replaceChildren(page);
}

/** Collapsed project sections (by projectId) — survives SSE-driven redraws. */
const collapsedProjects = new Set();

/** Group rows by projectId; groups with running sessions first, then by newest session. */
function groupByProject(sessions) {
	const groups = new Map();
	for (const row of sessions) {
		let group = groups.get(row.projectId);
		if (!group) {
			group = { projectId: row.projectId, project: row.project, sessions: [] };
			groups.set(row.projectId, group);
		}
		group.sessions.push(row);
	}
	const list = [...groups.values()];
	for (const group of list) {
		group.runningCount = group.sessions.filter((row) => row.running).length;
		group.newestTs = Math.max(...group.sessions.map((row) => row.startTs));
	}
	list.sort((a, b) => Number(b.runningCount > 0) - Number(a.runningCount > 0) || b.newestTs - a.newestTs);
	return list;
}

function buildProjectSection(group) {
	const details = el("details", "project");
	details.open = !collapsedProjects.has(group.projectId);
	details.addEventListener("toggle", () => {
		if (details.open) collapsedProjects.delete(group.projectId);
		else collapsedProjects.add(group.projectId);
	});
	const summary = el("summary", "project-head");
	summary.title = group.projectId; // raw dir name — the unambiguous id (decode is best-effort)
	summary.append(el("span", "project-name", group.project));
	let countText = `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"}`;
	if (group.runningCount > 0) countText += ` · ${group.runningCount} running`;
	summary.append(el("span", "project-count", countText));
	details.append(summary, buildSessionTable(group.sessions));
	return details;
}

function buildSessionTable(sessions) {
	// Server sends newest-first; pinning running rows on top is our job.
	const rows = [...sessions].sort((a, b) => Number(b.running) - Number(a.running) || b.startTs - a.startTs);
	const table = el("table", "sessions");
	const headRow = el("tr");
	for (const title of ["started", "duration", "cost", "agents", "resets", "status"]) {
		headRow.append(el("th", "", title));
	}
	const thead = el("thead");
	thead.append(headRow);
	const tbody = el("tbody");
	for (const row of rows) tbody.append(buildSessionRow(row));
	table.append(thead, tbody);
	return table;
}

function buildSessionRow(row) {
	const tr = el("tr", row.running ? "session-row is-running" : "session-row");
	const startCell = el("td");
	const link = el("a", "session-link", formatDateTime(row.startTs));
	link.href = sessionHref(row.sid);
	link.title = row.sid;
	startCell.append(link);
	tr.append(startCell);
	tr.append(el("td", "num", formatDuration(row.durationMs)));
	tr.append(el("td", "num", formatCost(row.costUsd)));
	tr.append(el("td", "num", String(row.agentCount)));
	tr.append(el("td", "num", String(row.resetCount)));
	const badgeCell = el("td");
	badgeCell.append(badge(row.running));
	tr.append(badgeCell);
	return tr; // navigation via the start-time <a> — keyboard-accessible, no double handler
}

// --- #/session/<root> Gantt + tree -------------------------------------------

function renderSessionPage(hash) {
	const root = safeDecode(hash.slice("#/session/".length).split("?")[0]);
	document.title = `session ${shortSid(root)} — ${baseTitle()}`;
	const token = navToken;
	const state = { collapsed: new Set(), lastTree: null, growTimer: null };
	onPageLeave(startLive(null, refresh));
	onPageLeave(() => {
		if (state.growTimer) clearInterval(state.growTimer);
	});
	refresh();
	async function refresh() {
		let tree;
		try {
			tree = await fetchJson(`/api/tree?root=${encodeURIComponent(root)}`);
		} catch (error) {
			return token === navToken ? pageError(error, `session ${shortSid(root)} vanished (404)`) : undefined;
		}
		if (token !== navToken) return;
		state.lastTree = tree;
		// ~5s timer while running so bars grow between SSE events (spec: UI §2).
		const running = tree.nodes.some((node) => node.status === "running");
		if (running && !state.growTimer) state.growTimer = setInterval(refresh, 5000);
		if (!running && state.growTimer) {
			clearInterval(state.growTimer);
			state.growTimer = null;
		}
		drawSessionPage(root, tree, state);
	}
}

function drawSessionPage(root, tree, state) {
	const now = Date.now();
	const ctx = {
		root,
		now,
		range: timeRange(tree.nodes, now),
		toggle: (sid) => {
			if (state.collapsed.has(sid)) state.collapsed.delete(sid);
			else state.collapsed.add(sid);
			drawSessionPage(root, state.lastTree, state); // redraw only — no refetch
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
	app.replaceChildren(page);
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

// --- #/view/<sid>?root=<root> transcript --------------------------------------

function renderTranscriptPage(hash) {
	const [rawSid, rawQuery] = hash.slice("#/view/".length).split("?");
	const sid = safeDecode(rawSid);
	const root = new URLSearchParams(rawQuery ?? "").get("root");
	document.title = `${shortSid(sid)} — ${baseTitle()}`;
	const token = navToken;
	const state = { liveStarted: false };
	refresh();
	async function refresh() {
		let transcript;
		try {
			transcript = await fetchJson(`/api/transcript?sid=${encodeURIComponent(sid)}`);
		} catch (error) {
			return token === navToken ? pageError(error, `transcript ${shortSid(sid)} vanished (404)`) : undefined;
		}
		let tree = null;
		if (root) {
			try {
				tree = await fetchJson(`/api/tree?root=${encodeURIComponent(root)}`);
			} catch {
				tree = null; // breadcrumb chain degrades; transcript still renders
			}
		}
		if (token !== navToken) return;
		const node = tree ? (tree.nodes.find((n) => n.sid === sid) ?? null) : null;
		// Watch while running — and also whenever tree data is unavailable (no
		// ?root=, tree 404, sid missing from the tree): we can't tell whether the
		// session runs, so watch anyway. Watching a finished session is harmless
		// (its file never changes) and the SSE/poll refetch is cheap. (spec: UI §3)
		if ((node === null || node.status === "running") && !state.liveStarted) {
			state.liveStarted = true;
			onPageLeave(startLive(sid, refresh));
		}
		drawTranscript(sid, root, transcript, tree);
	}
}

function drawTranscript(sid, root, transcript, tree) {
	// Preserve reading position across live refetches; stick to the bottom only
	// if the user already was there.
	const doc = document.documentElement;
	const wasAtBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 60;
	const prevScrollY = window.scrollY;
	const openKeys = new Set(
		[...document.querySelectorAll("details[data-key]")].filter((d) => d.open).map((d) => d.dataset.key),
	);
	const page = el("div", "page");
	page.append(buildBreadcrumb(transcriptCrumbs(sid, root, tree)));
	const grid = el("div", "transcript-grid");
	const entries = el("div", "entries");
	if (transcript.entries.length === 0) entries.append(el("div", "empty", "(no transcript entries)"));
	transcript.entries.forEach((entry, index) => entries.append(buildEntry(entry, index, openKeys)));
	grid.append(entries, buildAnchorPanel(transcript.anchors, root));
	page.append(grid);
	app.replaceChildren(page);
	window.scrollTo(0, wasAtBottom ? doc.scrollHeight : prevScrollY);
}

/** sessions / session <root> / <parent chain from tree data> (current plain). */
function transcriptCrumbs(sid, root, tree) {
	const parts = [{ text: "sessions", href: "#/" }];
	if (root) parts.push({ text: `session ${shortSid(root)}`, href: sessionHref(root) });
	const chain = [];
	if (tree) {
		const bySid = new Map(tree.nodes.map((node) => [node.sid, node]));
		let cursor = bySid.get(sid);
		for (let guard = 0; cursor && guard < 32; guard++) {
			chain.unshift(cursor);
			cursor = cursor.parentSid === null ? undefined : bySid.get(cursor.parentSid);
		}
	}
	for (const node of chain) {
		parts.push({ text: node.label, href: node.sid === sid ? null : viewHref(node.sid, root) });
	}
	if (chain.length === 0) parts.push({ text: shortSid(sid), href: null });
	return parts;
}

function buildEntry(entry, index, openKeys) {
	const article = el("article", entry.role === "user" ? "entry user" : "entry assistant");
	article.id = `entry-${index}`;
	const head = el("header", "entry-head");
	head.append(el("span", "entry-role", entry.role));
	if (entry.tsMs !== null) head.append(el("span", "entry-ts", formatClock(entry.tsMs)));
	article.append(head);
	if (entry.text) article.append(el("pre", "entry-text", entry.text));
	entry.toolCalls.forEach((call, callIndex) => {
		article.append(buildToolCall(call, `${index}:${callIndex}`, openKeys));
	});
	return article;
}

function buildToolCall(call, key, openKeys) {
	const details = el("details", "tool");
	details.dataset.key = key; // survives live redraws via openKeys
	if (openKeys.has(key)) details.open = true;
	const summary = el("summary");
	summary.append(el("code", "tool-name", call.name));
	summary.append(el("span", "tool-args", call.argsSummary));
	details.append(summary);
	details.append(el("pre", "tool-output", call.output || "(no output)"));
	return details;
}

/** Human captions for the known anchor types; unknown types render verbatim. */
const ANCHOR_TYPE_LABELS = {
	"handoff": "handoff",
	"agent-spawn": "agent spawn",
	"explorer-spawn": "explorer spawn",
};

function buildAnchorPanel(anchors, root) {
	const panel = el("aside", "anchors");
	panel.append(el("h2", "side-title", "anchors"));
	if (anchors.length === 0) panel.append(el("div", "empty", "none"));
	for (const anchor of anchors) panel.append(buildAnchor(anchor, root));
	return panel;
}

function buildAnchor(anchor, root) {
	const item = el("div", "anchor");
	item.dataset.type = anchor.type;
	const jump = el("button", "anchor-jump");
	const caption = Object.hasOwn(ANCHOR_TYPE_LABELS, anchor.type) ? ANCHOR_TYPE_LABELS[anchor.type] : anchor.type;
	jump.append(el("span", "anchor-type", caption));
	if (anchor.label) jump.append(el("span", "anchor-label", anchor.label));
	jump.addEventListener("click", () => {
		// entryIndex 0 with zero entries: element absent → no-op.
		const target = document.getElementById(`entry-${anchor.entryIndex}`);
		if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
	});
	item.append(jump);
	if (anchor.targetSid) {
		const open = el("a", "anchor-open", "open transcript ↗");
		open.href = viewHref(anchor.targetSid, root);
		item.append(open);
	}
	if (anchor.description) item.append(el("div", "anchor-desc", anchor.description));
	return item;
}

// --- boot --------------------------------------------------------------------

window.addEventListener("hashchange", renderRoute);
// Meta first so the first render already has the hostname title; loadMeta
// never rejects, and a dead daemon still renders (with fetch errors inline).
loadMeta().then(renderRoute);
