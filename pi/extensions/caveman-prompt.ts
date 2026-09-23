/**
 * caveman-prompt.ts
 *
 * Replaces the default system prompt intro with terse caveman rules via
 * the `before_agent_start` hook. Survives pi updates — no patching needed.
 *
 * The default prompt starts with:
 *   "You are an expert coding assistant operating inside pi..."
 * This extension replaces everything before the tool list with the caveman
 * preamble, preserving the dynamic tools/rules/context/skills sections that
 * pi appends.
 *
 * Two prompt shapes exist, and both are handled because the marker set covers
 * both (the repo is expected to run on either pi version):
 *   - pi <= 0.85: one flat string — "Available tools:", "Guidelines:",
 *     "Pi documentation ..." as plain prose blocks.
 *   - pi >= 0.86: ordered XML sections joined by blank lines — an untagged
 *     preamble followed by <tools>, <rules>, <docs>, <project_context>,
 *     <skills>, <cwd>. Matching only "Available tools:" silently disabled
 *     this extension on 0.86 (no marker -> no-op -> no caveman rules).
 *
 * Returning `systemPrompt` still means "replace the whole prompt for this run"
 * on 0.86 (pi sets it as `systemPromptOptions.forceSystemPrompt` and projects
 * it as the provider's leading system prompt; the transcript keeps the
 * structured sections). The transform is idempotent, so re-running it over an
 * already-cavemanized prompt is a no-op.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAVEMAN_PREAMBLE = `# RULE HOW TO RESPOND — ALWAYS ACTIVE

Respond terse like smart caveman. All technical substance stay. Only fluff die.

## HARD LIMIT: ≤10 lines

Every response MUST 10 lines or fewer. Only prose/explanation counts — tool calls and code blocks are free.
Lift limit ONLY when user explicitly says: "explain more", "longer", "detail", "elaborate", "no limit", or "full explanation".
After expanded answer, revert to 10-line limit next response.

## Persistence

ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.
Off only: user says "stop caveman" or "normal mode".

## Rules

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging (might/perhaps/I think).
Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for").
Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

## Auto-Clarity

Drop caveman ONLY for:
- Security warnings
- Irreversible action confirmations
- When compression creates technical ambiguity
- User asks to clarify or repeats question

Resume caveman immediately after clear part done.

## Boundaries

Code/commits/PRs: write normal. Tool invocations: normal parameters.

# Tools

`;

// Markers that start the dynamic part, i.e. end the intro prose: flat prompt
// (pi <= 0.85) and sectioned prompt (pi >= 0.86). The earliest match wins, so a
// context file quoting the other marker cannot move the cut.
const TOOLS_MARKERS = ["Available tools:", "<tools>"];

// Strip the pi-documentation block: flat prose (header + bullets) on pi <= 0.85,
// the <docs> section on pi >= 0.86.
const PI_DOCS_RES = [
  /\n\nPi documentation[^\n]*(\n- [^\n]+)*/g,
  /\n*<docs>\nPi documentation[\s\S]*?\n<\/docs>/g,
];

/** Index where pi's dynamic sections start, or -1 for an unknown prompt shape. */
export function findToolsMarker(prompt: string): number {
  let found = -1;
  for (const marker of TOOLS_MARKERS) {
    const idx = prompt.indexOf(marker);
    if (idx !== -1 && (found === -1 || idx < found)) found = idx;
  }
  return found;
}

/** Caveman preamble + pi's dynamic sections, or undefined to leave the prompt alone. */
export function cavemanize(prompt: string): string | undefined {
  const markerIdx = findToolsMarker(prompt);
  if (markerIdx === -1) return undefined; // custom prompt or unexpected shape — don't touch

  let dynamicPart = prompt.slice(markerIdx);
  for (const re of PI_DOCS_RES) dynamicPart = dynamicPart.replace(re, "");
  return CAVEMAN_PREAMBLE + dynamicPart;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const systemPrompt = cavemanize(event.systemPrompt);
    return systemPrompt ? { systemPrompt } : undefined;
  });
}
