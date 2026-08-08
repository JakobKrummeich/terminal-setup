/**
 * Explorer children: env-driven model/thinking resolution, the readonly tool
 * allowlist, and the per-group busy latch. The latch tests run runChildTool for
 * real — real createAgentSession, real session loop — with the model runtime's
 * streamSimple replaced by a scripted stream, so busy semantics are exercised
 * exactly as in production, minus the network.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Children resolve their config dir and session dir from the environment; point both
// at temp dirs so the tests never touch (or load extensions from) the live ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-explore-agentdir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = mkdtempSync(path.join(tmpdir(), "pi-explore-sessions-"));
// No remote model-catalog refresh: its keep-alive TLS sockets outlive the tests and
// hang the test process.
process.env.PI_OFFLINE = "1";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { initTheme, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as exploreModule from "../explore.ts";
import {
	EXPLORER_TOOLS,
	explorerModelsFile,
	loadExplorerCandidates,
	resolveExplorerConfig,
	resolveExplorerParallel,
} from "../explore.ts";
import {
	type ChildRecord,
	liveChildren,
	nextChild,
	resetChildState,
	runChildTool,
	watchTarget,
} from "../lib/child-session.ts";
import { sleep } from "./harness.ts";

// --- resolveExplorerConfig (pure) ---

const parentModel = getModel("anthropic", "claude-sonnet-4-5")!;
const fastModel = getModel("anthropic", "claude-haiku-4-5")!;

/** Registry stub: knows exactly one (provider, modelId) pair. */
const registryWith = (provider: string, modelId: string) => ({
	find: (p: string, m: string) => (p === provider && m === modelId ? fastModel : undefined),
});

/** Registry stub: maps "provider/modelId" specs to models. */
const registryOf = (models: Record<string, typeof fastModel>) => ({
	find: (p: string, m: string) => models[`${p}/${m}`],
});

test("resolveExplorerConfig: unset env → parent model, low thinking, no warnings", () => {
	const config = resolveExplorerConfig({}, registryWith("x", "y"), parentModel);
	assert.equal(config.model, parentModel);
	assert.equal(config.thinkingLevel, "low");
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: valid provider/modelId resolves", () => {
	const config = resolveExplorerConfig(
		{ PI_EXPLORER_MODEL: "anthropic/claude-haiku" },
		registryWith("anthropic", "claude-haiku"),
		parentModel,
	);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: unknown model → parent model + warnings", () => {
	const config = resolveExplorerConfig(
		{ PI_EXPLORER_MODEL: "nope/missing" },
		registryWith("anthropic", "claude-haiku"),
		parentModel,
	);
	assert.equal(config.model, parentModel);
	assert.equal(config.warnings.length, 2);
	assert.match(config.warnings[0], /PI_EXPLORER_MODEL "nope\/missing" not found/);
	assert.ok(config.warnings[1].includes(parentModel.id), "warning names the fallback model");
});

test("resolveExplorerConfig: splits on the first slash only (model ids may contain slashes)", () => {
	const config = resolveExplorerConfig(
		{ PI_EXPLORER_MODEL: "openrouter/org/model-v1" },
		registryWith("openrouter", "org/model-v1"),
		parentModel,
	);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: malformed spec (no slash) → parent model + warnings", () => {
	const config = resolveExplorerConfig({ PI_EXPLORER_MODEL: "justamodel" }, registryWith("x", "y"), parentModel);
	assert.equal(config.model, parentModel);
	assert.equal(config.warnings.length, 2);
});

// --- candidates list (explorer-models.json) ---

test("resolveExplorerConfig: first candidate present in the registry wins", () => {
	const registry = registryOf({ "anthropic/haiku": fastModel, "azure/gpt": parentModel });
	const config = resolveExplorerConfig({}, registry, parentModel, ["anthropic/haiku", "azure/gpt"]);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: unknown candidates are skipped, later one matches (per-machine registries)", () => {
	const registry = registryOf({ "azure/gpt": fastModel });
	const config = resolveExplorerConfig({}, registry, parentModel, ["anthropic/haiku", "azure/gpt"]);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: PI_EXPLORER_MODEL overrides candidates", () => {
	const registry = registryOf({ "env/pick": fastModel, "file/pick": parentModel });
	const config = resolveExplorerConfig({ PI_EXPLORER_MODEL: "env/pick" }, registry, parentModel, ["file/pick"]);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: broken PI_EXPLORER_MODEL falls back to a matching candidate", () => {
	const registry = registryOf({ "file/pick": fastModel });
	const config = resolveExplorerConfig({ PI_EXPLORER_MODEL: "nope/missing" }, registry, parentModel, ["file/pick"]);
	assert.equal(config.model, fastModel);
	assert.equal(config.warnings.length, 1, "env warning only — the candidate resolved");
	assert.match(config.warnings[0], /PI_EXPLORER_MODEL/);
});

