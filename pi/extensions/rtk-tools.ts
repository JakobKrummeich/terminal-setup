/**
 * RTK Tool Overrides — replaces Pi's built-in grep/find/ls with RTK equivalents.
 *
 * Companion to the official rtk.ts extension (which handles bash rewrites).
 * Together they cover all non-edit tools for 60-90% token savings.
 *
 * Requires: rtk >= 0.23.0 in PATH.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/rtk-tools.ts
 *   Or load directly: pi -e ./rtk-tools.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";

const RTK_TIMEOUT_MS = 30_000;

export default async function (pi: ExtensionAPI) {
	// Probe rtk availability at load time.
	const ver = await pi.exec("rtk", ["--version"], { timeout: 2_000 });
	if (ver.code !== 0) {
		console.warn("[rtk-tools] rtk binary not found in PATH — tool overrides disabled");
		return;
	}

	const cwd = process.cwd();

	// Keep originals as fallbacks — if rtk fails, delegate to Pi's built-in.
	const originalGrep = createGrepTool(cwd);
	const originalFind = createFindTool(cwd);
	const originalLs = createLsTool(cwd);

	// Helper: build text result from rtk output.
	function textResult(stdout: string, stderr: string, fallbackMsg: string) {
		const text = stdout.trim() || stderr.trim() || fallbackMsg;
		return {
			content: [{ type: "text" as const, text }] as TextContent[],
			details: {},
		};
	}

	// --- grep → rtk grep ---
	// Pi's grep params: pattern, path?, glob?, ignoreCase?, literal?, context?, limit?
	// RTK wraps ripgrep with output grouping/compression.
	pi.registerTool({
		name: "grep",
		label: "grep (rtk)",
		description: originalGrep.description,
		parameters: originalGrep.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				// rtk grep <pattern> [path] [extra rg args...]
				const args: string[] = ["grep", params.pattern, params.path || "."];
				// Extra ripgrep flags go after path.
				if (params.ignoreCase) args.push("-i");
				if (params.literal) args.push("-F");
				if (params.context) args.push("-C", String(params.context));
				if (params.limit) args.push("-m", String(params.limit));
				if (params.glob) args.push("--glob", params.glob);

				const result = await pi.exec("rtk", args, {
					timeout: RTK_TIMEOUT_MS,
					signal,
				});

				// rg exit 1 = no matches (not an error)
				if (result.code === 1 && !result.stderr.trim()) {
					return textResult("", "", "No matches found");
				}

				return textResult(result.stdout, result.stderr, "No matches found");
			} catch (err) {
				console.warn("[rtk-tools] grep fallback to built-in:", err);
				return originalGrep.execute(toolCallId, params, signal, onUpdate);
			}
		},

		// No renderCall/renderResult — uses Pi's built-in renderer.
	});

	// --- find → rtk find ---
	// Pi's find params: pattern, path?, limit?
	pi.registerTool({
		name: "find",
		label: "find (rtk)",
		description: originalFind.description,
		parameters: originalFind.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const args: string[] = ["find"];
				args.push(params.pattern);
				args.push(params.path || ".");

				const result = await pi.exec("rtk", args, {
					timeout: RTK_TIMEOUT_MS,
					signal,
				});

				return textResult(result.stdout, result.stderr, "No results");
			} catch (err) {
				console.warn("[rtk-tools] find fallback to built-in:", err);
				return originalFind.execute(toolCallId, params, signal, onUpdate);
			}
		},
	});

	// --- ls → rtk ls ---
	// Pi's ls params: path?, limit?
	pi.registerTool({
		name: "ls",
		label: "ls (rtk)",
		description: originalLs.description,
		parameters: originalLs.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const args: string[] = ["ls"];
				args.push(params.path || ".");

				const result = await pi.exec("rtk", args, {
					timeout: RTK_TIMEOUT_MS,
					signal,
				});

				return textResult(result.stdout, result.stderr, "Empty directory");
			} catch (err) {
				console.warn("[rtk-tools] ls fallback to built-in:", err);
				return originalLs.execute(toolCallId, params, signal, onUpdate);
			}
		},
	});
}
