/**
 * Prompt-cache safety of the handoff cycle: the tool declarations sit at the
 * front of the cached prefix, so a ~260k-token request whose tool list changed
 * is re-billed in full. `context_handoff` is therefore always active
 * (lib/context-cap-tool.ts says why lazy activation is not cache-safe here):
 * this pins that every request of a full soft cycle — before the cap, the
 * demand turn, the tool turn, the post-swap turn and a later prompt — declares
 * byte-identical tools.
 *
 * Payloads come from pi-ai's REAL provider builders (`onPayload` probe, aborted
 * before any network I/O), fed with exactly the model + context the agent loop
 * hands the provider. caveman-prompt.ts is loaded because it is in the live
 * setup and changes how pi lays out the system messages.
 */

process.env.CONTEXT_CAP_SOFT = "100";
process.env.CONTEXT_CAP_HARD = "1000";

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { SWAP_MARKER_TYPE } from "../lib/message-types.ts";
import { createTestSession, textStep, toolStep } from "./harness.ts";

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type ProviderStream = (model: any, context: any, options: any) => { result(): Promise<unknown> };

const PROBE_STOP = "payload captured";

/** Run one full soft cycle and return every provider payload, in request order. */
async function cyclePayloads(model: [string, string], providerStream: ProviderStream): Promise<any[]> {
	const payloads: any[] = [];
	const probes: Promise<unknown>[] = [];
	const t = await createTestSession({
		extensionPaths: ["context-cap.ts", "builtin-tools.ts", "caveman-prompt.ts"].map((f) => path.join(EXT_DIR, f)),
		tools: ["context_handoff", "ls"],
		model,
		llmDelayMs: 5,
		onLlmCall: (m, context) => {
			const onPayload = (payload: unknown) => {
				payloads.push(JSON.parse(JSON.stringify(payload)));
				throw new Error(PROBE_STOP);
			};
			probes.push(providerStream(m, context, { apiKey: "test-key-not-used", onPayload }).result());
		},
		script: [
			toolStep("t1", "ls", {}, 50),
			toolStep("t2", "ls", {}, 110), // crosses the soft cap mid-tool-use → demand at turn_end
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nkeep going" }, 112), // → swap
			textStep("post-swap turn", 5),
			textStep("next prompt", 6),
		],
	});
	try {
		await t.session.prompt("start");
		await t.session.prompt("again");
		await Promise.all(probes);
		const branch = t.session.sessionManager.getBranch();
		assert.ok(
			branch.some((e: any) => e.type === "custom_message" && e.customType === SWAP_MARKER_TYPE),
			"the cycle must actually swap",
		);
		return payloads;
	} finally {
		t.dispose();
	}
}

test("anthropic claude-opus-5-5: top-level tools byte-identical across a full soft cycle", async () => {
	const payloads = await cyclePayloads(["anthropic", "claude-opus-5-5"], anthropicStream as ProviderStream);
	assert.equal(payloads.length, 5, "one payload per LLM request");
	const first = JSON.stringify(payloads[0].tools);
	assert.ok(first.includes('"context_handoff"'), "the tool is declared from the first request on");
	payloads.forEach((p, i) => assert.equal(JSON.stringify(p.tools), first, `request ${i} changed the tool list`));
});

test("openai gpt-6-luna: head additional_tools item byte-identical across a full soft cycle", async () => {
	const payloads = await cyclePayloads(["openai", "gpt-6-luna"], responsesStream as ProviderStream);
	assert.equal(payloads.length, 5, "one payload per LLM request");
	const head = JSON.stringify(payloads[0].input[0]);
	assert.ok(head.includes('"additional_tools"') && head.includes('"context_handoff"'), "tools ride the head item");
	payloads.forEach((p, i) => {
		assert.equal(JSON.stringify(p.input[0]), head, `request ${i} changed the head tools item`);
		assert.equal(JSON.stringify(p.tools), JSON.stringify(payloads[0].tools), `request ${i} changed top-level tools`);
	});
});
