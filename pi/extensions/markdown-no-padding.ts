/**
 * Force paddingX=0 on all Markdown components.
 *
 * Why: assistant messages hardcode `new Markdown(text, 1, 0, ...)` — one leading
 * space per rendered line. Copied multiline code then carries that space into
 * paste targets (breaks Python top-level indent; pollutes bash).
 * Horizontal spacing is the terminal's job now (WezTerm pixel padding,
 * ~/codingprojects/weztermconfig).
 *
 * Mechanism: pi loads each extension file with its own jiti instance
 * (`moduleCache: false`), so relative imports duplicate per extension (see
 * AGENTS.md) — but bare package imports (like `@earendil-works/pi-tui`) are
 * aliased to pi's OWN module instances (the bundled CLI's embedded modules, or
 * pi's dist entries when pi runs unbundled, e.g. under the tests). So this file
 * gets the very Markdown class pi constructs from, and patching
 * Markdown.prototype.render affects pi's components.
 * Coupled to pi-tui internals (`paddingX` prop) — re-verify after `pi update`.
 *
 * Known residual: long lines are still HARD-WRAPPED at render width; copying
 * them yields injected newlines. That needs a copy-from-session-model command
 * (separate extension), not a padding fix.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

/**
 * Holds the unpatched render on the (shared) prototype. Exported for tests only.
 * Bump the version suffix if the stored shape ever changes.
 */
export const ORIGINAL_RENDER = Symbol.for("terminal-setup.markdown-no-padding.v1");

type PatchableProto = {
	paddingX: number;
	render(width: number): string[];
	[ORIGINAL_RENDER]?: (width: number) => string[];
};

export default function (_pi: ExtensionAPI) {
	const proto = Markdown.prototype as unknown as PatchableProto;
	// WHY the guard: pi re-imports this file whenever its extension cache is
	// dropped (/reload, cwd change), each time via a fresh jiti instance, but the
	// pi-tui prototype is shared — without it every re-import stacked another
	// wrapper around render. Patch exactly once.
	if (proto[ORIGINAL_RENDER]) return;
	const origRender = proto.render;
	proto[ORIGINAL_RENDER] = origRender;
	proto.render = function (this: PatchableProto, width: number): string[] {
		this.paddingX = 0;
		return origRender.call(this, width);
	};
}
