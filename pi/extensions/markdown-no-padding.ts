/**
 * Force paddingX=0 on all Markdown components.
 *
 * Why: assistant messages hardcode `new Markdown(text, 1, 0, ...)` — one leading
 * space per rendered line. Copied multiline code then carries that space into
 * paste targets (breaks Python top-level indent; pollutes bash).
 * Horizontal spacing is the terminal's job now (WezTerm pixel padding,
 * ~/codingprojects/weztermconfig).
 *
 * Mechanism: extensions share pi's module instances, so patching
 * Markdown.prototype.render affects the components pi constructs.
 * Coupled to pi-tui internals (`paddingX` prop) — re-verify after `pi update`.
 *
 * Known residual: long lines are still HARD-WRAPPED at render width; copying
 * them yields injected newlines. That needs a copy-from-session-model command
 * (separate extension), not a padding fix.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export default function (_pi: ExtensionAPI) {
	const proto = Markdown.prototype as unknown as {
		paddingX: number;
		render(width: number): string[];
	};
	const origRender = proto.render;
	proto.render = function (this: typeof proto, width: number): string[] {
		this.paddingX = 0;
		return origRender.call(this, width);
	};
}
