// The busy-group semaphore of child-session tools: at most `limit` children per
// group hold a slot; a child still winding down after its tool call returned keeps
// its slot until idle. The groups live in child-session.ts's shared state and are
// passed in (this module owns no state).
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Counting semaphore for one group of children (see busyGroup() below). */
export interface BusyGroup {
	/** Children currently holding a slot (running or still winding down). */
	active: number;
	/** Max concurrent children; refreshed on every runChildTool call. */
	limit: number;
	/** Sessions still winding down after their tool call returned; each keeps its slot. */
	settling: Set<AgentSession>;
}

// Counting semaphore per busy group. Agents stay at limit 1: parallel agents would
// share one worktree (they overwrite each other's edits) and one terminal. Explorers
// are readonly, so their group allows N concurrent children (PI_EXPLORER_PARALLEL,
// resolved by explore.ts). The slot is taken synchronously before the first await, so
// two tool calls in the same assistant message cannot both slip past a full semaphore.
// Explorers get their own group also because a subagent's Explore call runs inside a
// still-running Agent tool call, and a single shared latch would reject it as busy.
export function busyGroup(groups: Map<string, BusyGroup>, name: string): BusyGroup {
	let group = groups.get(name);
	if (!group) {
		group = { active: 0, limit: 1, settling: new Set() };
		groups.set(name, group);
	}
	return group;
}

/**
 * Cap on how long a settling child may keep its semaphore slot: if waitForIdle()
 * never resolves (hung child), the slot would otherwise be stranded for the rest
 * of the pi session — at limit 1 (Agent group) the tool would be permanently busy.
 */
const SETTLE_TIMEOUT_MS = 60_000;

/** Take a slot of `group` for this call (the limit is refreshed from `concurrency`); false when full. */
export function tryAcquireSlot(group: BusyGroup, concurrency: number | undefined): boolean {
	group.limit = Math.max(1, Math.floor(concurrency ?? 1));
	if (group.active >= group.limit) return false;
	group.active++;
	return true;
}

/** Give back this call's slot; `session` is the call's child (undefined if none was created). */
export function releaseSlot(group: BusyGroup, session: AgentSession | undefined): void {
	// Semaphore wind-down: if the child is still draining (abort in flight), its
	// slot stays occupied until it is actually idle — a new child must not overlap
	// it. Released in the background; the result returns now.
	if (session && !session.isIdle) {
		group.settling.add(session);
		// Idempotent: fires from waitForIdle OR the self-expiry timeout, whichever
		// comes first — never both (the slot must be released exactly once).
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(timeout);
			group.settling.delete(session);
			group.active--;
		};
		const timeout = setTimeout(release, SETTLE_TIMEOUT_MS);
		timeout.unref?.(); // must not keep the process alive
		session.waitForIdle().then(release, release);
	} else {
		group.active--;
	}
}
