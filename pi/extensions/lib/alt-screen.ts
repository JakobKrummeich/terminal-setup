// The F2 watch's alternate-screen switch (enterAltScreenWatch) and the internal
// pi-tui render-state API it drives. Used by lib/child-watch.ts.

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";

/**
 * The slice of TuiMainScreen the watch view needs to move rendering onto the
 * terminal's alternate screen. Internal pi-tui API (same coupling class as
 * markdown-no-padding's paddingX patch) — feature-detected, so a pi update that
 * renames it degrades to the old main-screen overlay instead of breaking F2.
 * Re-verify after `pi update`.
 */
interface AltScreenCapableTui {
	/** "regular" on TuiMainScreen; TuiAltScreen reports "fullscreen". */
	mode?: string;
	captureRenderState?(): unknown;
	restoreRenderState?(state: unknown): void;
	requestRender(): void;
}

/**
 * Render the watch view on the terminal's ALTERNATE screen (vim/less style).
 *
 * Why: the overlay is composited into the same frame buffer whose rows the
 * renderer scrolls into terminal scrollback. Whenever base content moves while
 * the full-screen view is up (parent streaming under it, resize-triggered
 * redraws, emulator timing), overlay rows can be committed verbatim into the
 * parent transcript's scrollback — seen live as "agent#… · turn N · running
 * read" headers mingled into history. The alternate screen has no scrollback
 * and is dropped wholesale on exit, so the entire hazard class disappears.
 *
 * Mechanics: save the renderer's differential state, switch to the alt screen,
 * reset the state so the next frame is a full paint (of the overlay-composited
 * frame) onto the blank alt screen. On exit, switch back — the terminal
 * restores the exact pre-F2 main screen — and hand the renderer its saved
 * state so it resumes diffing against what is actually on screen.
 *
 * Returns null (no-op) when pi already runs its whole TUI on the alt screen
 * (tuiMode "alt-screen") or the internal API is missing — the plain overlay
 * behavior is kept there.
 */
export function enterAltScreenWatch(tui: unknown): { exit(): void } | null {
	const t = tui as AltScreenCapableTui;
	if (
		t.mode !== "regular" ||
		typeof t.captureRenderState !== "function" ||
		typeof t.restoreRenderState !== "function"
	)
		return null;
	const saved = t.captureRenderState();
	process.stdout.write(ALT_SCREEN_ON);
	// Blank state, seeded from the captured shape so unknown future fields keep
	// sane values. previousWidth/Height 0 (not resetRenderState's -1) steers the
	// next frame into the "first render" branch — a plain full paint from the
	// alt screen's home position with NO \x1b[2J/\x1b[3J, so nothing that could
	// touch main-screen state or history is ever emitted while entering.
	t.restoreRenderState({
		...(typeof saved === "object" && saved !== null ? saved : {}),
		previousLines: [],
		previousWidth: 0,
		previousHeight: 0,
		cursorRow: 0,
		hardwareCursorRow: 0,
		maxLinesRendered: 0,
		previousViewportTop: 0,
	});
	let exited = false;
	return {
		exit() {
			// Idempotent: dispose is the normal caller, but a defensive second call
			// must not flip the terminal to the alt screen's blank state again.
			if (exited) return;
			exited = true;
			process.stdout.write(ALT_SCREEN_OFF);
			t.restoreRenderState?.(saved);
			t.requestRender();
		},
	};
}
