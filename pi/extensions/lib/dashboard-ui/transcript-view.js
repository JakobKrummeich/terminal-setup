/**
 * transcript-view.js — DOM for #/view/<sid>?root=<root>: breadcrumb (parent
 * chain from tree data), entries with expandable tool calls, anchor sidebar.
 * Fetching and live updates stay in app.js; this module only draws.
 */
import { buildBreadcrumb, el, sessionHref, shortSid, viewHref } from "./dom.js";
import { formatClock } from "./gantt-layout.js";

export function drawTranscript(mount, sid, root, transcript, tree) {
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
	mount.replaceChildren(page);
	window.scrollTo(0, wasAtBottom ? doc.scrollHeight : prevScrollY);
}

/** sessions / session <root> / <parent chain from tree data> (current plain). */
export function transcriptCrumbs(sid, root, tree) {
	const parts = [{ text: "sessions", href: "#/" }];
	if (root) parts.push({ text: `session ${shortSid(root)}`, href: sessionHref(root) });
	const chain = parentChain(tree, sid);
	for (const node of chain) {
		parts.push({ text: node.label, href: node.sid === sid ? null : viewHref(node.sid, root) });
	}
	if (chain.length === 0) parts.push({ text: shortSid(sid), href: null });
	return parts;
}

/** Tree nodes from the top ancestor down to `sid`; [] without tree data or when sid is not in it. A parentSid cycle stops at 32 steps. */
function parentChain(tree, sid) {
	if (!tree) return [];
	const bySid = new Map(tree.nodes.map((node) => [node.sid, node]));
	const chain = [];
	let cursor = bySid.get(sid);
	for (let guard = 0; cursor && guard < 32; guard++) {
		chain.unshift(cursor);
		cursor = cursor.parentSid === null ? undefined : bySid.get(cursor.parentSid);
	}
	return chain;
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
