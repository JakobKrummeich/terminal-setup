/**
 * Invariant: no top-level mutable state in pi/extensions/lib/*.ts.
 *
 * pi loads each extension with its own jiti instance (moduleCache: false), so a
 * lib file imported by two extensions runs as two module copies and module-level
 * state silently splits between them (AGENTS.md). Shared state goes through
 * sharedState() in lib/shared-state.ts instead.
 *
 * Pragmatic line scan, not a parser (the TypeScript compiler is not in the test
 * node_modules farm). The repo indents with tabs, so a declaration at column 0 is
 * top-level. Flagged:
 *  - any top-level `let` / `var`;
 *  - `const x = new Map|Set|WeakMap|WeakSet|Array(…)` — unless typed
 *    ReadonlyMap/ReadonlySet (a constant lookup table, e.g. session-transcript's
 *    HANDOFF_CUSTOM_TYPES); WeakMap/WeakSet/Array have no read-only form: they are
 *    caches or buffers by nature;
 *  - `const x = []` / `const x = {}` — an empty literal only exists to be filled.
 * Populated object/array literals (label tables, schema lists) pass: they are
 * constants in practice, and flagging every one would train people to ignore the test.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../lib");

const TOP_LEVEL_LET = /^(?:export\s+)?(?:let|var)\s+([\w$]+)/;
const TOP_LEVEL_CONST = /^(?:export\s+)?const\s+([\w$]+)\s*(?::\s*([^=]+?))?\s*=\s*(.*)$/;
const MUTABLE_CONSTRUCTOR = /^new\s+(Map|Set|WeakMap|WeakSet|Array)\b/;
const READONLY_TYPE = /^Readonly(Map|Set)</;
const EMPTY_LITERAL = /^(\[\s*\]|\{\s*\})/;

/** One finding per offending top-level declaration: "file:line name — reason". */
function findModuleState(source: string, file: string): string[] {
	const lines = source.split("\n");
	const findings: string[] = [];
	lines.forEach((line, i) => {
		const where = `${file}:${i + 1}`;
		const letMatch = TOP_LEVEL_LET.exec(line);
		if (letMatch) {
			findings.push(`${where} ${letMatch[1]} — top-level let/var`);
			return;
		}
		const constMatch = TOP_LEVEL_CONST.exec(line);
		if (!constMatch) return;
		const [, name, type = "", rest = ""] = constMatch;
		// `const x =` with the value on the next line.
		const value = rest.trim() || (lines[i + 1] ?? "").trim();
		const ctor = MUTABLE_CONSTRUCTOR.exec(value);
		if (ctor && !((ctor[1] === "Map" || ctor[1] === "Set") && READONLY_TYPE.test(type.trim()))) {
			findings.push(`${where} ${name} — top-level new ${ctor[1]}()`);
		} else if (EMPTY_LITERAL.test(value)) {
			findings.push(`${where} ${name} — top-level empty container literal`);
		}
	});
	return findings;
}

test("findModuleState catches the shapes it exists for — and lets constants through", () => {
	const flagged = [
		"let cache = new Map();",
		"let counter = 0;",
		"export let current: string | undefined;",
		"var legacy = {};",
		"const registry = new Map();",
		"const registry: Map<string, number> = new Map();",
		"export const seen = new Set<string>();",
		"const byObject = new WeakMap<object, number>();",
		"const queue: string[] = [];",
		"const bag = {};",
		"const late =\n\tnew Map();",
	];
	for (const snippet of flagged) {
		assert.equal(findModuleState(snippet, "x.ts").length, 1, `must flag: ${JSON.stringify(snippet)}`);
	}
	const allowed = [
		"const LABELS: Record<string, string> = {",
		'const NAMES: readonly string[] = ["v1", "v2"];',
		'const TYPES: ReadonlySet<string> = new Set(["a", "b"]);',
		"const state = sharedState<State>(KEY, () => ({ m: new Map() }));",
		"export const liveChildren = state.liveChildren;",
		'const KEY = Symbol.for("terminal-setup.x.v1");',
		"\tlet local = new Map(); // indented: inside a function",
		"function f() {}",
	];
	for (const snippet of allowed) {
		assert.deepEqual(findModuleState(snippet, "x.ts"), [], `must allow: ${JSON.stringify(snippet)}`);
	}
});

test("pi/extensions/lib/*.ts holds no top-level mutable module state", () => {
	const files = readdirSync(LIB_DIR).filter((name) => name.endsWith(".ts"));
	assert.ok(files.length > 5, `precondition: lib files found in ${LIB_DIR}`);
	const findings = files.flatMap((name) => findModuleState(readFileSync(path.join(LIB_DIR, name), "utf8"), name));
	assert.deepEqual(findings, [], "move this state behind sharedState() (lib/shared-state.ts) — see AGENTS.md");
});
