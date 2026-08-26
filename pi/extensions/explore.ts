import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ChildModel,
	type ChildThinkingLevel,
	EXPLORE_TOOL,
	renderChildResult,
	runChildTool,
} from "./lib/child-session.ts";
import { CONTEXT_CAP_TOOL_NAME } from "./lib/env.ts";

const TOOL_DESCRIPTION = `Delegate readonly exploration to a fast, cheap agent that reports back.

Use it for questions about the codebase — "where is X handled", "how does Y work",
"summarize this subsystem", lookups across many files. Prefer it over reading many files
yourself: it keeps your own context small. Delegated agents have it too. The explorer can
only read, grep, find and ls: never send it a task that needs command execution or mutation.

It has no memory of this conversation and only its final message comes back: make the prompt
self-contained and ask for everything you need in that one reply — paths, line numbers, the
specific facts.

Several Explore calls in ONE assistant message run in parallel (up to a limit, default 3) —
fan out for independent lookups instead of asking one explorer several unrelated questions.
Calls beyond the limit are rejected; retry after one finishes. For follow-up questions, call
again with resume_id set to the id in the result, which continues that session with its
context intact.`;

// Appended to an explorer child's system prompt on every turn. Same idea as CHILD_CONTRACT
// in subagent.ts, but for a readonly child whose report feeds another agent. The injection
// itself happens in subagent.ts's before_agent_start handler — the single registration
// point for all child kinds (see the comment there); this file only supplies the text.
const EXPLORER_CONTRACT = `You are a readonly explorer agent. Your final message is the only thing the
caller sees, and the caller is another agent, not a human. Response-length limits from the system
prompt do not apply to it.

- You have only read, grep, find and ls. You cannot edit, write or run commands.
- Answer the question directly, with absolute paths, line numbers and load-bearing snippets.
- Be dense and complete, but do not pad.
- Do not speculate beyond what you read — say explicitly what you could not determine.

Structure the final message as:
1. Findings — specific: paths, line numbers, snippets.
2. Summary: one sentence the caller can relay.`;

// grep/find/ls are pi builtins the allowlist activates; context_handoff keeps the
// context-cap machinery working. An allowlist
// enables only what it lists, so bash/edit/write and Agent/Explore are structurally out.
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls", CONTEXT_CAP_TOOL_NAME] as const;

const THINKING_LEVELS: readonly ChildThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Max concurrent explorers from PI_EXPLORER_PARALLEL. Default 3; anything that is
 * not an integer >= 1 (garbage, "0", negatives) falls back to 3. Read per call, not
 * at module load, so the env can change under a running session (and under tests).
 */
export function resolveExplorerParallel(env: NodeJS.ProcessEnv): number {
	const raw = env.PI_EXPLORER_PARALLEL;
	if (!raw) return 3;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 3;
}

export interface ExplorerConfig {
	model: ChildModel | undefined;
	thinkingLevel: ChildThinkingLevel;
	warnings: string[];
	parentFallbackWarning: string | undefined;
}

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "find">;

const EXPLORER_CONFIG_PATH = "~/.pi/agent/extensions/explorer-models.json";
const EXPLORER_SETUP_DOC = "docs/explorer-setup.md";

function parentFallbackWarning(parentModel: ChildModel | undefined): string {
	const model = parentModel ? `${parentModel.provider}/${parentModel.id}` : "(none)";
	return `[explorer] WARNING: no dedicated explorer model configured; using parent model ${model}. Set PI_EXPLORER_MODEL=provider/modelId or create ${EXPLORER_CONFIG_PATH}. See ${EXPLORER_SETUP_DOC}.`;
}

/**
 * Machine-local model preference list. Do not commit this file: providers and
 * credentials differ by environment. Schema: { "candidates": ["provider/modelId", ...] };
 * first candidate present in local model registry wins.
 *
 * Resolved through agent dir, not import.meta (tsconfig checks these files as CJS,
 * where import.meta is syntax error). PI_CODING_AGENT_DIR is same override pi honors.
 */
export function explorerModelsFile(env: NodeJS.ProcessEnv): string {
	// `||` not `??`: pi's own getAgentDir treats an empty env var as unset.
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "extensions", "explorer-models.json");
}

/** Look up a "provider/modelId" spec. Split on the first slash only: ids may contain slashes. */
function findModelSpec(spec: string, registry: ModelRegistry): ChildModel | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0) return undefined;
	return registry.find(spec.slice(0, slash), spec.slice(slash + 1)) ?? undefined;
}

/** First candidate spec present in the registry, in list order. */
function findFirstCandidate(candidates: readonly string[], registry: ModelRegistry): ChildModel | undefined {
	for (const candidate of candidates) {
		const found = findModelSpec(candidate, registry);
		if (found) return found;
	}
	return undefined;
}

export interface ExplorerCandidates {
	candidates: string[];
	warnings: string[];
}

/**
 * Load candidate list from JSON file. Missing file means no dedicated model is
 * configured; resolver emits loud parent-model fallback warning. Broken file is
 * ignored with warning, so typo never breaks tool.
 */
