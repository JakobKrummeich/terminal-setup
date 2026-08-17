/**
 * Model-aware soft/hard triggers.
 *
 * The bug this pins: the caps used to be import-time constants (260k/325k) with no
 * knowledge of the model. pi auto-compacts at `contextWindow - 16384`, so on a
 * 200k-window model a 325k hard cap can never fire — pi compacts first and the
 * whole extension is dead weight. Caps are now derived from the live window and
 * re-resolved on EVERY check, because a session can change model and pi exposes no
 * model-switch event.
 *
 * NOTE: this file must not set CONTEXT_CAP_SOFT / CONTEXT_CAP_HARD at module level
 * — the dynamic path is only observable with them unset. The env-override tests set
 * and restore them around a single synchronous call (node:test runs top-level tests
 * sequentially, and each *.test.ts file gets its own process).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCapResolver } from "../context-cap.ts";
import {
	CONTEXT_CAP_HARD_TRIGGER,
	CONTEXT_CAP_RESERVE_TOKENS_DEFAULT,
	contextCapReserveTokens,
	CONTEXT_CAP_SOFT_TRIGGER,
	envIntOrNull,
	resolveTriggers,
	type ResolvedTriggers,
} from "../lib/env.ts";
import { createTestSession, textStep, toolStep } from "./harness.ts";

const CAP_KEYS = ["CONTEXT_CAP_SOFT", "CONTEXT_CAP_HARD", "CONTEXT_CAP_RESERVE", "PI_CODING_AGENT_DIR"] as const;

/** Set env vars for one synchronous call and restore them exactly. */
function withEnv<T>(vars: Partial<Record<(typeof CAP_KEYS)[number], string>>, fn: () => T): T {
	const saved = new Map(CAP_KEYS.map((k) => [k, process.env[k]] as const));
	try {
		for (const k of CAP_KEYS) {
			const v = vars[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const usage = (contextWindow: number | null | undefined) => ({ contextWindow });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("precondition: no CONTEXT_CAP_* override is set in this process", () => {
	for (const key of CAP_KEYS) {
		assert.equal(process.env[key], undefined, `${key} must be unset — it would mask the dynamic path`);
	}
	assert.equal(CONTEXT_CAP_SOFT_TRIGGER, 260_000, "the static soft value is also the dynamic ceiling");
	assert.equal(CONTEXT_CAP_HARD_TRIGGER, 325_000, "the static hard value is also the dynamic ceiling");
	assert.equal(CONTEXT_CAP_RESERVE_TOKENS_DEFAULT, 16_384, "must equal pi's compaction reserveTokens default");
});

test("dynamic triggers: the worked examples, window by window", () => {
	// window → [soft, hard]. ceiling = window - 16384;
	// hard = min(325k, floor(0.90 * ceiling)); soft = min(260k, floor(0.80 * hard)).
	const table: [window: number, soft: number, hard: number][] = [
		[1_000_000, 260_000, 325_000], // ceiling 983_616 — the ceilings bind, today's behaviour
		[400_000, 260_000, 325_000], // ceiling 383_616 — still above both ceilings
		[300_000, 204_203, 255_254], // ceiling 283_616
		[200_000, 132_203, 165_254], // ceiling 183_616 — where the old 325k hard cap was unreachable
	];
	for (const [window, soft, hard] of table) {
		const caps = resolveTriggers(window);
		assert.deepEqual(
			{ soft: caps.soft, hard: caps.hard, source: caps.source, contextWindow: caps.contextWindow },
			{ soft, hard, source: "dynamic" as const, contextWindow: window },
			`window ${window}`,
		);
		assert.equal(caps.disabled, false);
		assert.equal(caps.clamped, false);
		// The whole point: both caps fire before pi's own compaction.
		assert.ok(caps.hard < window - CONTEXT_CAP_RESERVE_TOKENS_DEFAULT, `hard must be under pi's compact point (${window})`);
		assert.ok(caps.soft < caps.hard, `soft must leave room before hard (${window})`);
	}
});

// ---------------------------------------------------------------------------
// Env overrides
// ---------------------------------------------------------------------------

test("env: both set wins outright, no dynamic computation", () => {
	const caps = withEnv({ CONTEXT_CAP_SOFT: "5", CONTEXT_CAP_HARD: "50" }, () => resolveTriggers(200_000));
	assert.deepEqual({ soft: caps.soft, hard: caps.hard, source: caps.source }, { soft: 5, hard: 50, source: "env" });
	assert.equal(caps.contextWindow, 200_000, "the observed window is still recorded");
	assert.equal(caps.disabled, false);
});

test("env: soft only — hard stays dynamic", () => {
	const caps = withEnv({ CONTEXT_CAP_SOFT: "5" }, () => resolveTriggers(200_000));
	assert.equal(caps.soft, 5, "the explicit soft is used verbatim");
	assert.equal(caps.hard, 165_254, "hard is still derived from the window");
	assert.equal(caps.source, "dynamic", "not pure env: one value was computed");
	assert.equal(caps.clamped, false);
});

test("env: hard only — soft is derived from the explicit hard", () => {
	const caps = withEnv({ CONTEXT_CAP_HARD: "50" }, () => resolveTriggers(200_000));
	assert.equal(caps.hard, 50, "the explicit hard is used verbatim");
	assert.equal(caps.soft, 40, "soft = min(260k, floor(0.80 * hard)) against the RESOLVED hard");
	assert.equal(caps.source, "dynamic");
	// A large env hard on a small window is still honoured: env wins outright.
	const big = withEnv({ CONTEXT_CAP_HARD: "900000" }, () => resolveTriggers(200_000));
	assert.equal(big.hard, 900_000);
	assert.equal(big.soft, 260_000, "the 260k soft ceiling still binds");
});

test("env: garbage and non-positive values count as unset", () => {
	assert.equal(envIntOrNull("CONTEXT_CAP_SOFT"), null, "unset");
	for (const bad of ["", "abc", "0", "-5"]) {
		const caps = withEnv({ CONTEXT_CAP_SOFT: bad }, () => {
			assert.equal(envIntOrNull("CONTEXT_CAP_SOFT"), null, `${JSON.stringify(bad)} must read as unset`);
			return resolveTriggers(200_000);
		});
		assert.equal(caps.soft, 132_203, `${JSON.stringify(bad)} must not override the dynamic soft`);
	}
});

// ---------------------------------------------------------------------------
// Fallback, degenerate windows, clamp
// ---------------------------------------------------------------------------

test("unknown context window falls back to the static 260k/325k and records it", () => {
	for (const window of [null, undefined, 0, Number.NaN]) {
		const caps = resolveTriggers(window);
		assert.deepEqual(
			{ soft: caps.soft, hard: caps.hard, source: caps.source, contextWindow: caps.contextWindow },
			{ soft: 260_000, hard: 325_000, source: "fallback" as const, contextWindow: null },
			`window ${String(window)}`,
		);
		assert.equal(caps.disabled, false, "an unknown window still arms the cap — it just cannot be model-aware");
	}
	// An explicit value plus an unknown window: the OTHER value is the static one,
	// so the pair is still reported as a fallback pair.
	const half = withEnv({ CONTEXT_CAP_SOFT: "5" }, () => resolveTriggers(undefined));
	assert.deepEqual({ soft: half.soft, hard: half.hard, source: half.source }, { soft: 5, hard: 325_000, source: "fallback" });
});

test("degenerate window: cap disabled rather than armed at a nonsense threshold", () => {
	for (const window of [1, 100, CONTEXT_CAP_RESERVE_TOKENS_DEFAULT, CONTEXT_CAP_RESERVE_TOKENS_DEFAULT + 1]) {
		const caps = resolveTriggers(window);
		assert.equal(caps.disabled, true, `window ${window} cannot hold a cap under pi's reserve`);
		assert.equal(caps.soft, Number.POSITIVE_INFINITY, "a disabled cap must be unfireable even if a caller forgets");
		assert.equal(caps.hard, Number.POSITIVE_INFINITY);
		assert.equal(caps.contextWindow, window);
	}
	// ceiling 2 ⇒ floor(0.9 * 2) = 1 ⇒ no room for a soft trigger underneath.
	assert.equal(resolveTriggers(CONTEXT_CAP_RESERVE_TOKENS_DEFAULT + 2).disabled, true);
	// The first window that yields a usable pair.
	const ok = resolveTriggers(CONTEXT_CAP_RESERVE_TOKENS_DEFAULT + 3);
	assert.equal(ok.disabled, false);
	assert.deepEqual({ soft: ok.soft, hard: ok.hard }, { soft: 1, hard: 2 });
	// Explicit env still wins on a degenerate window: nothing dynamic is needed.
	const forced = withEnv({ CONTEXT_CAP_SOFT: "5", CONTEXT_CAP_HARD: "50" }, () => resolveTriggers(1_000));
	assert.equal(forced.disabled, false);
	assert.deepEqual({ soft: forced.soft, hard: forced.hard }, { soft: 5, hard: 50 });
});

test("soft >= hard is clamped to hard-1 and flagged", () => {
	// Only-soft-set against a small window: the explicit 200k soft is above the
	// dynamic 165_254 hard, which would mean the steer never gets a turn.
	const caps = withEnv({ CONTEXT_CAP_SOFT: "200000" }, () => resolveTriggers(200_000));
	assert.equal(caps.hard, 165_254);
	assert.equal(caps.soft, 165_253, "soft pulled to hard-1");
	assert.equal(caps.clamped, true);
	// Both explicit and inverted: same repair, so the pair can never misbehave.
	const both = withEnv({ CONTEXT_CAP_SOFT: "80", CONTEXT_CAP_HARD: "50" }, () => resolveTriggers(1_000_000));
	assert.deepEqual({ soft: both.soft, hard: both.hard, clamped: both.clamped }, { soft: 49, hard: 50, clamped: true });
	// Nothing left below hard ⇒ disabled, not a zero trigger that fires always.
	const none = withEnv({ CONTEXT_CAP_SOFT: "5", CONTEXT_CAP_HARD: "1" }, () => resolveTriggers(1_000_000));
	assert.equal(none.disabled, true);
});

// ---------------------------------------------------------------------------
// Laziness — nothing may be cached at import time
// ---------------------------------------------------------------------------

test("resolveTriggers reads env at CALL time, not at import time", () => {
	assert.equal(resolveTriggers(200_000).hard, 165_254);
	assert.equal(withEnv({ CONTEXT_CAP_HARD: "77" }, () => resolveTriggers(200_000)).hard, 77);
	assert.equal(resolveTriggers(200_000).hard, 165_254, "and the override is gone again once unset");
});

test("mid-session window change: a later check resolves different triggers", () => {
	const resolve = createCapResolver();
	const big = resolve(usage(1_000_000));
	assert.deepEqual({ soft: big.soft, hard: big.hard }, { soft: 260_000, hard: 325_000 });
	// Same resolver, new model: no re-import, no restart, no model-switch event.
	const small = resolve(usage(200_000));
	assert.deepEqual({ soft: small.soft, hard: small.hard }, { soft: 132_203, hard: 165_254 });
	assert.equal(small.contextWindow, 200_000);
	// And back up again.
	assert.equal(resolve(usage(1_000_000)).soft, 260_000);
});

test("resolver prefers the last known good window over the static fallback", () => {
	const resolve = createCapResolver();
	// Before the first LLM call pi reports no usage at all.
	const cold = resolve(undefined);
	assert.deepEqual({ soft: cold.soft, source: cold.source }, { soft: 260_000, source: "fallback" });
	assert.equal(resolve(usage(200_000)).soft, 132_203);
	// Usage goes missing again (post-compaction, errored message): a real window we
	// have already seen beats the static guess.
	const warm = resolve(undefined);
	assert.deepEqual(
		{ soft: warm.soft, hard: warm.hard, source: warm.source, contextWindow: warm.contextWindow },
		{ soft: 132_203, hard: 165_254, source: "dynamic" as const, contextWindow: 200_000 },
	);
	assert.equal(resolve(usage(0)).soft, 132_203, "contextWindow 0 counts as unknown, not as degenerate");
});

test("resolver warns once per condition, not once per check", () => {
	const degenerate: string[] = [];
	const resolveDegenerate = createCapResolver();
	// A degenerate window is still a real observation: it is remembered, so every
	// later check stays disabled — and must stay silent after the first warning.
	for (let i = 0; i < 5; i++) resolveDegenerate(usage(1_000), (m) => void degenerate.push(m));
	for (let i = 0; i < 5; i++) resolveDegenerate(undefined, (m) => void degenerate.push(m));
	assert.equal(degenerate.length, 1, `one warning for a degenerate window, got ${JSON.stringify(degenerate)}`);
	assert.match(degenerate[0], /cap disabled/);

	const unknown: string[] = [];
	const resolveUnknown = createCapResolver();
	for (let i = 0; i < 5; i++) resolveUnknown(undefined, (m) => void unknown.push(m));
	assert.equal(unknown.length, 1, `one note for an unknown window, got ${JSON.stringify(unknown)}`);
	assert.match(unknown[0], /window unknown/);
});

// ---------------------------------------------------------------------------
// End to end: a mid-session model switch really moves the cap
// ---------------------------------------------------------------------------

const EXT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CAP_DIR = path.join(os.homedir(), ".pi", "agent", "context-cap");

/** Above the 200k-window soft cap (132_203), below its hard cap and below the old static 260k. */
const TOKENS = 140_000;

test("mid-session model switch moves the soft cap: no steer at 1M, steer at 200k", async () => {
	const t = await createTestSession({
		extensionPaths: [path.join(EXT_DIR, "context-cap.ts"), path.join(EXT_DIR, "timer.ts")],
		tools: ["timer", "context_handoff"],
		llmDelayMs: 10,
		script: [
			// Prompt 1, 1M window (soft 260k): 140k is far below the cap.
			toolStep("a1", "timer", { action: "cancel" }, TOKENS),
			textStep("nothing to see here", TOKENS),
			// Prompt 2, 200k window (soft 132_203): the same 140k now crosses it.
			toolStep("a2", "timer", { action: "cancel" }, TOKENS),
			toolStep("h1", "context_handoff", { markdown: "## Current Task\nDYNAMIC-CAP-SENTINEL." }, TOKENS),
			textStep("post-swap", 2),
		],
	});
	const sessionId = t.session.sessionManager.getSessionId();
	try {
		assert.equal(t.session.model?.contextWindow, 1_000_000, "harness model precondition");

		await t.session.prompt("first");
		assert.equal(
			t.deliveredUserMessages.filter((m) => m.text.includes("[context-cap]")).length,
			0,
			"140k must not trip the 1M-window soft cap (260k)",
		);

		// The model changes mid-session — there is no model-switch event, so the
		// extension can only get this right by re-resolving on the next check.
		await t.session.setModel({ ...t.session.model, contextWindow: 200_000 });
		await t.session.prompt("second");

		const steers = t.deliveredUserMessages.filter((m) => m.text.includes("[context-cap]"));
		assert.equal(steers.length, 1, `expected exactly one steer, got ${JSON.stringify(steers.map((s) => s.text))}`);
		assert.match(steers[0].text, /soft cap 132203, hard cap 165254/, "the steer must quote the dynamic pair");

		const marker = (
			t.session.messages as Array<{ role: string; customType?: string; details?: Record<string, unknown> }>
		).find((m) => m.role === "custom" && m.customType === "context-cap-swap");
		assert.ok(marker, "the swap must have happened");
		assert.deepEqual(
			{
				contextWindow: marker.details?.contextWindow,
				softCap: marker.details?.softCap,
				hardCap: marker.details?.hardCap,
				capSource: marker.details?.capSource,
			},
			{ contextWindow: 200_000, softCap: 132_203, hardCap: 165_254, capSource: "dynamic" },
			"the marker records the window and the pair actually in force",
		);
		// Existing forensic fields are untouched.
		assert.equal(marker.details?.schema, "v2");
		assert.equal(marker.details?.tailTokens, 0);
		assert.equal(marker.details?.tailKeptTokens, 0);

		// Same four fields in the handoff file's frontmatter.
		const files = fs.readdirSync(CAP_DIR).filter((n) => n.startsWith(`${sessionId}-`));
		assert.equal(files.length, 1, "exactly one handoff file");
		const fm = fs.readFileSync(path.join(CAP_DIR, files[0]), "utf8");
		assert.match(fm, /\ncontextWindow: 200000\n/);
		assert.match(fm, /\nsoftCap: 132203\n/);
		assert.match(fm, /\nhardCap: 165254\n/);
		assert.match(fm, /\ncapSource: dynamic\n/);
		assert.match(fm, /DYNAMIC-CAP-SENTINEL/);
	} finally {
		try {
			for (const n of fs.readdirSync(CAP_DIR)) {
				if (n.startsWith(`${sessionId}-`)) fs.rmSync(path.join(CAP_DIR, n), { force: true });
			}
		} catch {}
		t.dispose();
	}
});

test("a disabled cap never swaps: the type says so and the resolver says so", () => {
	const resolve = createCapResolver();
	const caps: ResolvedTriggers = resolve(usage(1_000));
	assert.equal(caps.disabled, true);
	// Every trigger comparison in context-cap.ts is `tokens >= caps.soft|hard`;
	// +Infinity makes all of them false even without the explicit `disabled` gate.
	for (const tokens of [0, 1_000, 999_999_999]) {
		assert.equal(tokens >= caps.soft, false);
		assert.equal(tokens >= caps.hard, false);
	}
});

// ---------------------------------------------------------------------------
// pi's compaction reserve is a SETTING, not a constant
// (settings-manager.js: `settings.compaction?.reserveTokens ?? 16384`), and
// ExtensionContext exposes no way to read it. Assuming the default when the real
// value is larger puts our hard cap ABOVE pi's compact point and silently disarms
// the extension — the exact failure the dynamic caps exist to prevent.

function withAgentDir<T>(settings: string | null, extra: Record<string, string>, fn: () => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-reserve-"));
	if (settings !== null) fs.writeFileSync(path.join(dir, "settings.json"), settings);
	return withEnv({ PI_CODING_AGENT_DIR: dir, ...extra }, fn);
}

test("reserve: falls back to pi's default when there is no settings file", () => {
	withAgentDir(null, {}, () => {
		assert.equal(contextCapReserveTokens(), CONTEXT_CAP_RESERVE_TOKENS_DEFAULT);
	});
});

test("reserve: reads compaction.reserveTokens out of pi's live settings", () => {
	withAgentDir(JSON.stringify({ compaction: { reserveTokens: 65_536 } }), {}, () => {
		assert.equal(contextCapReserveTokens(), 65_536);
		const caps = resolveTriggers(400_000);
		assert.ok(caps.hard < 400_000 - 65_536, "hard must stay under pi's REAL compact point");
	});
});

test("reserve: malformed or hostile settings fall back instead of throwing", () => {
	for (const body of ["{not json", "{}", '{"compaction":{}}', '{"compaction":{"reserveTokens":"big"}}', '{"compaction":{"reserveTokens":-5}}']) {
		withAgentDir(body, {}, () => {
			assert.equal(contextCapReserveTokens(), CONTEXT_CAP_RESERVE_TOKENS_DEFAULT, body);
		});
	}
});

test("reserve: CONTEXT_CAP_RESERVE overrides the settings file outright", () => {
	withAgentDir(JSON.stringify({ compaction: { reserveTokens: 65_536 } }), { CONTEXT_CAP_RESERVE: "1000" }, () => {
		assert.equal(contextCapReserveTokens(), 1000);
	});
});
