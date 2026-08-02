#!/usr/bin/env python3
"""Blinded judging: build per-task judge packets, run a fresh pi session, unblind afterwards.

The judge sees two diffs in a randomised order and the test outcome of each. It never sees
arm labels, costs, tool logs or this file's key. The key is written before judging and read
only when scoring is finished, so the mapping cannot influence the scores.
"""
import argparse
import json
import random
import re
import subprocess
from pathlib import Path

ROOT = Path("/tmp/explorer-ab")
HERE = Path(__file__).resolve().parent
JUDGE_DIR = ROOT / "judge"
import os
JUDGE_DIR = ROOT / os.environ.get("JUDGE_DIR_NAME", "judge")

RUBRIC = """You are reviewing two independent solutions to the same task in the same TypeScript
repository. They were produced by two different automated attempts. You know nothing else about
them, and there is no expected or "reference" answer.

Score each solution on two axes, 0-10, whole numbers:

- CORRECTNESS: does it actually achieve what the task asked, are the edge cases and stated
  acceptance criteria handled, is the behaviour it claims supported by its tests?
- QUALITY: fit with the conventions of the surrounding codebase, clarity, test quality,
  proportionality (neither under-built nor over-engineered), absence of dead or speculative code.

Then state a forced overall preference: exactly one of "solution-1" or "solution-2". No ties.

Read the diffs carefully before scoring; the repository is available in the current working
directory if you want to check how the surrounding code does things. Do not modify anything.

Answer in exactly this format, nothing else:

solution-1 correctness: <n>
solution-1 quality: <n>
solution-2 correctness: <n>
solution-2 quality: <n>
preference: <solution-1|solution-2>
reasoning: <4-8 sentences comparing them concretely>
"""


def build_packet(task: str, seed: int) -> dict:
    control = ROOT / f"main-{task}-control"
    treatment = ROOT / f"main-{task}-treatment"
    pairs = [("control", control), ("treatment", treatment)]
    if os.environ.get("JUDGE_ORDER") == "treatment-first":
        pairs = [("treatment", treatment), ("control", control)]
    elif os.environ.get("JUDGE_ORDER") == "control-first":
        pairs = [("control", control), ("treatment", treatment)]
    else:
        random.Random(seed).shuffle(pairs)
    mapping = {f"solution-{i + 1}": arm for i, (arm, _) in enumerate(pairs)}

    packet_dir = JUDGE_DIR / task
    packet_dir.mkdir(parents=True, exist_ok=True)
    for i, (_, run_dir) in enumerate(pairs):
        label = f"solution-{i + 1}"
        (packet_dir / f"{label}.diff").write_text((run_dir / "solution.diff").read_text(errors="replace"))
        test_text = (run_dir / "test.txt").read_text(errors="replace")
        passed = re.search(r"# pass (\d+)", test_text)
        failed = re.search(r"# fail (\d+)", test_text)
        (packet_dir / f"{label}.tests.txt").write_text(
            f"test suite result: {passed.group(1) if passed else '?'} passing, "
            f"{failed.group(1) if failed else '?'} failing\n"
        )
    (packet_dir / "task.md").write_text((HERE / "tasks" / f"{task}.md").read_text())
    return mapping


def run_judge(task: str) -> str:
    packet_dir = JUDGE_DIR / task
    prompt = (
        f"{RUBRIC}\n\nTASK GIVEN TO BOTH SOLUTIONS:\n\n"
        f"{(packet_dir / 'task.md').read_text()}\n\n"
        f"SOLUTION-1 TEST RESULT:\n{(packet_dir / 'solution-1.tests.txt').read_text()}\n"
        f"SOLUTION-2 TEST RESULT:\n{(packet_dir / 'solution-2.tests.txt').read_text()}\n"
        f"SOLUTION-1 DIFF:\n\n{(packet_dir / 'solution-1.diff').read_text()}\n\n"
        f"SOLUTION-2 DIFF:\n\n{(packet_dir / 'solution-2.diff').read_text()}\n"
    )
    (packet_dir / "prompt.txt").write_text(prompt)
    result = subprocess.run(
        ["pi", "-p", "--no-session", "--model", "anthropic/claude-opus-5",
         "--exclude-tools", "edit,write,bash,Explorer,Agent,timer", prompt],
        cwd=str(ROOT / f"main-{task}-control" / "repo"),
        capture_output=True, text=True, timeout=1800,
    )
    output = re.sub(r"\x1bP?tmux[^\\]*\\|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", result.stdout)
    (packet_dir / "verdict.txt").write_text(output)
    return output


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="t1,t2,t3")
    ap.add_argument("--seed", type=int, default=20260802)
    args = ap.parse_args()

    JUDGE_DIR.mkdir(parents=True, exist_ok=True)
    keys = {}
    for offset, task in enumerate(args.tasks.split(",")):
        keys[task] = build_packet(task, args.seed + offset)
    (JUDGE_DIR / "key.json").write_text(json.dumps(keys, indent=2))

    for task in args.tasks.split(","):
        print(f"=== judging {task} ===", flush=True)
        print(run_judge(task), flush=True)

    print("=== unblinding key ===")
    print(json.dumps(keys, indent=2))


if __name__ == "__main__":
    main()
