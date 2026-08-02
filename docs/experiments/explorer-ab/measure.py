#!/usr/bin/env python3
"""Extract one run's metrics from its isolated session dir, diff and test output.

Cost is summed over every session file in the run directory, so subagent and
explorer spend is included by construction. The proxy's SQLite log deliberately
is not used: the operator's own pi session hits the same proxy on the same model.
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path


def session_files(run_dir: Path) -> list[Path]:
    return sorted(run_dir.glob("sessions/**/*.jsonl"))


def parse_session(path: Path):
    cost = 0.0
    tool_calls = Counter()
    context_tokens = 0
    for line in path.read_text(errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        cost += float((usage.get("cost") or {}).get("total") or 0.0)
        total_tokens = usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
        context_tokens = max(context_tokens, total_tokens)
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "toolCall":
                tool_calls[block.get("name", "?")] += 1
    return cost, tool_calls, context_tokens


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--arm", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--wall", type=float, required=True)
    ap.add_argument("--pi-exit", type=int, required=True)
    ap.add_argument("--test-exit", type=int, required=True)
    args = ap.parse_args()

    run_dir = Path(args.run_dir)
    files = session_files(run_dir)
    # The parent session is the one holding Explorer/Agent tool calls; children are
    # separate files. Largest file is a poor proxy, so: parent = oldest by name.
    total_cost = 0.0
    parent_tools = Counter()
    all_tools = Counter()
    parent_context = 0
    per_file = []
    for index, path in enumerate(files):
        cost, tools, context = parse_session(path)
        total_cost += cost
        all_tools += tools
        if index == 0:
            parent_tools = tools
            parent_context = context
        per_file.append({"file": path.name, "cost": round(cost, 4), "tools": dict(tools)})

    diff = (run_dir / "solution.diff").read_text(errors="replace") if (run_dir / "solution.diff").exists() else ""
    stat = (run_dir / "solution.stat").read_text(errors="replace") if (run_dir / "solution.stat").exists() else ""
    test_out = (run_dir / "test.txt").read_text(errors="replace") if (run_dir / "test.txt").exists() else ""

    def grab(pattern: str) -> int:
        match = re.search(pattern, test_out)
        return int(match.group(1)) if match else -1

    print(json.dumps({
        "run_id": args.run_id,
        "arm": args.arm,
        "task": args.task,
        "wall_s": round(args.wall, 1),
        "pi_exit": args.pi_exit,
        "cost_usd": round(total_cost, 4),
        "explorer_calls": parent_tools.get("Explorer", 0),
        "agent_calls": parent_tools.get("Agent", 0),
        "parent_tool_calls": sum(parent_tools.values()),
        "all_tool_calls": sum(all_tools.values()),
        "parent_tools": dict(parent_tools),
        "parent_context_tokens": parent_context,
        "session_files": len(files),
        "per_session": per_file,
        "files_changed": len([l for l in stat.splitlines() if "|" in l]),
        "diff_lines": len(diff.splitlines()),
        "tests_pass": grab(r"# pass (\d+)"),
        "tests_fail": grab(r"# fail (\d+)"),
        "test_exit": args.test_exit,
    }, indent=2))


if __name__ == "__main__":
    main()
