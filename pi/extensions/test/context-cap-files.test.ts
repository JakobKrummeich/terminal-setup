/**
 * lib/context-cap-files.ts: the on-disk naming of handoff files
 * (<sessionId>-<seq>.md) and their frontmatter. latestPath is the hard-cap
 * fallback (context-cap-hard.ts), so a wrong pick injects ANOTHER session's or
 * an older handoff into the successor's context; nextPath picks the cycle's
 * write target. The end-to-end context-cap-*.test.ts files only ever see seq 1
 * of one session, so the cases pinned here — numeric (not lexicographic) seq
 * order past 9, session ids that prefix each other, a lone markdown hr at the
 * top of a body — were unguarded.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { contextCapDir } from "../lib/agent-dir.ts";
import { fileSeq, latestPath, nextPath, stripFrontmatter, writeHandoff } from "../lib/context-cap-files.ts";

/** Runs `fn` with PI_CODING_AGENT_DIR on a fresh temp dir; returns the context-cap dir. */
function withAgentDir(fn: (capDir: string) => void): void {
	const saved = process.env.PI_CODING_AGENT_DIR;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-"));
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		fn(contextCapDir());
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function touch(dir: string, ...names: string[]): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

test("fileSeq: only <sessionId>-<digits>.md of exactly this session", () => {
	assert.equal(fileSeq("sid", "sid-1.md"), 1);
	assert.equal(fileSeq("sid", "sid-10.md"), 10);
	assert.equal(fileSeq("a-1", "a-1-2.md"), 2, "session ids may themselves end in -<digits>");
	assert.equal(fileSeq("a", "a-1-2.md"), undefined, "file of session a-1, not of a");
	assert.equal(fileSeq("a-1", "a-1.md"), undefined, "file of session a, not of a-1");
	assert.equal(fileSeq("sid", "other-1.md"), undefined);
	assert.equal(fileSeq("sid", "sid-1.md.tmp"), undefined);
	assert.equal(fileSeq("sid", "sid-x.md"), undefined);
	assert.equal(fileSeq("sid", "sid.md"), undefined);
});

test("nextPath / latestPath: missing dir → seq 1 and no latest", () => {
	withAgentDir((capDir) => {
		assert.equal(fs.existsSync(capDir), false);
		assert.deepEqual(nextPath("sid"), { seq: 1, filePath: path.join(capDir, "sid-1.md") });
		assert.equal(latestPath("sid"), undefined);
	});
});

test("nextPath / latestPath: numeric seq order; other sessions and junk ignored", () => {
	withAgentDir((capDir) => {
		// "9" sorts after "10" as a string: a lexicographic sort would reuse seq 10.
		touch(capDir, "sid-1.md", "sid-2.md", "sid-9.md", "sid-10.md");
		touch(capDir, "sid-x-99.md", "other-50.md", "sid-77.md.tmp", "notes.md");
		assert.deepEqual(nextPath("sid"), { seq: 11, filePath: path.join(capDir, "sid-11.md") });
		assert.equal(latestPath("sid"), path.join(capDir, "sid-10.md"));
		assert.equal(latestPath("sid-x"), path.join(capDir, "sid-x-99.md"));
		assert.equal(latestPath("none"), undefined);
	});
});

test("stripFrontmatter: drops a leading frontmatter block and the blank lines after it", () => {
	assert.equal(stripFrontmatter("---\nseq: 1\nauthor: agent\n---\n\n\n## Task\nbody\n"), "## Task\nbody\n");
	assert.equal(stripFrontmatter("## Task\nbody\n"), "## Task\nbody\n", "no frontmatter → unchanged");
});

test("stripFrontmatter: a lone markdown hr at the top is body, not frontmatter", () => {
	const body = "---\n\n## Task\nbody\n";
	assert.equal(stripFrontmatter(body), body);
	const midBlock = "## Task\n---\nnot: frontmatter\n---\nrest\n";
	assert.equal(stripFrontmatter(midBlock), midBlock, "only a block at the very start counts");
});

test("writeHandoff: creates the dir; frontmatter in field order; disabled caps as null; body's own frontmatter dropped", () => {
	withAgentDir((capDir) => {
		const filePath = path.join(capDir, "sid-3.md");
		const meta = {
			sessionId: "sid",
			seq: 3,
			tokens: 1234,
			author: "machine" as const,
			schema: "v2" as const,
			tailTokens: 50,
			tailKeptTokens: 40,
			caps: {
				soft: Number.POSITIVE_INFINITY,
				hard: Number.POSITIVE_INFINITY,
				source: "fallback" as const,
				contextWindow: null,
				disabled: true,
				clamped: false,
			},
		};
		writeHandoff(filePath, "---\nauthor: agent\n---\n\n  ## Task\nbody\n\n", meta);
		const text = fs.readFileSync(filePath, "utf8");
		const fm = text.match(/^---\n([\s\S]*?)\n---\n\n/);
		assert.ok(fm?.[1], `frontmatter block at the top: ${text}`);
		const lines = fm[1].split("\n");
		assert.match(lines[1] ?? "", /^timestamp: \d{4}-\d\d-\d\dT/);
		lines[1] = "timestamp: <ts>";
		assert.deepEqual(lines, [
			"sessionId: sid",
			"timestamp: <ts>",
			"tokens: 1234",
			"seq: 3",
			"author: machine",
			"schema: v2",
			"tailTokens: 50",
			"tailKeptTokens: 40",
			"contextWindow: null",
			"softCap: null",
			"hardCap: null",
			"capSource: fallback",
		]);
		assert.equal(stripFrontmatter(text), "## Task\nbody\n", "one frontmatter block; body trimmed, one trailing newline");

		writeHandoff(filePath, "b", { ...meta, caps: { ...meta.caps, soft: 100, hard: 200, contextWindow: 300, disabled: false } });
		assert.match(fs.readFileSync(filePath, "utf8"), /\ncontextWindow: 300\nsoftCap: 100\nhardCap: 200\n/);
	});
});