test("resolveExplorerConfig: malformed candidate entries (empty, trailing slash) are skipped", () => {
	const registry = registryOf({ "ok/model": fastModel });
	const config = resolveExplorerConfig({}, registry, parentModel, ["", "noslash", "trailing/", "ok/model"]);
	assert.equal(config.model, fastModel);
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: no candidate matches → parent model + warnings", () => {
	const config = resolveExplorerConfig({}, registryOf({}), parentModel, ["a/b", "c/d"]);
	assert.equal(config.model, parentModel);
	assert.equal(config.warnings.length, 2);
	assert.match(config.warnings[0], /no explorer-models\.json candidate found \(a\/b, c\/d\)/);
	assert.ok(config.warnings[1].includes(parentModel.id), "warning names the fallback model");
});

// --- loadExplorerCandidates (file parsing) ---

const candidatesDir = mkdtempSync(path.join(tmpdir(), "pi-explore-candidates-"));
const candidatesFile = (name: string, content: string) => {
	const file = path.join(candidatesDir, name);
	writeFileSync(file, content);
	return file;
};

test("explorerModelsFile: honors PI_CODING_AGENT_DIR, falls back to ~/.pi/agent", () => {
	assert.equal(explorerModelsFile({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/extensions/explorer-models.json");
	assert.ok(explorerModelsFile({}).endsWith("/.pi/agent/extensions/explorer-models.json"));
});

test("loadExplorerCandidates: missing file → empty list, no warnings (feature off)", () => {
	const result = loadExplorerCandidates(path.join(candidatesDir, "does-not-exist.json"));
	assert.deepEqual(result, { candidates: [], warnings: [] });
});

test("loadExplorerCandidates: valid file → candidates, no warnings", () => {
	const file = candidatesFile("valid.json", '{ "candidates": ["anthropic/haiku", "azure/gpt"] }');
	assert.deepEqual(loadExplorerCandidates(file), {
		candidates: ["anthropic/haiku", "azure/gpt"],
		warnings: [],
	});
});

test("loadExplorerCandidates: empty candidates list (the committed default) → no warnings", () => {
	const file = candidatesFile("empty.json", '{ "candidates": [] }');
	assert.deepEqual(loadExplorerCandidates(file), { candidates: [], warnings: [] });
});

test("loadExplorerCandidates: JSON null is valid JSON but wrong shape → shape warning, not JSON warning", () => {
	const file = candidatesFile("null.json", "null");
	const result = loadExplorerCandidates(file);
	assert.deepEqual(result.candidates, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /expected \{ "candidates": string\[\] \}/);
});

test("loadExplorerCandidates: invalid JSON → ignored with warning", () => {
	const file = candidatesFile("broken.json", "{ not json");
	const result = loadExplorerCandidates(file);
	assert.deepEqual(result.candidates, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /not valid JSON/);
});

test("loadExplorerCandidates: wrong shape → ignored with warning", () => {
	const file = candidatesFile("shape.json", '{ "candidates": [1, 2] }');
	const result = loadExplorerCandidates(file);
	assert.deepEqual(result.candidates, []);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /expected \{ "candidates": string\[\] \}/);
});

test("resolveExplorerConfig: valid thinking level honored", () => {
	const config = resolveExplorerConfig({ PI_EXPLORER_THINKING: "high" }, registryWith("x", "y"), parentModel);
	assert.equal(config.thinkingLevel, "high");
	assert.deepEqual(config.warnings, []);
});

test("resolveExplorerConfig: invalid thinking level → low + warning", () => {
	const config = resolveExplorerConfig({ PI_EXPLORER_THINKING: "ultra" }, registryWith("x", "y"), parentModel);
	assert.equal(config.thinkingLevel, "low");
	assert.equal(config.warnings.length, 1);
	assert.match(config.warnings[0], /PI_EXPLORER_THINKING "ultra"/);
});

// --- resolveExplorerParallel (pure) ---

test("resolveExplorerParallel: unset → 3; valid values honored; junk and non-positive → 3", () => {
	assert.equal(resolveExplorerParallel({}), 3);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "5" }), 5);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "1" }), 1);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "0" }), 3);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "-2" }), 3);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "2.5" }), 3);
	assert.equal(resolveExplorerParallel({ PI_EXPLORER_PARALLEL: "garbage" }), 3);
});

