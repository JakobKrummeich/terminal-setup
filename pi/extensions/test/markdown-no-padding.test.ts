/**
 * markdown-no-padding patches the shared pi-tui Markdown.prototype.render. pi
 * re-imports the extension whenever its extension cache is dropped (/reload,
 * cwd change) — separate jiti instances, same prototype — so an unguarded patch
 * stacked one wrapper per load. Calling the default export N times here reproduces that: the guard lives
 * on the prototype, not in module state, so N calls on one module instance hit
 * exactly the path N separate jiti loads hit.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import * as paddingModule from "../markdown-no-padding.ts";
import { ORIGINAL_RENDER } from "../markdown-no-padding.ts";

// Same CJS/ESM default-export interop unwrap as caveman-prompt.test.ts.
type ExtensionFn = (pi: unknown) => void;
const defaultExport = (paddingModule as unknown as { default: ExtensionFn | { default: ExtensionFn } }).default;
const loadExtension: ExtensionFn = typeof defaultExport === "function" ? defaultExport : defaultExport.default;

const id = (text: string) => text;
const THEME: MarkdownTheme = {
	heading: id,
	link: id,
	linkUrl: id,
	code: id,
	codeBlock: id,
	codeBlockBorder: id,
	quote: id,
	quoteBorder: id,
	hr: id,
	listBullet: id,
	bold: id,
	italic: id,
	strikethrough: id,
	underline: id,
};

const SOURCE = "# Title\n\nSome text.\n\n```python\ndef f():\n    return 1\n```\n";
// Fresh instance per render: Markdown caches lines per (text, width).
// paddingX 1 = what pi's assistant messages construct.
const render = () => new Markdown(SOURCE, 1, 0, THEME).render(40);

type Proto = { render(width: number): string[]; [ORIGINAL_RENDER]?: (width: number) => string[] };
const proto = Markdown.prototype as unknown as Proto;

test("repeated loads install exactly one render wrapper", (t) => {
	const pristine = proto.render;
	t.after(() => {
		// The prototype is process-global: leave it as we found it.
		proto.render = pristine;
		delete proto[ORIGINAL_RENDER];
	});
	assert.equal(proto[ORIGINAL_RENDER], undefined, "prototype must start unpatched");
	const unpatched = render();
	const textLine = (lines: string[]) => lines.find((line) => line.includes("Some text."));
	assert.ok(textLine(unpatched)?.startsWith(" Some text."), "sanity: paddingX=1 indents lines");

	// Spy standing in for pi-tui's render: records how many wrapper frames
	// (functions defined in markdown-no-padding.ts) sit above it per call.
	let wrapperFrames: number[] = [];
	const spy = function (this: unknown, width: number): string[] {
		const stack = new Error().stack ?? "";
		wrapperFrames.push(stack.split("\n").filter((line) => line.includes("markdown-no-padding.ts")).length);
		return pristine.call(this, width);
	};
	proto.render = spy;

	loadExtension({});
	const wrapped = proto.render;
	assert.notEqual(wrapped, spy, "first load must patch render");
	assert.equal(proto[ORIGINAL_RENDER], spy, "the original render is stored under the symbol");
	const singleLoad = render();
	assert.ok(textLine(singleLoad)?.startsWith("Some text."), "padding stripped");
	assert.deepEqual(wrapperFrames, [1], "one wrapper frame after one load");

	for (let i = 0; i < 4; i++) loadExtension({});
	assert.equal(proto.render, wrapped, "later loads must not wrap again");
	assert.equal(proto[ORIGINAL_RENDER], spy, "stored original must stay the unpatched render");
	wrapperFrames = [];
	assert.deepEqual(render(), singleLoad, "output after N loads equals single-load output");
	assert.deepEqual(wrapperFrames, [1], "still one wrapper frame after 5 loads");
});
