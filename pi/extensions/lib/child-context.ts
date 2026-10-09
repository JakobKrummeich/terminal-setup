// "Am I inside a child session?" — the AsyncLocalStorage scope createChildSession
// (lib/child-session.ts) runs a child's extension load/bind in.
//
// Its own small module so the guards in wsstate.ts, agent-dash.ts and timer.ts
// don't pull a copy of the whole child-session module into every extension
// that loads them.
import { AsyncLocalStorage } from "node:async_hooks";
import { sharedState } from "./shared-state.ts";

// The ALS instance lives on globalThis, NOT in module scope: pi loads each extension
// file with its own jiti instance (moduleCache: false), so every extension importing
// this file gets its own module copy. The scope createChildSession enters (via
// child-session.ts's copy) must be visible to every other copy — with a per-copy
// ALS, inChildSession() would be false inside e.g. an explorer child.
const STATE_KEY = Symbol.for("terminal-setup.child-context.v1");
const childSessionStore = sharedState<AsyncLocalStorage<ChildSessionInfo>>(
	STATE_KEY,
	() => new AsyncLocalStorage<ChildSessionInfo>(),
);

/** What a child session is, seen from inside its own extension loading/binding. */
export interface ChildSessionInfo {
	/** RunChildOptions.kind, e.g. "agent" or "explorer". */
	kind: string;
	/** RunChildOptions.contract — undefined when the child gets no delegate contract. */
	contract: string | undefined;
}

export const inChildSession = () => childSessionStore.getStore() !== undefined;
/**
 * The ChildSessionInfo of the child currently being created, or undefined outside
 * a child. Only meaningful while createChildSession's ALS scope is active — i.e.
 * during extension load/bind of the child — so extensions must capture what they
 * need at bind time (the store is gone when later events fire).
 */
export const childSessionInfo = (): ChildSessionInfo | undefined => childSessionStore.getStore();
export const runInChildSession = <T>(info: ChildSessionInfo, fn: () => Promise<T>) =>
	childSessionStore.run(info, fn);
