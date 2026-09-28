/**
 * context-cap handoff files: <agent dir>/context-cap/<sessionId>-<seq>.md
 * (contextCapDir()). seq is disk-derived per sessionId (sessionId never changes —
 * swaps are entries, not new sessions, so one session accumulates seq 1, 2, 3…).
 * YAML frontmatter is written here as tooling metadata and stripped before
 * injection. No cleanup policy (v1).
 *
 * pi-free; no module-level state (AGENTS.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { contextCapDir } from "./agent-dir.ts";
import type { HandoffAuthor } from "./context-cap-decide.ts";
import type { HandoffSchema, ResolvedTriggers } from "./env.ts";

/** seq of `name` when it is one of `sessionId`'s handoff files. */
export function fileSeq(sessionId: string, name: string): number | undefined {
	const m = name.match(/^(.+)-(\d+)\.md$/);
	// m[2] is a non-optional group (always captured on a match); the check only
	// restates that for the type checker.
	if (!m || m[1] !== sessionId || m[2] === undefined) return undefined;
	return Number.parseInt(m[2], 10);
}

function existingSeqs(sessionId: string): number[] {
	try {
		return fs
			.readdirSync(contextCapDir())
			.map((n) => fileSeq(sessionId, n))
			.filter((s): s is number => s !== undefined)
			.sort((a, b) => a - b);
	} catch {
		return [];
	}
}

export function nextPath(sessionId: string): { seq: number; filePath: string } {
	const seqs = existingSeqs(sessionId);
	const seq = (seqs[seqs.length - 1] ?? 0) + 1;
	return { seq, filePath: path.join(contextCapDir(), `${sessionId}-${seq}.md`) };
}

export function latestPath(sessionId: string): string | undefined {
	const seqs = existingSeqs(sessionId);
	if (seqs.length === 0) return undefined;
	return path.join(contextCapDir(), `${sessionId}-${seqs[seqs.length - 1]}.md`);
}

/** Full frontmatter block only — a lone markdown hr (`---`) at the top must NOT match. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

export function stripFrontmatter(text: string): string {
	const m = text.match(FRONTMATTER_RE);
	return m ? text.slice(m[0].length).replace(/^\s+/, "") : text;
}

/** The frontmatter fields, in file order. */
export interface HandoffFileMeta {
	sessionId: string;
	seq: number;
	tokens: number;
	author: HandoffAuthor;
	schema: HandoffSchema;
	tailTokens: number;
	tailKeptTokens: number;
	caps: ResolvedTriggers;
}

/** Write the handoff with YAML frontmatter (tooling metadata only — never injected). Throws on I/O failure. */
export function writeHandoff(filePath: string, body: string, meta: HandoffFileMeta): void {
	const fm = `---\nsessionId: ${meta.sessionId}\ntimestamp: ${new Date().toISOString()}\ntokens: ${meta.tokens}\nseq: ${meta.seq}\nauthor: ${meta.author}\nschema: ${meta.schema}\ntailTokens: ${meta.tailTokens}\ntailKeptTokens: ${meta.tailKeptTokens}\ncontextWindow: ${yamlNumber(meta.caps.contextWindow)}\nsoftCap: ${yamlNumber(meta.caps.soft)}\nhardCap: ${yamlNumber(meta.caps.hard)}\ncapSource: ${meta.caps.source}\n---\n\n`;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, fm + stripFrontmatter(body).trim() + "\n");
}

/** null / +Infinity (a disabled cap) are not YAML numbers — emit the null literal. */
function yamlNumber(n: number | null): string {
	return n != null && Number.isFinite(n) ? String(n) : "null";
}
