#!/usr/bin/env python3
"""Round-2 blinded judging. Same rubric and blinding rules as judge.py, adapted to the
round-2 run ids (r2-<task>-<arm>), task briefs (tasks2/) and test outputs (backend + frontend).

The judge sees two diffs in a fixed, externally chosen order (JUDGE_ORDER) and the test outcome
of each. It never sees arm labels, costs, tool logs or the key. Every task pair is judged in both
orderings; the key is unblinded only after all scores are written.
"""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path("/tmp/explorer-ab")
HERE = Path(__file__).resolve().parent
JUDGE_DIR = ROOT / os.environ.get("JUDGE_DIR_NAME", "judge2")

RUBRIC = """You are reviewing two independent solutions to the same task in the same repository
(a C# backend and a TypeScript/React frontend). They were produced by two different automated
attempts. You know nothing else about them, and there is no expected or "reference" answer.

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


def tests_line(run_dir: Path) -> str:
    be = (run_dir / "test-backend.txt").read_text(errors="replace")
    fe = (run_dir / "test-frontend.txt").read_text(errors="replace")
    be_pass = sum(int(m) for m in re.findall(r"Passed:\s+(\d+)", be))
    be_fail = sum(int(m) for m in re.findall(r"Failed:\s+(\d+)", be))
    fe_m = re.search(r"Tests:\s+(?:(\d+) failed, )?(\d+) passed", fe)
    fe_fail = int(fe_m.group(1)) if fe_m and fe_m.group(1) else 0
    fe_pass = int(fe_m.group(2)) if fe_m else 0
    return (f"backend tests: {be_pass} passing, {be_fail} failing\n"
            f"frontend tests: {fe_pass} passing, {fe_fail} failing\n")


def build_packet(task: str) -> dict:
    pairs = [("control", ROOT / f"r2-{task}-control"), ("treatment", ROOT / f"r2-{task}-treatment")]
    if os.environ.get("JUDGE_ORDER") == "treatment-first":
        pairs.reverse()
    mapping = {f"solution-{i + 1}": arm for i, (arm, _) in enumerate(pairs)}

    packet_dir = JUDGE_DIR / task
    packet_dir.mkdir(parents=True, exist_ok=True)
    for i, (_, run_dir) in enumerate(pairs):
        label = f"solution-{i + 1}"
        (packet_dir / f"{label}.diff").write_text((run_dir / "solution.diff").read_text(errors="replace"))
        (packet_dir / f"{label}.tests.txt").write_text(tests_line(run_dir))
    (packet_dir / "task.md").write_text((HERE / "tasks2" / f"{task}.md").read_text())
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
        cwd="/home/dev/.cache/vw-frozen",
        capture_output=True, text=True, timeout=3600,
    )
    output = re.sub(r"\x1bP?tmux[^\\]*\\|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", result.stdout)
    (packet_dir / "verdict.txt").write_text(output)
    return output


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="r1,r2,r3,r4,r5,r6")
    args = ap.parse_args()

    JUDGE_DIR.mkdir(parents=True, exist_ok=True)
    keys = {task: build_packet(task) for task in args.tasks.split(",")}
    (JUDGE_DIR / "key.json").write_text(json.dumps(keys, indent=2))

    for task in args.tasks.split(","):
        print(f"=== judging {task} ===", flush=True)
        print(run_judge(task), flush=True)

    print("=== unblinding key ===")
    print(json.dumps(keys, indent=2))


if __name__ == "__main__":
    main()
