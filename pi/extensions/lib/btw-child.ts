// btw side chat for child sessions (Agent/Explore): the fork snapshot of each
// child (the chat's thread is ephemeral, owned by BtwChat), captured exactly at the child's agent (trackChildBtw, called by
// lib/child-create.ts), and the BtwSource the F2 watch's btw mode asks through.
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ForkSnapshot } from "./btw-context.ts";
import { type BtwSource, btwRequest } from "./btw-thread.ts";
import type { ChildRecord } from "./child-types.ts";
import { sharedState } from "./shared-state.ts";

export interface ChildBtw {
	snapshot: ForkSnapshot;
}

// On globalThis (lib/shared-state.ts): child-create.ts's copy of this module
// writes, child-watch.ts's copy reads — separate jiti module copies.
// Bump N whenever ChildBtw's shape changes (see sharedState()).
const STATE_KEY = Symbol.for("terminal-setup.btw-child.v2");
const childBtws = sharedState<WeakMap<object, ChildBtw>>(STATE_KEY, () => new WeakMap());

/**
 * Start capturing `session`'s fork source. Wraps the agent's transformContext —
 * the LAST step before convertToLlm, so its OUTPUT is exactly what the provider
 * gets, incl. pi's forced-prompt (child contract) and hidden-declaration
 * projections, which AgentSession's constructor installed into that same chain.
 * Nothing in pi reassigns agent.transformContext after construction (checked
 * against pi 1.4.0: only sdk.js at creation and the two AgentSession projection
 * installers in its constructor), so wrapping once after bindExtensions holds.
 */
export function trackChildBtw(session: AgentSession): ChildBtw {
	const entry: ChildBtw = { snapshot: new ForkSnapshot() };
	const agent = session.agent;
	const previous = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const sent = previous ? await previous(messages, signal) : messages;
		entry.snapshot.onRequest(sent);
		return sent;
	};
	session.subscribe((event) => {
		if (event.type === "message_end") entry.snapshot.onMessageEnd(event.message);
	});
	childBtws.set(session, entry);
	return entry;
}

/** The child's btw state; undefined for a session trackChildBtw never saw. */
export function childBtw(session: AgentSession): ChildBtw | undefined {
	return childBtws.get(session);
}

/** A child as btw's fork source: its own model, thinking level and session id. */
export function childBtwSource(
	registry: Pick<ModelRegistry, "streamSimple">,
	record: Pick<ChildRecord, "kind" | "id" | "session">,
	snapshot: ForkSnapshot,
): BtwSource {
	const session = record.session;
	return {
		label: `${record.kind}#${record.id}`,
		modelId: () => session.model?.id,
		request: () =>
			btwRequest({
				registry,
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				sessionId: session.sessionManager.getSessionId(),
				fork: snapshot.fork(),
			}),
	};
}
