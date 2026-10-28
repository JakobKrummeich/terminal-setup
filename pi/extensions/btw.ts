// /btw — side chat with the main session while it works. Forks the transcript as
// last sent to the model (incl. the in-flight assistant message with its still-
// running tool call), appends the question, and calls the LLM directly in the
// session's own request shape — tools stay declared, but btw never runs a call. The real session is never touched: no steer, no follow-up, nothing
// appended, not persisted, never in /tree. Children: F2 view key `b`
// (lib/child-watch.ts, lib/btw-child.ts).
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fullScreenOverlay } from "./lib/alt-screen.ts";
import { BtwChat } from "./lib/btw-chat.ts";
import { ForkSnapshot } from "./lib/btw-context.ts";
import { type BtwSource, btwRequest, NOTHING_TO_FORK } from "./lib/btw-thread.ts";
import { inChildSession } from "./lib/child-context.ts";

function mainSource(ctx: ExtensionContext, snapshot: ForkSnapshot): BtwSource {
	return {
		label: "main session",
		modelId: () => ctx.model?.id,
		request: () =>
			btwRequest({
				registry: ctx.modelRegistry,
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel ?? "off",
				sessionId: ctx.sessionManager.getSessionId(),
				// The extension API exposes no settings; read them like pi does (cwd + agent dir).
				blockImages: SettingsManager.create(ctx.cwd, getAgentDir()).getBlockImages(),
				fork: snapshot.fork(),
			}),
	};
}

/**
 * The full-screen btw overlay; resolves when it closes. Awaited by the command
 * handler on purpose (checked against pi 1.4.0 interactive-mode.js / agent-session.js):
 * extension commands run via `_tryExecuteExtensionCommand` BEFORE any steer /
 * follow-up queueing, and the agent loop runs independently of the awaiting
 * prompt() call — mid-run, the await only delays the editor's pending-message
 * redraw; idle, it parks pi's input loop, which cannot receive input anyway while
 * the overlay holds focus. Same pattern as the F2 shortcut and pi's own selectors.
 */
async function openBtwOverlay(ctx: ExtensionContext, snapshot: ForkSnapshot, question: string): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			// A fresh, ephemeral thread per open (BtwChat owns it): closing ends the chat.
			const chat = new BtwChat(tui, theme, mainSource(ctx, snapshot), () => done(), {
				terminalModes: true,
			});
			chat.submit(question);
			return chat;
		},
		{ overlay: true, overlayOptions: fullScreenOverlay },
	);
}

export default function (pi: ExtensionAPI) {
	// Main session only: pi loads every top-level extension in every child too, and
	// a child's own btw lives in the F2 view (its snapshot: lib/btw-child.ts).
	if (inChildSession()) return;

	let snapshot = new ForkSnapshot();

	// New / resumed / forked session: the old fork source is meaningless.
	pi.on("session_start", () => {
		snapshot = new ForkSnapshot();
	});

	// Observe only (returns undefined). getSystemPrompt() is read NOW: during the run it
	// is the forced prompt pi projects in after these handlers; pi clears that at run end.
	pi.on("context_with_system", (event, ctx) => {
		snapshot.onRequest(event.messages, ctx.getSystemPrompt());
	});
	pi.on("message_end", (event) => {
		snapshot.onMessageEnd(event.message);
	});

	pi.registerCommand("btw", {
		description: "Side chat with the agent while it works (forked, tools off, never saved)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (!snapshot.fork()) {
				ctx.ui.notify(NOTHING_TO_FORK, "warning");
				return;
			}
			await openBtwOverlay(ctx, snapshot, args.trim());
		},
	});
}
