/**
 * dom.js — the DOM factory and link/label helpers shared by the dashboard's
 * page modules (app.js, session-view.js, transcript-view.js).
 *
 * Safety rule (see app.js): EVERY server-derived string reaches the DOM via
 * textContent — el() is that XSS boundary; never innerHTML.
 */

/** The one DOM factory: text always goes through textContent. */
export function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function shortSid(sid) {
	return sid.length > 10 ? sid.slice(0, 8) : sid;
}

export function sessionHref(root) {
	return `#/session/${encodeURIComponent(root)}`;
}

export function viewHref(sid, root) {
	const base = `#/view/${encodeURIComponent(sid)}`;
	return root ? `${base}?root=${encodeURIComponent(root)}` : base;
}

export function badge(running) {
	const span = el("span", "badge", running ? "running" : "finished");
	span.dataset.status = running ? "running" : "finished";
	return span;
}

/** parts: [{ text, href|null }] — null href renders the current (plain) crumb. */
export function buildBreadcrumb(parts) {
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
