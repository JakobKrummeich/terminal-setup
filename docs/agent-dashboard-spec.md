# Agent Dashboard — Spec

Status: agreed 2026-08 (conversation-driven requirements). Not yet built.
Scope owner: `pi/extensions/` (subagent, explore, child-session, context-cap).

## Problem

The F2 overlay (`lib/child-session.ts`) shows a flat list of this process's
children only. Missing:

- **Hierarchy.** A subagent's explorers register in the subagent's own context;
  the user's F2 never sees them. Nothing on disk records who spawned whom.
- **Time.** Only cumulative `elapsedMs` exists — no start/end timestamps, no way
  to see what ran when, or what ran in parallel.
- **Cost/caps.** Per-agent cost and context-cap resets are visible only in the
  final tool result, not aggregated anywhere.

## Decisions

| # | Decision |
|---|----------|
| 1 | Both live monitoring and post-hoc review, from the same data. |
| 2 | Keep the F2 TUI overlay (quick glance + control). Add a browser dashboard; don't replace the TUI. |
| 3 | Browser is read-only in v1. Input later (see phases). |
| 4 | Source of truth on disk: per-project events index `agent-runs.jsonl` beside the session files. Transcripts are NOT duplicated — the existing session JSONLs are read lazily. |
| 5 | Scope: per-project (per encoded cwd). Matches docker-localized workflows. A cross-project view later would just read multiple dirs — no schema change. |
| 6 | Server auto-starts with pi, binds `0.0.0.0`, fixed default port `7357`, override `PI_AGENT_DASH_PORT`. User controls container port mappings. |
| 7 | Server is a stateless disk reader (index + session files + file-watch + SSE). Any pi instance can serve the whole project history. First instance binds the port; later instances detect it and just print the URL. |
| 8 | Timeline = Gantt (rows = agents grouped under parents, x = time, bars = run duration, labels = cost/resets). Clicking a bar opens that agent's session view. |
| 9 | Landing page = session list, newest first, active sessions pinned on top. Click → that session's Gantt + tree. |
| 10 | Retention follows the session JSONLs: no separate limit; index rows whose session file has vanished are pruned. |
| 11 | Desktop browser is the primary client. No mobile-first effort. |
| 12 | No build step: server + static vanilla HTML/JS/CSS served from the extension. Keeps maintenance small. |

## Data layer: `agent-runs.jsonl`

Location: `~/.pi/agent/sessions/<encoded-cwd>/agent-runs.jsonl` (append-only,
same locality and lifetime as the session files it indexes).

Event records (one JSON object per line, `ts` = epoch ms):

```jsonc
// Keys: `sid` = that session's uuid (unique across pi instances sharing this file).
// `root` = the main session's sid (groups one tree). `label` is display-only ("agent#1").
{ "ts": 0, "event": "session-start", "sid": "…", "sessionFile": "…" }                // main session = tree root; root == sid
{ "ts": 0, "event": "spawn",  "sid": "…", "root": "…", "parentSid": "…", "kind": "agent|explorer", "label": "agent#1", "sessionFile": "…", "description": "…" }
{ "ts": 0, "event": "progress", "sid": "…", "turn": 4, "tool": "edit" }              // low-rate heartbeat for live view
{ "ts": 0, "event": "reset",  "sid": "…" }                                           // context-cap handoff happened
{ "ts": 0, "event": "finish", "sid": "…", "status": "done|error|cancelled", "turns": 9, "costUsd": 0.42, "contextTokens": 91000, "contextPercent": 45, "resets": 1, "durationMs": 245000 }
```

Writers: `lib/child-session.ts` (spawn/progress/finish — it already has all the
numbers via `collectMeta`), `context-cap.ts` (reset), session-start hook in the
dashboard extension. `parentId` is known at spawn time because the spawning code
runs inside the parent's session context.

Progress events exist so the *disk* is sufficient for live rendering — required
by decision 7 (any instance may be the server). Keep them coarse (per turn / per
tool change, throttled), not per token.

## Browser UI (v1)