// --- busy groups + explorer tool set (real runChildTool, scripted LLM) ---

/**
 * Fake ExtensionContext whose model runtime streams a scripted response instead of
 * hitting the network. Prompts containing "SLOW-TASK" answer after `slowMs`; everything
 * else answers fast — that keeps one child in-flight while another runs.
 */
async function makeCtx(slowMs: number): Promise<ExtensionContext> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-explore-cwd-"));
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
	});
	runtime.setRuntimeApiKey("anthropic", "test-key-not-used");
	(runtime as unknown as { streamSimple: unknown }).streamSimple = (m: any, context: any) => {
		const stream = createAssistantMessageEventStream();
		const slow = JSON.stringify(context?.messages ?? "").includes("SLOW-TASK");
		void (async () => {
			const output: any = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			await sleep(slow ? slowMs : 30);
			output.content = [{ type: "text", text: slow ? "slow child done" : "fast child done" }];
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		})();
		return stream;
	};
	return {
		cwd: dir,
		model: parentModel,
		thinkingLevel: "off",
		modelRegistry: { runtime, find: () => undefined, isUsingOAuth: () => false },
	} as unknown as ExtensionContext;
}

const AGENT_OPTIONS = { kind: "agent", busyGroup: "agent", excludeTools: ["Agent"] };
const EXPLORER_OPTIONS = {
	kind: "explorer",
	busyGroup: "explorer",
	tools: [...EXPLORER_TOOLS],
	excludeTools: [],
};

/** Child sessions hold open handles; drop them or the test process never exits. */
function disposeChildren() {
	for (const record of liveChildren.values()) record.session.dispose();
	liveChildren.clear();
}

// --- F2 watch cycling (pure: fake records, no sessions) ---

const fakeRecord = (id: string, running: boolean) =>
	({ id, running, session: { dispose() {} } }) as unknown as ChildRecord;

test("watchTarget cycles ALL children in spawn order; unset cursor starts at first running", () => {
	resetChildState();
	for (const r of [fakeRecord("a", false), fakeRecord("b", true), fakeRecord("c", false)])
		liveChildren.set(r.id, r);
	assert.equal(watchTarget()?.id, "b", "unset cursor must start at the first running child");
	assert.equal(watchTarget()?.id, "c", "finished children are part of the cycle");
	assert.equal(watchTarget()?.id, "a", "cycle wraps in insertion order");
	assert.equal(watchTarget()?.id, "b");
	// Cursor's child evicted → restart at the first running child.
	liveChildren.delete("b");
	liveChildren.set("d", fakeRecord("d", true));
	assert.equal(watchTarget()?.id, "d", "gone cursor must restart at a running child");
	// nextChild (in-view cycling) advances from an explicit id and moves the shared cursor.
	assert.equal(nextChild("a")?.id, "c");
	assert.equal(watchTarget()?.id, "d", "outer F2 must continue from the in-view cursor");
	resetChildState();
});

test("watchTarget with no running children falls back to the most recent, then cycles", () => {
	resetChildState();
	liveChildren.set("a", fakeRecord("a", false));
	liveChildren.set("b", fakeRecord("b", false));
	assert.equal(watchTarget()?.id, "b", "all finished → most recent child first");
	assert.equal(watchTarget()?.id, "a", "then wraps through the rest");
	assert.equal(watchTarget()?.id, "b");
	assert.equal(nextChild("zzz-gone")?.id, "a", "unknown id falls back to the first child");
	resetChildState();
});

