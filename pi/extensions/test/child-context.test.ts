/**
 * lib/child-context.ts: the child-session ALS scope must be ONE instance across
 * module copies. pi loads every extension file with its own jiti instance
 * (moduleCache: false): child-session.ts enters the scope through its copy, while
 * wsstate.ts / timer.ts / … read inChildSession() through theirs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { childSessionInfo, inChildSession, runInChildSession } from "../lib/child-context.ts";

test("child-context: a scope entered via one module copy is visible to another", async () => {
	// A distinct import URL reproduces pi's per-extension copy: same file, separate module instance.
	const copy2 = (await import("../lib/child-context.ts?copy2" as string)) as typeof import("../lib/child-context.ts");
	assert.notEqual(copy2.inChildSession, inChildSession, "the trick must yield a distinct module instance");
	assert.equal(copy2.inChildSession(), false, "outside any child");
	const info = { kind: "agent", contract: "C" };
	const seen = await runInChildSession(info, async () => {
		await Promise.resolve(); // across an await, as during a child's extension load
		return { inChild: copy2.inChildSession(), info: copy2.childSessionInfo() };
	});
	assert.deepEqual(seen, { inChild: true, info });
	assert.equal(inChildSession(), false, "the scope ends with the callback");
	assert.equal(childSessionInfo(), undefined);
});
