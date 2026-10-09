// Building a child's AgentSession — fresh, or reopened from its session file:
// the session manager, the parent's model runtime and `-ne -e` extension set, and
// the child-session ALS scope its extensions load and bind in.
import { existsSync } from "node:fs";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type ChildSessionInfo, runInChildSession } from "./child-context.ts";
import type { ChildModel, ChildThinkingLevel, RunChildOptions } from "./child-types.ts";

/**
 * Env var carrying the parent's explicit extension list (colon-separated absolute
 * paths), set by a launcher that starts pi with `-ne -e <path> ...`.
 */
const CHILD_EXTENSIONS_ENV = "PI_CHILD_EXTENSIONS";

/**
 * Resource loader replicating the parent's `-ne -e ...` flags for a child session.
 *
 * createAgentSession does NOT inherit the parent process's CLI flags: called bare it
 * builds a DefaultResourceLoader that auto-discovers ~/.pi/agent/extensions and
 * <cwd>/.pi/extensions. That is right for a normal host session (the child then has
 * the same extensions as its parent), but wrong wherever the parent deliberately ran
 * with -ne and an explicit -e list. Concretely, the podman-hands devcontainer setup
 * (devcontainer/start-devcontainer.sh) runs pi on the host with every file/shell tool
 * re-registered to execute inside a container; a bare child would miss podman-hands,
 * fall back to pi's builtin bash/read/write/edit and execute on the HOST, outside the
 * sandbox. The launcher exports PI_CHILD_EXTENSIONS with the same paths it passes via
 * -e, and we rebuild that exact extension set here.
 *
 * Returns undefined when the var is unset — plain host sessions keep discovery.
 */
async function childResourceLoader(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<DefaultResourceLoader | undefined> {
	const spec = process.env[CHILD_EXTENSIONS_ENV];
	if (!spec) return undefined;
	const additionalExtensionPaths = spec.split(":").filter((p) => p.length > 0);
	// Hard-fail on a stale path instead of loading a partial set: a missing
	// podman-hands is exactly the sandbox escape this loader exists to prevent, and
	// the loader itself only records such paths as (easily missed) load errors.
	const missing = additionalExtensionPaths.filter((p) => !existsSync(p));
	if (missing.length > 0) {
		throw new Error(`${CHILD_EXTENSIONS_ENV} lists paths that do not exist: ${missing.join(", ")}`);
	}
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths,
		noExtensions: true,
	});
	await loader.reload();
	return loader;
}

/** SessionManager.open failed: the saved transcript is unreadable (not a config problem). */
export class ReopenError extends Error {}

/**
 * Model and thinking level saved in a reopened child's session, resolved the way
 * pi's createAgentSession restores them (sdk.js): the branch's last model
 * (model_change or assistant message) via the registry, only if its provider has
 * auth configured; the thinking level only if the branch recorded one (pi's
 * buildSessionContext otherwise reports a placeholder "off"). Each field is
 * undefined when absent or unresolvable — the caller falls back.
 */
function savedModelSettings(
	ctx: ExtensionContext,
	sessionManager: SessionManager,
): { model?: ChildModel; thinkingLevel?: ChildThinkingLevel } {
	const context = sessionManager.buildSessionContext();
	const found = context.model
		? ctx.modelRegistry.find(context.model.provider, context.model.modelId)
		: undefined;
	const model = found && ctx.modelRegistry.hasConfiguredAuth(found) ? found : undefined;
	const hasThinkingEntry = sessionManager
		.getBranch()
		.some((entry) => (entry as { type?: string }).type === "thinking_level_change");
	const thinkingLevel = hasThinkingEntry ? (context.thinkingLevel as ChildThinkingLevel) : undefined;
	return { model, thinkingLevel };
}

/**
 * The parent session's ModelRuntime, for a child to share. pi keeps it in
 * ModelRegistry's PRIVATE `runtime` field (no public getter), so this reads a
 * private field on purpose: sharing it gives the child the parent's in-memory
 * credentials — `pi --api-key` lands only there, via setRuntimeApiKey — and its
 * already-loaded model catalog, instead of a fresh runtime rebuilt from agentDir
 * files. If pi renames the field this yields undefined and children silently
 * fall back to a default runtime; test/child-model-runtime.test.ts pins it.
 */
export function parentModelRuntime(ctx: Pick<ExtensionContext, "modelRegistry">): ModelRuntime | undefined {
	return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
}

/**
 * Create a child session — fresh, or reopened from `sessionFile` (an evicted or
 * pre-restart child): SessionManager.open loads the saved entries, createAgentSession
 * restores them into the agent, and new entries keep appending to the same file.
 * A reopened child runs on its saved model/thinking level (savedModelSettings);
 * the options/parent ones are only the fallback when those cannot be resolved.
 */
export async function createChildSession(
	ctx: ExtensionContext,
	options: RunChildOptions,
	sessionFile?: string,
): Promise<AgentSession> {
	const cwd = ctx.cwd;
	const sessionManager = openSessionManager(cwd, sessionFile);
	// A reopened child keeps ITS model and thinking level, exactly like a live
	// resume does — not the parent's current ones, nor RunChildOptions' (the
	// explorer model may have been reconfigured since).
	const saved = sessionFile ? savedModelSettings(ctx, sessionManager) : {};
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRuntime = parentModelRuntime(ctx);
	const model = saved.model ?? options.model ?? ctx.model;
	const thinkingLevel = saved.thinkingLevel ?? options.thinkingLevel ?? ctx.thinkingLevel;
	// The ALS payload lets extensions loading inside the child know they are in a
	// child and which contract it carries (subagent.ts appends it to the system
	// prompt via before_agent_start — see the comment there).
	const info: ChildSessionInfo = { kind: options.kind, contract: options.contract };
	const { session, extensionsResult } = await runInChildSession(info, async () => {
		// Inside the scope: the explicit loader runs the extension factories in its
		// reload(), and createAgentSession skips its own reload when handed a loader.
		// Built outside, every factory saw inChildSession() === false — children
		// lost their contract and leaked wsstate escapes, agent-dash rows and
		// the timer tool into the parent (PI_CHILD_EXTENSIONS / podman-hands only).
		const resourceLoader = await childResourceLoader(cwd, agentDir, settingsManager);
		return createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel,
			...(options.tools && { tools: options.tools }),
			excludeTools: options.excludeTools,
			sessionManager,
			settingsManager,
			...(resourceLoader && { resourceLoader }),
			...(modelRuntime !== undefined && { modelRuntime }),
		} as Parameters<typeof createAgentSession>[0]);
	});
	notifyLoadErrors(ctx, options.kind, extensionsResult?.errors);
	await runInChildSession(info, () => session.bindExtensions({}));
	return session;
}

/** A fresh session manager, or the saved one of `sessionFile` (ReopenError when unreadable). */
function openSessionManager(cwd: string, sessionFile: string | undefined): SessionManager {
	try {
		return sessionFile
			? SessionManager.open(sessionFile)
			: SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
	} catch (error) {
		if (!sessionFile) throw error;
		throw new ReopenError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Extension load errors must not stay silent: a child missing e.g. context-cap
 * or the contract injection (subagent.ts) runs with different semantics than the
 * parent and nobody would know. The child still runs — same policy as pi's own
 * startup, which reports load errors and continues.
 */
function notifyLoadErrors(
	ctx: ExtensionContext,
	kind: string,
	errors: ReadonlyArray<{ path: string; error: string }> | undefined,
): void {
	for (const { path: extPath, error } of errors ?? []) {
		ctx.ui.notify(`${kind} child: extension failed to load: ${extPath}: ${error}`, "warning");
	}
}