export function loadExplorerCandidates(filePath: string): ExplorerCandidates {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return { candidates: [], warnings: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { candidates: [], warnings: [`[explorer] ${filePath} is not valid JSON; ignoring file`] };
	}
	// The null check matters: JSON `null` parses fine but has no properties.
	const candidates =
		typeof parsed === "object" && parsed !== null ? (parsed as { candidates?: unknown }).candidates : undefined;
	if (Array.isArray(candidates) && candidates.every((c) => typeof c === "string")) {
		return { candidates, warnings: [] };
	}
	return {
		candidates: [],
		warnings: [`[explorer] ${filePath}: expected { "candidates": string[] }; ignoring file`],
	};
}

/**
 * Resolve explorer model and thinking level.
 *
 * Model precedence: PI_EXPLORER_MODEL env var → first `candidates` entry found in
 * the registry → parent model. Config errors never fail the tool: bad values fall
 * back and surface as warning lines prepended to the tool result.
 */
export function resolveExplorerConfig(
	env: NodeJS.ProcessEnv,
	registry: ModelRegistry,
	parentModel: ChildModel | undefined,
	candidates: readonly string[] = [],
): ExplorerConfig {
	const warnings: string[] = [];
	let model: ChildModel | undefined;
	let parentFallback: string | undefined;
	const modelSpec = env.PI_EXPLORER_MODEL;
	if (modelSpec) {
		model = findModelSpec(modelSpec, registry);
		if (!model) warnings.push(`[explorer] PI_EXPLORER_MODEL "${modelSpec}" not found`);
	}
	if (!model && candidates.length > 0) {
		model = findFirstCandidate(candidates, registry);
		if (!model) warnings.push(`[explorer] no explorer-models.json candidate found (${candidates.join(", ")})`);
	}
	if (!model) {
		parentFallback = parentFallbackWarning(parentModel);
		warnings.push(parentFallback);
		model = parentModel;
	}
	// Explorers should be fast regardless of the parent's level, so the default is
	// "low", not ctx.thinkingLevel. createAgentSession clamps to model capabilities.
	let thinkingLevel: ChildThinkingLevel = "low";
	const levelSpec = env.PI_EXPLORER_THINKING;
	if (levelSpec) {
		if ((THINKING_LEVELS as readonly string[]).includes(levelSpec)) {
			thinkingLevel = levelSpec as ChildThinkingLevel;
		} else {
			warnings.push(`[explorer] PI_EXPLORER_THINKING "${levelSpec}" is not a thinking level; using "low"`);
		}
	}
	return { model, thinkingLevel, warnings, parentFallbackWarning: parentFallback };
}

export default function (pi: ExtensionAPI) {
	// Kill-switch for benchmark runs (context-cap impact study, ~/context-cap-study/plan.html):
	// non-empty PI_EXPLORE_DISABLE registers nothing — main and child sessions alike.
	if (process.env.PI_EXPLORE_DISABLE) return;

	// Registered in child sessions too, deliberately: that is how subagents get it.
	pi.registerTool({
		name: EXPLORE_TOOL,
		label: "Explore",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The self-contained question or exploration brief — or, with resume_id, your follow-up question.",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Short 3-5 word label for this exploration, shown in the UI. Always pass it for a new explorer; on resume it is optional.",
				}),
			),
			resume_id: Type.Optional(
				Type.String({
					description:
						"Continue an existing explorer session (id from a previous result) instead of starting a new one.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Re-read the candidates file per call so edits apply without a pi restart.
			const fileConfig = loadExplorerCandidates(explorerModelsFile(process.env));
			const config = resolveExplorerConfig(process.env, ctx.modelRegistry, ctx.model, fileConfig.candidates);
			config.warnings.unshift(...fileConfig.warnings);
			if (config.parentFallbackWarning) {
				ctx.ui.notify(config.parentFallbackWarning, "warning");
			}
			const parallel = resolveExplorerParallel(process.env);
			const result = await runChildTool(
				params,
				{
					kind: "explorer",
					busyGroup: "explorer",
					concurrency: parallel,
					busyMessage: `${parallel} explorers are already running — the limit (PI_EXPLORER_PARALLEL, default 3). Wait for one to finish, then call again.`,
					tools: [...EXPLORER_TOOLS],
					excludeTools: [],
					model: config.model,
					thinkingLevel: config.thinkingLevel,
					contract: EXPLORER_CONTRACT,
				},
				signal,
				onUpdate,
				ctx,
			);
			// Error results (busy rejection, unknown resume_id) already carry their own
			// message — gluing config warnings onto them is noise, so skip those.
			if (config.warnings.length > 0 && !result.isError && result.content[0]?.type === "text") {
				result.content[0].text = `${config.warnings.join("\n")}\n\n${result.content[0].text}`;
			}
			return result;
		},
		renderResult(result, _options, theme, context) {
			return renderChildResult(result, theme, context);
		},
	});
}