1. **Landing** — table of main sessions: start time, duration, total cost, agent
   count, running/finished. Newest first, running pinned top. SSE-refreshed.
2. **Session page** — Gantt + collapsible tree (main → agents → explorers).
   Bars show duration; labels: cost, resets, turns. Running bars grow live.
3. **Session view (any node)** — scrollable transcript rendered from its JSONL:
   user/assistant messages, collapsible tool calls. Event anchors in a sidebar:
   context handoffs, agent spawns, explorer spawns — click to jump. Spawn
   anchors also link into the child's own session view. Breadcrumb back up the
   tree.

## Phases

- **v1 — read-only** (this spec): index writers, server, SSE, landing, Gantt,
  tree, session views. TUI F2 untouched.
- **v2 — input to live session:** input box on the main session view, POSTs to
  the pi process that owns it; merges into the same in-process queue as TUI
  input (single writer → no file lock needed). Sessions not owned by the
  serving process stay read-only.
- **v3 — resume old sessions from the browser:** boots a session from its
  JSONL (same machinery subagents use). Requires a per-session-file
  single-writer lock — two processes appending the same tree corrupts it. Note:
  `pi --resume` in two terminals already has this hazard today; the lock fixes
  our contribution to it.

Gate: ship v1, use it for ~2 weeks, only then decide on v2/v3.

## Risks

- **Coupling to pi internals.** Transcript rendering and usage extraction read
  pi's session JSONL format; `pi update` can shift it (same class of risk as
  `markdown-no-padding.ts`). Re-verify after pi updates; keep the parser in one
  module.
- **Scope creep.** v2/v3 trend toward reimplementing pi's frontend. The phase
  gate is the guard.
- **Exposure.** `0.0.0.0` + published port serves transcripts to whoever
  reaches it. Acceptable in the current container setups; an optional
  `PI_AGENT_DASH_TOKEN` is an easy later hardening.

## API (v1, implemented)

Server: `pi/extensions/lib/dashboard-server.ts`, auto-started by `agent-dash.ts`
(main session only; skipped when `PI_OFFLINE` or `PI_AGENT_DASH_DISABLE` is set —
the test suite sets `PI_OFFLINE`). Binds `0.0.0.0:$PI_AGENT_DASH_PORT` (default
7357); on EADDRINUSE another pi instance owns the port and we only print the
URL. Listening + accepted sockets are `unref()`ed, so the server never keeps a
pi process alive. Stateless: every request re-reads `agent-runs.jsonl` and the
session JSONLs.

Response types live in `pi/extensions/lib/dashboard-api.ts`; all pi-session-JSONL
parsing in `pi/extensions/lib/session-transcript.ts` (re-verify after `pi update`).

| Endpoint | Response type | Notes |
|---|---|---|
| `GET /api/sessions` | `SessionsResponse` | One `SessionRow` per tree root, newest first. `running` flag; pinning is the client's job. |
| `GET /api/tree?root=<sid>` | `TreeResponse` | `TreeNode[]` for Gantt + tree; 400 without `root`, 404 for unknown sid. |
| `GET /api/transcript?sid=<sid>` | `TranscriptResponse` | Entries + `TranscriptAnchor[]` (handoff / agent-spawn / explorer-spawn, spawn anchors carry `targetSid`). |
| `GET /api/events[?sid=<sid>]` | SSE | `data: {"changed":true}` (debounced ~500ms) on index changes (+ that sid's file); clients refetch. No replay. |
| `GET /` + assets | static | `lib/dashboard-ui/` (placeholder page until phase 3), traversal-safe. |

Liveness heuristic (`ACTIVE_WINDOW_MS`, 120 s): a tree is *running* iff its
newest index-event ts or the root session file's mtime is younger than the
window. Children: latest finish row covering all spawn/progress activity →
that finish's status; otherwise *running* while fresh, *abandoned* once stale
(owning process likely died).

## Open questions (fine to settle during v1 build)

- Gantt rendering: hand-rolled SVG vs CSS grid (no external lib either way).
- Exact throttle for `progress` events.
- Whether the F2 picker should later read the index too (would let it show
  grandchildren) — out of scope for v1.
