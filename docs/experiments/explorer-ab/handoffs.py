#!/usr/bin/env python3
"""Post-hoc extraction of context-cap pressure per run, for any round.

Round 3's tasks saturate the context window: every run peaks at ~161k, which is the context-cap
extension's threshold, so `parent_peak_context` stops discriminating between arms. What does
discriminate is how often the cap actually fired:

- `cap_warnings`  — "CONTEXT LIMIT WARNING" injections by the context-cap extension (any session)
- `handoffs_*`    — `context_handoff` tool calls, i.e. forced session swaps where the session is
                    thrown away and replaced by a summary. Each one is work lost to compaction.

Handoff counts come from the per-session tool histograms measure2.py already wrote; warnings are
counted in the raw session files. Usage: handoffs.py <run-dir>... — prints one line per run and
patches the run's result.json.
"""
import json
import sys
from pathlib import Path


def scan(run_dir: Path) -> dict:
    rj = run_dir / "result.json"
    if not rj.exists():
        return {}
    result = json.loads(rj.read_text())
    parent = sub = 0
    for session in result["sessions"]:
        n = session.get("tools", {}).get("context_handoff", 0)
        if session["role"] == "parent":
            parent += n
        else:
            sub += n
    warnings = sum(
        f.read_text(errors="replace").count("CONTEXT LIMIT WARNING")
        for f in (run_dir / "sessions").glob("*.jsonl")
    )
    out = {
        "cap_warnings": warnings,
        "handoffs_parent": parent,
        "handoffs_subagent": sub,
        "handoffs_total": parent + sub,
    }
    result.update(out)
    rj.write_text(json.dumps(result, indent=2))
    return {"run_id": result["run_id"], **out}


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        info = scan(Path(arg))
        if info:
            print(json.dumps(info))
