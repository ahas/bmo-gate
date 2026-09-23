"""Trains the same data under the plain settings and under each memory saving, and measures every run
the same way, so a saving is only used where it costs nothing (docs/laya-server.md, 「What the savings cost」).

    .venv/bin/python compare.py --data data/<name> --out runs/<name> [--seed 1] [--seed 2] [--run base]

Each run is finetune.py followed by calibrate.py: the temperatures are fitted on the calibration split
and the figures are read off the test split, which neither the training nor the fit has seen. The
figure to read is the balanced agreement — a gate whose verdicts are nearly all one answer is agreed
with just as often by a model that always gives that answer — beside the calibration error. A run
whose checkpoint is finished is measured again rather than trained again, and one that was killed
partway is carried on from its newest step checkpoint, so an interrupted sweep goes on where it
stopped without either retraining what is done or measuring what is half done.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import resume as resume_state  # noqa: E402

# What each run adds to the plain settings. The plain one is the bar the others are held to.
RUNS: Dict[str, List[str]] = {
    "base": [],
    "freeze": ["--freeze-embeddings"],
    "adamw8bit": ["--optimizer", "adamw8bit"],
    "freeze-adamw8bit": ["--freeze-embeddings", "--optimizer", "adamw8bit"],
    "micro4": ["--micro-batch", "4"],
}


def run_python(script: str, arguments: List[str], log_path: str) -> str:
    """One script of this folder in this venv, its output kept in a log and handed back."""
    here = os.path.dirname(os.path.abspath(__file__))
    result = subprocess.run(
        [sys.executable, os.path.join(here, script), *arguments],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=here,
    )
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(result.stdout)
        log.write(result.stderr)
    if result.returncode != 0:
        sys.exit(f"compare: {script} failed ({result.returncode})\n{result.stderr[-2000:]}")
    return result.stdout


def last_json(text: str) -> Dict[str, Any]:
    """The JSON object a script ends with, whatever it printed as it went."""
    start = text.rfind("\n{")
    return json.loads(text[start + 1:] if start >= 0 else text)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="the folder laya-dataset wrote")
    parser.add_argument("--out", required=True, help="where the checkpoints, the logs and the reports go")
    parser.add_argument("--run", action="append", default=None, choices=sorted(RUNS), help="only these runs; all of them by default")
    parser.add_argument("--seed", action="append", type=int, default=None, help="a seed to train under; 1, 2 and 3 by default")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--micro-batch", type=int, default=8, help="the plain micro-batch, which the micro4 run halves")
    args = parser.parse_args()

    names = args.run or sorted(RUNS)
    seeds = args.seed or [1, 2, 3]
    os.makedirs(args.out, exist_ok=True)

    measured: List[Dict[str, Any]] = []
    for name in names:
        for seed in seeds:
            tag = f"{name}-s{seed}"
            checkpoint = os.path.join(args.out, tag)
            started = time.time()
            training = None
            # What is already there decides: the marker says a run finished, and a directory alone says
            # only that one started — a rolling save makes it long before the training is done, so a
            # half-trained checkpoint read as finished would be measured and never trained.
            action = resume_state.run_action(checkpoint)
            if action == "stuck":
                sys.exit(f"compare: {checkpoint} was started and did not finish, and holds nothing to carry on from; "
                         "look at it and remove it yourself — a checkpoint is not deleted on our own account")
            if action in ("train", "resume"):
                where = ["--out", checkpoint] if action == "train" else ["--resume", checkpoint]
                training = last_json(run_python("finetune.py", [
                    "--data", args.data, *where, "--seed", str(seed),
                    "--epochs", str(args.epochs), "--micro-batch", str(args.micro_batch), *RUNS[name],
                ], os.path.join(args.out, f"{tag}-train.log")))
            report = last_json(run_python("calibrate.py", [
                "--model", checkpoint, "--data", args.data, "--write",
            ], os.path.join(args.out, f"{tag}-calibrate.log")))
            entry = {"run": name, "seed": seed, "training": training, "calibration": report,
                     "seconds": round(time.time() - started, 1)}
            measured.append(entry)
            with open(os.path.join(args.out, f"{tag}.json"), "w", encoding="utf-8") as handle:
                json.dump(entry, handle, ensure_ascii=False, indent=2)
            after = report["after"]
            peak = None if training is None else round(training["peak_reserved_bytes"] / 1e9, 2)
            print(f"{tag}: balanced {after['balanced']:.3f} · agreement {after['agreement']:.3f} · "
                  f"ece {after['ece']:.3f} · peak {peak} GB · {entry['seconds']:.0f}s", flush=True)

    print(json.dumps(measured, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
