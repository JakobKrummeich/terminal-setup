/**
 * Register pi's builtin grep/find/ls tools for main sessions.
 *
 * Pi's default toolset is read/bash/edit/write only (sdk.js
 * defaultActiveToolNames) — grep/find/ls exist as builtins (rg/fd-backed,
 * output-capped) but nothing activates them in a main session. They used to
 * reach sessions as a side effect of rtk-tools.ts overriding them; when that
 * extension was dropped (net-negative vs the builtins' own caps — see its
 * removal commit), the tools vanished entirely.
 *
 * The pi-native alternative is `defaultTools` in settings.json, but the live
 * settings file is pi-owned (rewritten at runtime, copied once at install,
 * never symlinked) — the repo can't manage it. This extension lives in the
 * symlinked extensions dir, so the repo stays the single source of truth.
 *
 * Child sessions (Agent/Explore) load this file too: registering a builtin
 * over the allowlist-activated builtin of the same name is a same-behavior
 * override, so no child guard is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	pi.registerTool(createGrepTool(cwd));
	pi.registerTool(createFindTool(cwd));
	pi.registerTool(createLsTool(cwd));
}