const resultText = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";
const isBusyError = (result: { details?: unknown }) =>
	(result.details as { error?: string } | undefined)?.error === "child_busy";

test("busy groups are independent: an explorer runs while an agent child runs, and vice versa", async () => {
	const ctx = await makeCtx(1500);
	const agentPromise = runChildTool(
		{ prompt: "SLOW-TASK keep working", description: "slow agent" },
		AGENT_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	// Agent group is latched synchronously; a second agent call must be rejected …
	const secondAgent = await runChildTool(
		{ prompt: "another agent task", description: "queued agent" },
		AGENT_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(secondAgent), true, "same group must serialize");
	assert.match(resultText(secondAgent), /agent is already running/);
	// … but an explorer lives in its own group and must run to completion.
	const explorer = await runChildTool(
		{ prompt: "quick lookup", description: "lookup" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(explorer), false, "explorer must not see the agent latch");
	assert.match(resultText(explorer), /fast child done/);
	const agent = await agentPromise;
	assert.equal(isBusyError(agent), false);
	assert.match(resultText(agent), /slow child done/);
	disposeChildren();
});

test("two explorers serialize; a slow explorer does not block an agent child", async () => {
	const ctx = await makeCtx(1500);
	const firstPromise = runChildTool(
		{ prompt: "SLOW-TASK explore everything", description: "slow explorer" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	const second = await runChildTool(
		{ prompt: "another lookup", description: "queued explorer" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(second), true, "explorers must serialize within their group");
	assert.match(resultText(second), /explorer is already running/);
	const agent = await runChildTool(
		{ prompt: "agent task", description: "agent" },
		AGENT_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(agent), false, "agent must not see the explorer latch");
	await firstPromise;
	disposeChildren();
});

test("promptPrefix reaches the session but the watch view shows only the task", async () => {
	const ctx = await makeCtx(50);
	initTheme(undefined, false); // rendering components needs a theme; no watcher, or the process never exits
	const result = await runChildTool(
		{ prompt: "tiny task", description: "prefix check" },
		{ ...EXPLORER_OPTIONS, promptPrefix: "SLOW-TASK CONTRACTMARKER" },
		undefined,
		undefined,
		ctx,
	);
	// "SLOW-TASK" appears only in the prefix; the scripted stream answers
	// "slow child done" only when it sees it — proof the prefix reached the model.
	assert.match(resultText(result), /slow child done/);
	const record = [...liveChildren.values()].find((r) => r.description === "prefix check");
	assert.ok(record, "child record must exist");
	const rendered = record.view.render(120).join("\n");
	assert.match(rendered, /tiny task/, "view shows the task");
	assert.doesNotMatch(rendered, /CONTRACTMARKER/, "view must not show the contract prefix");
	disposeChildren();
});

test("child-session state is shared across module copies (jiti moduleCache: false)", async () => {
	// pi's loader gives every extension file its own jiti instance, so subagent.ts and
	// explore.ts import independent copies of lib/child-session.ts. A distinct import URL
	// reproduces that: same file, separate ESM module instance.
	const copy2 = (await import("../lib/child-session.ts?copy2" as string)) as typeof import("../lib/child-session.ts");
	assert.notEqual(copy2.runChildTool, runChildTool, "the trick must yield a distinct module instance");
	assert.equal(copy2.liveChildren, liveChildren, "liveChildren must be one shared Map (F2 watch, shutdown clear)");
	// The busy latch must be shared too: a child started through one copy must latch
	// the group for the other (parent latches via subagent.ts, child checks via its own).
	const ctx = await makeCtx(1500);
	const firstPromise = runChildTool(
		{ prompt: "SLOW-TASK explore", description: "slow explorer" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	const viaCopy2 = await copy2.runChildTool(
		{ prompt: "lookup", description: "copy2 explorer" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(viaCopy2), true, "copy2 must see copy1's explorer latch");
	// The record lands in liveChildren only after the child session is created — the
	// latch is synchronous, the record is not — so poll briefly instead of racing it.
	let target: ReturnType<typeof copy2.watchTarget>;
	for (let i = 0; i < 100 && !(target = copy2.watchTarget())?.running; i++) await sleep(20);
	assert.ok(target?.running, "copy2's watch must find copy1's running child");
	await firstPromise;
	disposeChildren();
});

/** Explorer options as explore.ts builds them for a concurrency-N run. */
const parallelOptions = (limit: number) => ({
	...EXPLORER_OPTIONS,
	concurrency: limit,
	busyMessage: `${limit} explorers are already running — the limit (PI_EXPLORER_PARALLEL, default 3). Wait for one to finish, then call again.`,
});

test("explorer semaphore: two run concurrently at limit 2, third is rejected, slot frees on finish", async () => {
	const ctx = await makeCtx(1500);
	const options = parallelOptions(2);
	const first = runChildTool(
		{ prompt: "SLOW-TASK one", description: "slow one" },
		options,
		undefined,
		undefined,
		ctx,
	);
	const second = runChildTool(
		{ prompt: "SLOW-TASK two", description: "slow two" },
		options,
		undefined,
		undefined,
		ctx,
	);
	// Both slots are taken synchronously, so a third call — even in the same tick — is over the limit.
	const third = await runChildTool(
		{ prompt: "one too many", description: "third" },
		options,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(third), true, "third explorer must be rejected at limit 2");
	assert.match(resultText(third), /limit/);
	assert.match(resultText(third), /PI_EXPLORER_PARALLEL/);
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(isBusyError(firstResult), false, "first of two concurrent explorers must run");
	assert.equal(isBusyError(secondResult), false, "second of two concurrent explorers must run");
	// Slots are free again: a follow-up call proceeds.
	const fourth = await runChildTool(
		{ prompt: "after the rush", description: "fourth" },
		options,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(fourth), false, "slot must be released after a child finishes");
	disposeChildren();
});

test("concurrent explorers do not cross-wire: each result carries its own child's id and text", async () => {
	const ctx = await makeCtx(1000);
	const options = parallelOptions(2);
	const [slow, fast] = await Promise.all([
		runChildTool({ prompt: "SLOW-TASK deep dive", description: "slow dive" }, options, undefined, undefined, ctx),
		runChildTool({ prompt: "quick lookup", description: "quick look" }, options, undefined, undefined, ctx),
	]);
	assert.match(resultText(slow), /slow child done/);
	assert.match(resultText(fast), /fast child done/);
	const slowMeta = slow.details as { id?: string };
	const fastMeta = fast.details as { id?: string };
	assert.ok(slowMeta.id && fastMeta.id, "both results carry child ids");
	assert.notEqual(slowMeta.id, fastMeta.id, "concurrent explorers must not share an id");
	assert.equal(liveChildren.get(slowMeta.id!)?.description, "slow dive");
	assert.equal(liveChildren.get(fastMeta.id!)?.description, "quick look");
	disposeChildren();
});

test("resuming a still-running explorer is rejected instead of double-prompting its session", async () => {
	const ctx = await makeCtx(1500);
	const options = parallelOptions(2);
	const firstPromise = runChildTool(
		{ prompt: "SLOW-TASK long haul", description: "slow haul" },
		options,
		undefined,
		undefined,
		ctx,
	);
	// The id lands in liveChildren only after the child session is created; poll for it.
	let id: string | undefined;
	for (let i = 0; i < 100 && !id; i++) {
		id = [...liveChildren.values()].find((r) => r.running)?.id;
		if (!id) await sleep(20);
	}
	assert.ok(id, "running child must appear in liveChildren");
	const resumed = await runChildTool(
		{ prompt: "follow-up too early", resume_id: id },
		options,
		undefined,
		undefined,
		ctx,
	);
	assert.equal((resumed.details as { error?: string }).error, "child_running");
	assert.match(resultText(resumed), /still running/);
	const first = await firstPromise;
	assert.equal(isBusyError(first), false, "the running child must be unaffected");
	assert.match(resultText(first), /slow child done/);
	// The rejected resume released its slot: a fresh call proceeds.
	const fresh = await runChildTool(
		{ prompt: "fresh lookup", description: "fresh" },
		options,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(isBusyError(fresh), false, "rejected resume must not leak a semaphore slot");
	disposeChildren();
});

test("old finished children are evicted beyond the cap; running children survive", async () => {
	const ctx = await makeCtx(8000);
	const options = parallelOptions(2);
	// The slow child is the oldest map entry — running children must never be evicted.
	const slowPromise = runChildTool(
		{ prompt: "SLOW-TASK stay busy", description: "long runner" },
		options,
		undefined,
		undefined,
		ctx,
	);
	const fastIds: string[] = [];
	for (let i = 0; i < 11; i++) {
		const result = await runChildTool(
			{ prompt: `lookup ${i}`, description: `fast ${i}` },
			options,
			undefined,
			undefined,
			ctx,
		);
		assert.equal(isBusyError(result), false, `fast child ${i} must run`);
		fastIds.push((result.details as { id: string }).id);
	}
	// The cap is 8 finished children, checked on each fresh spawn: spawning fast
	// child 9 saw 9 finished (0..8) and evicted fastIds[0]; child 10 evicted fastIds[1].
	assert.ok(!liveChildren.has(fastIds[0]), "oldest finished child must be evicted");
	assert.ok(!liveChildren.has(fastIds[1]), "second-oldest finished child must be evicted");
	for (const id of fastIds.slice(2)) {
		assert.ok(liveChildren.has(id), `recent finished child ${id} must be kept`);
	}
	const running = [...liveChildren.values()].filter((r) => r.running);
	assert.equal(running.length, 1, "the running child must survive eviction despite being oldest");
	// Evicted ids fall back to the existing unknown-resume error.
	const resumed = await runChildTool(
		{ prompt: "follow-up", resume_id: fastIds[0] },
		options,
		undefined,
		undefined,
		ctx,
	);
	assert.equal((resumed.details as { error?: string }).error, "unknown_resume_id");
	assert.match(resultText(resumed), /No live explorer session/);
	const slow = await slowPromise;
	assert.equal(isBusyError(slow), false, "the running child must be unaffected by evictions");
	assert.match(resultText(slow), /slow child done/);
	disposeChildren();
});

test("explorer child gets exactly the readonly allowlist", async () => {
	const ctx = await makeCtx(0);
	const result = await runChildTool(
		{ prompt: "what tools do I have", description: "tool check" },
		EXPLORER_OPTIONS,
		undefined,
		undefined,
		ctx,
	);
	const meta = result.details as { id?: string };
	assert.ok(meta.id, "result carries the child id");
	const record = liveChildren.get(meta.id!);
	assert.ok(record, "child record is live");
	const active = record!.session.getActiveToolNames().sort();
	// context_handoff is an extension tool; the temp agent dir has no extensions, so
	// only the builtin part of the allowlist can materialize here. The wiring under
	// test is that the allowlist reaches createAgentSession — mutating tools gone.
	assert.deepEqual(active, ["find", "grep", "ls", "read"]);
	for (const name of ["bash", "edit", "write", "Agent", "Explore"]) {
		assert.ok(!active.includes(name), `${name} must not be active in an explorer`);
	}
	disposeChildren();
});

test("config warnings prepend to success results but not to error results", async () => {
	const ctx = await makeCtx(0);
	// makeCtx's registry finds nothing, so this spec guarantees a config warning.
	process.env.PI_EXPLORER_MODEL = "nope/missing";
	try {
		let tool: any;
		// This test dir is ESM ("type": "module") but ../explore.ts is checked as CJS,
		// so tsc sees the default export behind an interop wrapper while node's ESM
		// runtime hands it over directly. Unwrap whichever shape shows up.
		type ExploreExtensionFn = (pi: { registerTool: (t: unknown) => void }) => void;
		const d = (exploreModule as unknown as { default: ExploreExtensionFn | { default: ExploreExtensionFn } })
			.default;
		const exploreExtension = typeof d === "function" ? d : d.default;
		exploreExtension({ registerTool: (t: unknown) => (tool = t) });
		const errored = await tool.execute(
			"call-1",
			{ prompt: "follow-up", resume_id: "no-such-id" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(errored.isError, true);
		assert.ok(!resultText(errored).includes("[explorer]"), "error results must not carry config warnings");
		const ok = await tool.execute(
			"call-2",
			{ prompt: "lookup", description: "warn check" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(resultText(ok), /^\[explorer\] PI_EXPLORER_MODEL "nope\/missing" not found/);
		assert.match(resultText(ok), /fast child done/);
	} finally {
		delete process.env.PI_EXPLORER_MODEL;
		disposeChildren();
	}
});
