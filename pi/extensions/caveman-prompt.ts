/**
 * caveman-prompt.ts
 *
 * Replaces the default system prompt intro with terse caveman rules via
 * the `before_agent_start` hook. Survives pi updates — no patching needed.
 *
 * The default prompt starts with:
 *   "You are an expert coding assistant operating inside pi..."
 * This extension replaces everything before "Available tools:" with the
 * caveman preamble, preserving the dynamic tools/guidelines/context/skills
 * sections that pi appends.
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

// Marker that separates the intro prose from the dynamic sections
const TOOLS_MARKER = "Available tools:";

// Regex to strip the "Pi documentation" section (header + all bullet lines)
const PI_DOCS_RE = /\n\nPi documentation[^\n]*(\n- [^\n]+)*/g;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = event.systemPrompt;
    const markerIdx = prompt.indexOf(TOOLS_MARKER);
    if (markerIdx === -1) return; // custom prompt or unexpected shape — don't touch

    const dynamicPart = prompt.slice(markerIdx).replace(PI_DOCS_RE, "");
    return { systemPrompt: CAVEMAN_PREAMBLE + dynamicPart };
  });
}
