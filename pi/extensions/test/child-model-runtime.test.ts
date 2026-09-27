/**
 * lib/child-session.ts parentModelRuntime reads ModelRegistry's PRIVATE
 * `runtime` field so children share the parent's ModelRuntime (runtime-only
 * credentials such as `pi --api-key`). Nothing in pi's types guards that field:
 * this test takes the registry pi really hands extensions (ctx.modelRegistry)
 * and fails loudly if a pi update renames or hides it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parentModelRuntime } from "../lib/child-session.ts";
import { createTestSession, textStep } from "./harness.ts";

const CAPTURE_KEY = "terminal-setup.test.captured-model-registry";

/** An extension that stashes the ctx.modelRegistry pi gives it (a separate jiti module copy → globalThis). */
function writeCaptureExtension(): string {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "pi-modelruntime-ext-")), "capture.ts");
	writeFileSync(
		file,
		`export default function (pi) {
	pi.on("before_agent_start", (_event, ctx) => {
		globalThis[Symbol.for(${JSON.stringify(CAPTURE_KEY)})] = ctx.modelRegistry;
	});
}
`,
	);
	return file;
}

test("parentModelRuntime: pi's ctx.modelRegistry exposes the session's ModelRuntime", async () => {
	const t = await createTestSession({ extensionPaths: [writeCaptureExtension()], script: [textStep("ok")] });
	try {
		await t.session.prompt("hi");
		const modelRegistry = (globalThis as Record<symbol, unknown>)[Symbol.for(CAPTURE_KEY)];
		assert.ok(modelRegistry, "precondition: the capture extension saw ctx.modelRegistry");
		const runtime = parentModelRuntime({ modelRegistry } as Parameters<typeof parentModelRuntime>[0]);
		assert.ok(runtime !== undefined, "ModelRegistry's private `runtime` field is gone — children lose the parent's runtime");
		assert.equal(runtime, t.modelRuntime, "must be the very runtime the parent session was created with");
	} finally {
		delete (globalThis as Record<symbol, unknown>)[Symbol.for(CAPTURE_KEY)];
		t.dispose();
	}
});
