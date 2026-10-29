// F2 watch cursor: which child the F2 shortcut (subagent.ts) and the overlay's
// in-view cycling (lib/child-watch.ts) show next. Reads the child registry
// (liveChildren) owned by lib/child-session.ts.
import { liveChildren } from "./child-session.ts";
import type { ChildRecord } from "./child-types.ts";
import { sharedState } from "./shared-state.ts";

// On globalThis like child-session's state (see lib/shared-state.ts): the cursor must
// survive the module re-import pi does on every session bind (jiti, moduleCache: false).
interface WatchState {
	/** F2 watch cursor: id of the last watched child, advanced per watchTarget() call. */
	watchCursor: string | undefined;
}
// Bump N whenever WatchState's shape changes (see sharedState()). The key keeps the
// name it had in lib/child-watch.ts on purpose: the shape is unchanged, so an older
// child-watch.ts copy still alive in a long-running pi process shares this object.
const STATE_KEY = Symbol.for("terminal-setup.child-watch.v1");
const state = sharedState<WatchState>(STATE_KEY, () => ({ watchCursor: undefined }));

/**
 * Session teardown for the watch: forget the cursor. subagent.ts calls it next to
 * resetChildState() (which drops the children the cursor points into).
 */
export function resetWatchCursor(): void {
	state.watchCursor = undefined;
}

/** The overlay entered `id`'s view: the outer F2 shortcut continues from there. */
export function setWatchCursor(id: string): void {
	state.watchCursor = id;
}

/** Spawn-order index of the last-watched child; -1 when unset or evicted. */
export function watchCursorIndex(): number {
	return [...liveChildren.values()].findIndex((r) => r.id === state.watchCursor);
}

/**
 * Pick the child the F2 watch should open. Repeated presses cycle through ALL
 * children — running and finished — in spawn order, wrapping. When the cursor is
 * unset (or its child was evicted), start at the first running child if any, else
 * the most recent child.
 */
export function watchTarget(): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	// Id-based cursor: children starting or finishing between presses shift indices,
	// so an index cursor could skip an entry.
	const last = all.findIndex((r) => r.id === state.watchCursor);
	// `all` is non-empty (checked above), so every index taken modulo its length exists.
	const target = last >= 0 ? all[(last + 1) % all.length]! : (all.find((r) => r.running) ?? all.at(-1)!);
	state.watchCursor = target.id;
	return target;
}

/**
 * Child after `currentId` in spawn order (wrapping; first child if the id is
 * gone). Moves the F2 cursor so the outer shortcut stays in step with in-view
 * cycling.
 */
export function nextChild(currentId: string): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	// Non-empty (checked above) + modulo length: the index always exists.
	const target = all[(all.findIndex((r) => r.id === currentId) + 1) % all.length]!;
	state.watchCursor = target.id;
	return target;
}

/**
 * Child before `currentId` in spawn order (wrapping; last child if the id is
 * gone). Moves the F2 cursor like nextChild so outer cycling stays in step.
 */
export function prevChild(currentId: string): ChildRecord | undefined {
	const all = [...liveChildren.values()];
	if (all.length === 0) return undefined;
	const idx = all.findIndex((r) => r.id === currentId);
	const target = idx < 0 ? all.at(-1)! : all[(idx - 1 + all.length) % all.length]!;
	state.watchCursor = target.id;
	return target;
}
