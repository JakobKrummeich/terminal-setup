// ESLint flat config for ../check.sh. Lives next to tools/node_modules because
// ESM config imports resolve relative to this file (npx cannot supply plugins).
// check.sh runs eslint from the repo root with `-c`, so `files` globs below are
// repo-root relative. Size/complexity offenders that predate the gate were
// frozen in eslint-suppressions.json; all are split now and it is empty
// (ratchet — never add to it, see AGENTS.md).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const PRODUCTION = [
	"pi/extensions/*.ts",
	"pi/extensions/lib/**/*.ts",
	"pi/extensions/lib/dashboard-ui/*.js",
	"pi/dashboard-daemon.mjs",
];
const TESTS = ["pi/extensions/test/**/*.ts"];

export default tseslint.config(
	{ ignores: ["**/node_modules/**", "pi/extensions/test/tools/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts", "**/*.mjs"],
		languageOptions: { globals: { ...globals.node } },
	},
	{
		linterOptions: { reportUnusedDisableDirectives: "error" },
		rules: {
			// WHY: type-only imports are erased by Node's type stripping; marking them
			// keeps it obvious which imports have runtime side effects/cost.
			"@typescript-eslint/consistent-type-imports": "error",
			// WHY: `_`-prefix is the deliberate "unused by design" marker (callback
			// signatures, destructure-to-omit); everything else unused is dead code.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
				},
			],
			// WHY: an empty catch must say why swallowing is safe — a comment inside
			// the block satisfies no-empty and is the required rationale.
			"no-empty": ["error", { allowEmptyCatch: false }],
			// WHY off: the ANSI/OSC escape-sequence regexes (\x1b, \x07) are the point
			// of that code. (no-console is not enabled either: CLI warnings are intended.)
			"no-control-regex": "off",
		},
	},
	{
		files: PRODUCTION,
		rules: {
			// WHY: agent-maintainability — a unit must fit in one head (~7 branches)
			// and one file load. Production only; tests are flat scripted scenarios.
			complexity: ["error", 7],
			"max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
			"max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
		},
	},
	{
		files: TESTS,
		rules: {
			// WHY: tests poke at pi internals and fake LLM payloads; typing every
			// probe buys nothing.
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	{
		files: ["pi/extensions/lib/dashboard-ui/*.js"],
		languageOptions: { globals: { ...globals.browser } },
	},
);
