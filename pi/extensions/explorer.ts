// Explorer: a cheap, read-only child agent that reports *where to look*.
//
// Available to every agent, including subagents — exploration is the one kind of
// delegation that stays available at any depth. The explorer itself can spawn nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_TOOL,
	type ChildModel,
	EXPLORER_TOOL,
	inChildSession,
	renderChildResult,
	runChildTool,
	textResult,
} from "./lib/child-session.ts";

const CONFIG_FILE = "explorer-model.json";
const CONFIG_COMMAND = "explorer-model";

/** Tools an explorer must not have. Read-only, no delegation, nothing to wait on. */
const EXCLUDED_TOOLS = [AGENT_TOOL, EXPLORER_TOOL, "edit", "write", "bash", "timer"];

const TOOL_DESCRIPTION = `Find out WHERE to look in the codebase — every time, not once.

The explorer is a cheap, fast, read-only agent. It searches for you and reports back the exact
places you need to read — file paths with line ranges and one line on why each one matters. It
does not answer your question and does not paste code; you read the pointers it returns and build
your own understanding from the few files that actually matter.

Standing rule, follow it literally: **before you open, grep or list any part of the repository you
have not already read in this session, ask an explorer instead.** One call at the start of a task
is not enough. A normal task needs several — one per area you touch (domain, API, UI, tests,
config, docs), another whenever the work moves somewhere new, and another when a pointer turns out
to be incomplete. If you catch yourself running a second or third search in an area you have not
mapped, stop and ask an explorer for that area instead.

Use it, without being asked, whenever you would otherwise start grepping around:
- "where is X implemented / configured / tested"
- "which files handle Y", "what calls Z", "where does this data come from"
- "how does feature Y hang together" — across an unfamiliar area
- "what are the conventions here" — how this repo names, structures and tests this kind of change
- getting oriented in a repo, module or dependency you have not read yet

Prefer it over exploring yourself: your context is expensive and fills with dead ends, its is
cheap and disposable. Ask several explorers in a row for different questions rather than opening
files speculatively. It cannot edit, write or run commands, so it is always safe to ask.

Do not use it for: work you already know the location of, single targeted greps, anything that
needs edits or command execution (use ${AGENT_TOOL}), or judgement calls — decide those yourself
from the pointers it gives you.

Ask a precise question and say what you plan to do with the answer. Follow up on the same
explorer with resume_id to dig deeper in an area it already mapped.`;

const PROMPT_PREFIX = `You are an explorer. Your job is NOT to answer the question, solve the
problem or write code — it is to tell the caller exactly where to look.

Report pointers, in this shape, most important first:
  path/to/file.ts:120-180 — why this matters, one line
Group them if that helps, and add at most a couple of lines of orientation (how the pieces relate)
when it is genuinely useful.

Rules:
- Never paste code. Line ranges instead.
- Never guess a path. Verify every pointer exists before reporting it.
- Only include places the caller actually needs to read. Leave out near-misses and dead ends.
- If you found nothing, say so plainly and name where you looked, so the caller does not repeat it.
- You are read-only: no edits, no commands, no delegation.

The question follows.`;

interface ExplorerConfig {
	provider: string | null;
	model: string | null;
}

const configPath = () => join(getAgentDir(), CONFIG_FILE);

function readConfig(): ExplorerConfig {
	try {
		const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<ExplorerConfig>;
		return { provider: raw.provider ?? null, model: raw.model ?? null };
	} catch {
		return { provider: null, model: null };
	}
}

function writeConfig(config: ExplorerConfig): void {
	writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

const UNSET_HINT = `No explorer model configured. Run /${CONFIG_COMMAND} to pick one (a cheap, fast model such as claude-haiku-4-5).`;

/**
 * Resolve the configured model — local snapshot reads only, no network, no tokens.
 * Never falls back to the parent model: that would silently pay flagship prices.
 */
function resolveModel(ctx: ExtensionContext): { model: ChildModel } | { error: string } {
	const { provider, model } = readConfig();
	if (!provider || !model) return { error: UNSET_HINT };
	const found = ctx.modelRegistry.find(provider, model);
	if (!found) {
		return {
			error: `Configured explorer model "${provider}/${model}" is not in the model registry. Run /${CONFIG_COMMAND} to pick an available one.`,
		};
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
		return {
			error: `No credentials configured for provider "${provider}" (explorer model "${model}"). Authenticate it or run /${CONFIG_COMMAND} to pick another model.`,
		};
	}
	return { model: found as ChildModel };
}

function modelLabel(model: { provider: string; id: string; name?: string }): string {
	return `${model.provider}/${model.id}${model.name ? ` — ${model.name}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: EXPLORER_TOOL,
		label: "Explorer",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"What you need to locate, phrased precisely, plus what you intend to do with the answer. Self-contained: the explorer knows nothing about this conversation.",
			}),
			description: Type.Optional(
				Type.String({
					description: "Short 3-5 word label for this search, shown in the UI.",
				}),
			),
			resume_id: Type.Optional(
				Type.String({
					description:
						"Continue an existing explorer (id from a previous result) to dig deeper in an area it already mapped.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = resolveModel(ctx);
			if ("error" in resolved) {
				return textResult(`Explorer unavailable: ${resolved.error}`, {
					error: "explorer_model_unavailable",
				});
			}
			return runChildTool(
				params,
				{
					kind: "explorer",
					model: resolved.model,
					excludeTools: EXCLUDED_TOOLS,
					promptPrefix: PROMPT_PREFIX,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
		renderResult(result, _options, theme, context) {
			return renderChildResult(result, theme, context);
		},
	});

	if (inChildSession()) return;

	pi.registerCommand(CONFIG_COMMAND, {
		description: "Select the model used by the Explorer tool",
		handler: async (args, ctx) => {
			const models = ctx.modelRegistry
				.getAvailable()
				.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));

			const arg = args.trim();
			if (arg) {
				const [provider, ...rest] = arg.split("/");
				const id = rest.join("/");
				const found = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
				if (!found) {
					ctx.ui.notify(`No such model: "${arg}". Use provider/model-id, or run /${CONFIG_COMMAND} with no argument to pick from a list.`, "error");
					return;
				}
				writeConfig({ provider: found.provider, model: found.id });
				ctx.ui.notify(`Explorer model set to ${modelLabel(found)}.`, "info");
				return;
			}

			if (models.length === 0) {
				ctx.ui.notify("No authenticated models available to choose from.", "error");
				return;
			}
			const current = readConfig();
			const options = models.map(modelLabel);
			const title = current.model
				? `Explorer model (current: ${current.provider}/${current.model})`
				: "Explorer model — pick a cheap, fast one";
			const choice = await ctx.ui.select(title, options);
			if (!choice) return;
			const picked = models[options.indexOf(choice)];
			if (!picked) return;
			writeConfig({ provider: picked.provider, model: picked.id });
			ctx.ui.notify(`Explorer model set to ${modelLabel(picked)}.`, "info");
		},
	});

	// Say it early and once: an unconfigured explorer is a tool the agent cannot use.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const { provider, model } = readConfig();
		if (!provider || !model) ctx.ui.notify(UNSET_HINT, "warning");
	});
}
