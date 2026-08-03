#!/usr/bin/env python3
"""Round-2 metrics: context per caller, explorer use by parent AND subagents, cost, tests.

Session roles are read off the model, which is unambiguous here: the explorer runs on
haiku, everything else on opus, and the parent is the oldest session file in the run dir.
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path


def parse_session(path: Path):
    """Return (model, cost, tool_calls, peak_context_tokens, end_context_tokens)."""
    model = "?"
    cost = 0.0
    tools = Counter()
    peak = 0
    last = 0
    for line in path.read_text(errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "model_change" and entry.get("modelId"):
            model = entry["modelId"]
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if message.get("role") != "assistant":
            continue
        if message.get("model"):
            model = message["model"]
        usage = message.get("usage") or {}
        cost += float((usage.get("cost") or {}).get("total") or 0.0)
        context = usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
        peak = max(peak, context)
        last = context
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "toolCall":
                tools[block.get("name", "?")] += 1
    return model, cost, tools, peak, last


def main() -> None:
    ap = argparse.ArgumentParser()
    for flag in ("run-dir", "arm", "task", "run-id"):
        ap.add_argument(f"--{flag}", required=True)
    ap.add_argument("--wall", type=float, required=True)
    for flag in ("pi-exit", "backend-exit", "frontend-exit", "typecheck-exit"):
        ap.add_argument(f"--{flag}", type=int, required=True)
    args = ap.parse_args()

    run_dir = Path(args.run_dir)
    files = sorted(run_dir.glob("sessions/**/*.jsonl"))

    sessions = []
    for index, path in enumerate(files):
        model, cost, tools, peak, last = parse_session(path)
        role = "explorer" if "haiku" in model else ("parent" if index == 0 else "subagent")
        sessions.append({
            "role": role, "model": model, "cost": round(cost, 4),
            "tool_calls": sum(tools.values()), "tools": dict(tools),
            "peak_context": peak, "end_context": last,
        })

    parent = next((s for s in sessions if s["role"] == "parent"), None)
    subagents = [s for s in sessions if s["role"] == "subagent"]
    explorers = [s for s in sessions if s["role"] == "explorer"]

    def read(name: str) -> str:
        path = run_dir / name
        return path.read_text(errors="replace") if path.exists() else ""

    backend = read("test-backend.txt")
    frontend = read("test-frontend.txt")
    stat = read("solution.stat")

    backend_pass = sum(int(n) for n in re.findall(r"Passed:\s+(\d+)", backend))
    backend_fail = sum(int(n) for n in re.findall(r"Failed:\s+(\d+)", backend))
    frontend_match = re.search(r"Tests:\s+(\d+) passed", frontend)

    # Context spent by callers (everything that can call Explorer), i.e. excluding explorers.
    caller_sessions = [s for s in sessions if s["role"] != "explorer"]

    print(json.dumps({
        "run_id": args.run_id, "arm": args.arm, "task": args.task,
        "wall_s": round(args.wall, 1), "pi_exit": args.pi_exit,
        "cost_usd": round(sum(s["cost"] for s in sessions), 4),
        "cost_explorers": round(sum(s["cost"] for s in explorers), 4),
        "parent_peak_context": parent["peak_context"] if parent else 0,
        "parent_end_context": parent["end_context"] if parent else 0,
        "parent_tool_calls": parent["tool_calls"] if parent else 0,
        "caller_peak_context_sum": sum(s["peak_context"] for s in caller_sessions),
        "explorer_calls_parent": (parent["tools"].get("Explorer", 0) if parent else 0),
        "explorer_calls_subagent": sum(s["tools"].get("Explorer", 0) for s in subagents),
        "agent_calls": (parent["tools"].get("Agent", 0) if parent else 0),
        "subagents": len(subagents),
        "explorer_sessions": len(explorers),
        "explorer_tool_calls": sum(s["tool_calls"] for s in explorers),
        "sessions": sessions,
        "files_changed": len([l for l in stat.splitlines() if "|" in l]),
        "diff_lines": len(read("solution.diff").splitlines()),
        "backend_pass": backend_pass, "backend_fail": backend_fail,
        "frontend_pass": int(frontend_match.group(1)) if frontend_match else -1,
        "backend_exit": args.backend_exit, "frontend_exit": args.frontend_exit,
        "typecheck_exit": args.typecheck_exit,
    }, indent=2))


if __name__ == "__main__":
    main()
