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
 * (the el() helper, dom.js) — never innerHTML. Transcripts contain arbitrary markup
 * and the server binds 0.0.0.0 (spec "Risks": exposure); this is the XSS
 * boundary.
 *
 * Live updates: /api/events SSE → refetch; startLive() degrades to polling
 * when SSE errors. Session pages add a 5s timer while running so bars grow.
 * 404 mid-view (session pruned) → back to the landing page with a notice.
 */
import { badge, el, sessionHref, shortSid } from "./dom.js";
import { formatCost, formatDateTime, formatDuration } from "./gantt-layout.js";
import { drawSessionPage } from "./session-view.js";
import { drawTranscript } from "./transcript-view.js";

const app = document.getElementById("app");

// --- fetch helpers -----------------------------------------------------------

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
		syncGrowTimer(state, tree.nodes.some((node) => node.status === "running"), refresh);
		drawSessionPage(app, root, tree, state);
	}
}

/** ~5s timer while running so bars grow between SSE events (spec: UI §2). */
function syncGrowTimer(state, running, refresh) {
	if (running && !state.growTimer) state.growTimer = setInterval(refresh, 5000);
	if (!running && state.growTimer) {
		clearInterval(state.growTimer);
		state.growTimer = null;
	}
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
		const tree = await fetchTreeOrNull(root);
		if (token !== navToken) return;
		const node = findTreeNode(tree, sid);
		// Watch while running — and also whenever tree data is unavailable (no
		// ?root=, tree 404, sid missing from the tree): we can't tell whether the
		// session runs, so watch anyway. Watching a finished session is harmless
		// (its file never changes) and the SSE/poll refetch is cheap. (spec: UI §3)
		if ((node === null || node.status === "running") && !state.liveStarted) {
			state.liveStarted = true;
			onPageLeave(startLive(sid, refresh));
		}
		drawTranscript(app, sid, root, transcript, tree);
	}
}

/** The tree node for sid; null without tree data or when the tree lacks it. */
function findTreeNode(tree, sid) {
	return tree ? (tree.nodes.find((n) => n.sid === sid) ?? null) : null;
}

/** The tree for the transcript page's breadcrumb; null without ?root= or on any fetch failure. */
async function fetchTreeOrNull(root) {
	if (!root) return null;
	try {
		return await fetchJson(`/api/tree?root=${encodeURIComponent(root)}`);
	} catch {
		return null; // breadcrumb chain degrades; transcript still renders
	}
}

// --- boot --------------------------------------------------------------------

window.addEventListener("hashchange", renderRoute);
// Meta first so the first render already has the hostname title; loadMeta
// never rejects, and a dead daemon still renders (with fetch errors inline).
loadMeta().then(renderRoute);
