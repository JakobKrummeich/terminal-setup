/**
 * rtk.ts: which bash commands are handed to `rtk rewrite` at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isRewriteCandidate } from "../rtk.ts";

test("isRewriteCandidate: non-empty commands not already prefixed with rtk; RTK_DISABLED=1 disables", () => {
	const saved = process.env.RTK_DISABLED;
	try {
		delete process.env.RTK_DISABLED;
		assert.equal(isRewriteCandidate("git status"), true);
		assert.equal(isRewriteCandidate("rtkx ls"), true, "only the `rtk ` prefix counts");
		assert.equal(isRewriteCandidate("rtk git status"), false);
		assert.equal(isRewriteCandidate("   "), false);
		assert.equal(isRewriteCandidate(""), false);
		assert.equal(isRewriteCandidate(undefined), false);
		assert.equal(isRewriteCandidate(42), false);
		process.env.RTK_DISABLED = "0";
		assert.equal(isRewriteCandidate("ls"), true);
		process.env.RTK_DISABLED = "1";
		assert.equal(isRewriteCandidate("ls"), false);
	} finally {
		if (saved === undefined) delete process.env.RTK_DISABLED;
		else process.env.RTK_DISABLED = saved;
	}
});
