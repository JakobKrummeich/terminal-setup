#!/usr/bin/env node
// Lua syntax gate for ../check.sh: parses each file argument with luaparse and
// reports file:line:col on the first syntax error of each (exit 1 if any).
// WHY: wezterm/*.lua are the LIVE wezterm config (symlinked; wezterm
// auto-reloads on save) — a syntax error breaks the user's terminal at once,
// and no lua binary is installed to check them.
// WHY luaVersion 5.3: wezterm embeds Lua 5.4, but luaparse 0.3.1 tops out at
// 5.3. The only 5.4 additions are local attributes (`<const>`, `<close>`); a
// file using them fails here — widen this checker then, don't drop the gate.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const luaparse = createRequire(import.meta.url)("luaparse");

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: lua-syntax.mjs <file.lua>...");
	process.exit(2);
}
let failed = 0;
for (const file of files) {
	try {
		luaparse.parse(readFileSync(file, "utf8"), { luaVersion: "5.3", comments: false, scope: false });
	} catch (error) {
		if (!(error instanceof SyntaxError) || error.line === undefined) throw error;
		// luaparse: 1-based line, 0-based column; message is prefixed "[line:col] ".
		const message = error.message.replace(/^\[\d+:\d+\] /, "");
		console.error(`${file}:${error.line}:${error.column + 1}: ${message}`);
		failed++;
	}
}
process.exit(failed === 0 ? 0 : 1);
