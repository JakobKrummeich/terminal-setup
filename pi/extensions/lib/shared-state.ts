/**
 * Process-wide state for lib modules: get-or-create `init()` on globalThis
 * under `key`.
 *
 * Why not a module-level variable: pi loads each extension file with its own
 * jiti instance (moduleCache: false), so a lib file imported by two extensions —
 * or re-imported on /reload — runs as several module copies, and module-level
 * state silently splits between them. globalThis is the one object every copy
 * shares. test/lib-module-state.test.ts rejects top-level mutable state in lib/.
 *
 * Key convention: Symbol.for("terminal-setup.<module>.v<N>"). Bump N whenever
 * T's shape changes — an old code copy still alive in the process keeps the old
 * shape under the old key, and old and new copies must never share a
 * mis-shaped object.
 */
export function sharedState<T>(key: symbol, init: () => T): T {
	const globals = globalThis as unknown as Record<symbol, T | undefined>;
	return (globals[key] ??= init());
}
