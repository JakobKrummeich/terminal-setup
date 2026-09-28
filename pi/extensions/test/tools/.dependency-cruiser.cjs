// dependency-cruiser config for ../check.sh (run from the repo root:
// `depcruise --config pi/extensions/test/tools/.dependency-cruiser.cjs pi/extensions pi/dashboard-daemon.mjs`).
// Needs the test/node_modules symlink farm (farm.sh) so pi's packages resolve.
// Each rule is proven to fire by ../check.sh --self-test.
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			comment: "WHY: cycles make load order matter and defeat reading one module at a time.",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			name: "lib-not-to-toplevel-extension",
			comment:
				"WHY: pi/extensions/*.ts are pi entry points (each loaded by its own jiti instance); " +
				"lib/ importing one would run that extension's registration a second time.",
			severity: "error",
			from: { path: "^pi/extensions/lib/" },
			to: { path: "^pi/extensions/[^/]+\\.ts$" },
		},
		{
			name: "daemon-closure-no-pi",
			comment:
				"WHY: pi/dashboard-daemon.mjs runs under plain node (systemd, no pi, no farm); anything it " +
				"reaches must not touch @earendil-works/*. Reachable rules see type-only edges too " +
				"(tsPreCompilationDeps), so this is stricter than the daemon header (which tolerates " +
				"type-only pi imports): the closure has none today — lib/message-types.ts stays pi-free on purpose.",
			severity: "error",
			from: { path: "^pi/dashboard-daemon\\.mjs$" },
			to: { path: "@earendil-works/", reachable: true },
		},
		{
			name: "prod-not-to-test",
			comment: "WHY: test helpers fake pi (scripted LLM); production must never load them.",
			severity: "error",
			from: { path: "^pi/", pathNot: "^pi/extensions/test/" },
			to: { path: "^pi/extensions/test/" },
		},
		{
			name: "not-to-unresolvable",
			comment: "WHY: an unresolvable import is a runtime crash in pi or the daemon.",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
	],
	options: {
		// WHY: type-only imports still count for cycles and the daemon closure.
		tsPreCompilationDeps: true,
		// WHY doNotFollow, never exclude, for node_modules: excluding drops the
		// @earendil-works nodes and silently disables daemon-closure-no-pi.
		doNotFollow: { path: "node_modules" },
		// The pinned tools themselves are not product code.
		exclude: { path: "^pi/extensions/test/tools/" },
		// WHY: pi's packages only expose entry points via package.json "exports".
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
			mainFields: ["module", "main", "types"],
			extensions: [".ts", ".mjs", ".js", ".cjs", ".d.ts"],
		},
	},
};
