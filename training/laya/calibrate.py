"""Fits a Laya checkpoint's temperatures on the calibration rows and measures it on the test rows
(docs/laya-server.md, 「The training loop and calibration」).

    .venv/bin/python calibrate.py --model <checkpoint dir> --data <dir the merge wrote> [--write]

One temperature per (question type, option count) bucket — the buckets Laya's runtime reads — fitted
by LBFGS on the calibration split, as the model card advises, with one per question type besides as
the fallback for a bucket too small to fit. The fit is the package's own (`laya.calibrate`), each
option count within its own width and every temperature held to the range the runtime applies at load.
It prints the calibration error and the agreement with the LLM's verdicts on the test split, which
neither the training nor the fit has seen, under the checkpoint's own temperatures and under the fitted
ones, and how many questions of each split were left out and why, as the training leaves them out;
`--write` puts the fitted ones into the checkpoint's rl_agent_config.json, the per-option-count
temperatures it carried dropped first.

It also writes the machine-readable report the verification table is assembled from
(docs/training.md, 「The tables」): per gate the agreement plain and balanced, the
calibration error and the counts behind them, the same figures for the base model measured on the
very same rows so the difference is computed rather than left to a reader, and — for a gate that
declares one answer settleable — how many calls that answer would have missed at each threshold.
Which answer a gate may settle is that gate's own declaration and is given with `--asymmetric`.

With `--card-lock` it holds the node's card as a turn that gives way, as a training does (finetune.py):
told that an occupant above it wants the card, it parks the model after the batch in hand and takes the
card back once it has stood quiet. It lets the card go while it fits on the CPU, and asks for it again
before the base model goes on.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

os.environ.setdefault("USE_TF", "0")

import numpy as np  # noqa: E402
import torch  # noqa: E402

import laya  # noqa: E402
from laya.calibrate import fit_one_temperature  # noqa: E402
from laya.common import QTYPE_NAMES, ece_score, temp_bucket  # noqa: E402

import metrics  # noqa: E402
from finetune import base_dir, collate, counted_into, row_items, without_option_temperatures  # noqa: E402
from parking import HeldCard  # noqa: E402

# The report file, written into the checkpoint itself so it travels with it.
REPORT_NAME = "calibration.json"

# A bucket with fewer held-out questions than this keeps the per-type temperature, as the notebook
# keeps 1.0 for a type with too few.
MIN_BUCKET = 10


def fit_one_temp(samples: List[Tuple[np.ndarray, List[float]]]) -> float:
    """The temperature that best explains the gold distributions, fitted by the package's own fitter and
    held to the range Laya's runtime will apply."""
    return fit_one_temperature(samples, min_n=MIN_BUCKET)


def calibrated_config(cfg: Dict[str, Any], temperature: List[float], by_bucket: Dict[str, float]) -> Dict[str, Any]:
    """The checkpoint's configuration with the fitted temperatures in it. The per-option-count ones it
    carried go first, so a bucket this fit leaves out falls back to its type's fitted temperature rather
    than to one left by another fit."""
    written = {**without_option_temperatures(cfg), "temperature": list(temperature)}
    if by_bucket:
        written["temperature_by_options"] = dict(by_bucket)
    return written


def split_logits(agent, path: str, card: HeldCard, quiet_s: float,
                 skipped: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
    """Every question of one split with its raw logits: the question type, the logits, the gold
    distribution, the gate it came from, the question's own name and the answers it may be given. The
    questions the training would leave out are left out here too, counted by reason into `skipped`. The
    card is given way between batches where an occupant above asks for it."""
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                questions = json.loads(row["questions"])
                items, left_out = row_items(agent.tok, agent.cfg, row)
                if skipped is not None:
                    counted_into(skipped, left_out)
                for qid, item in items:
                    rows.append((item, row["gate"], qid, metrics.answer_names(questions[qid])))
    out = []
    agent.model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), 16):
            chunk = rows[start:start + 16]
            batch = collate([item for item, _, _, _ in chunk], agent.tok.pad_token_id)
            with torch.autocast(agent.device.type, dtype=agent.dtype, enabled=agent.device.type == "cuda"):
                logits, _ = agent.model(*(batch[key].to(agent.device) for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")))
            values = logits.float().cpu().numpy()
            del logits
            if card.asked_for() is not None:
                card.give_way(agent.model, None, agent.device, quiet_s)
            for index, (item, gate, qid, answers) in enumerate(chunk):
                k = len(item["markers"])
                out.append({
                    "qtype": item["qtype"], "z": values[index, :k], "gold": item["target"],
                    "gate": gate, "question": qid, "answers": answers,
                })
    return out


def judge(samples: List[Dict[str, Any]], by_type: List[float], by_bucket: Dict[str, float]) -> List[Dict[str, Any]]:
    """One record per question as the metrics read it: which answer the gold gave, which the model
    gives under these temperatures, and how sure it is."""
    judged = []
    for one in samples:
        t = temperature_for(one["qtype"], len(one["z"]), by_type, by_bucket)
        p = np.exp(one["z"] / t - (one["z"] / t).max())
        p = p / p.sum()
        judged.append({
            "gate": one["gate"], "question": one["question"], "answers": one["answers"],
            "gold": int(np.argmax(one["gold"])), "predicted": int(p.argmax()), "confidence": float(p.max()),
        })
    return judged


def ece_of(confidence: List[float], correct: List[float]) -> float:
    """Laya's own calibration error, over plain lists, so the metrics module needs neither numpy's
    types nor laya itself to be read."""
    return ece_score(np.array(confidence), np.array(correct))


def temperature_for(qtype: int, k: int, by_type: List[float], by_bucket: Dict[str, float]) -> float:
    return by_bucket.get(temp_bucket(qtype, k), by_type[qtype])


def base_of(model: str) -> str:
    """The checkpoint this one was trained from, as its own training wrote down, so the difference is
    measured against the model that was actually improved on rather than against whatever the hub
    holds today. A checkpoint that says nothing falls back to the hub's."""
    meta = os.path.join(model, "train_meta.json")
    if os.path.exists(meta):
        try:
            with open(meta, encoding="utf-8") as handle:
                said = json.load(handle).get("base")
            if isinstance(said, str) and os.path.isdir(said):
                return said
        except (OSError, ValueError):
            pass
    return base_dir(None)


def balanced(correct: np.ndarray, answers: np.ndarray) -> float:
    """Agreement averaged over the answers the LLM gave, each answer weighing the same however often it
    was given. A gate whose verdicts are nearly all one answer — the reference classifier says no to
    almost every candidate — is agreed with just as often by a model that always gives that answer, and
    this is the figure that tells the two apart."""
    return float(np.mean([correct[answers == answer].mean() for answer in np.unique(answers)]))


def measure(samples, by_type: List[float], by_bucket: Dict[str, float]) -> Dict[str, Any]:
    """Calibration error and agreement with the LLM's majority verdict, overall and per gate, plain and
    balanced over the answers."""
    confidence, correct, gates, answers = [], [], [], []
    for one in samples:
        qtype, z, gold, gate = one["qtype"], one["z"], one["gold"], one["gate"]
        t = temperature_for(qtype, len(z), by_type, by_bucket)
        p = np.exp(z / t - (z / t).max())
        p = p / p.sum()
        confidence.append(float(p.max()))
        correct.append(float(int(p.argmax()) == int(np.argmax(gold))))
        gates.append(gate)
        answers.append(f"{qtype}:{int(np.argmax(gold))}")
    confidence, correct, answers = np.array(confidence), np.array(correct), np.array(answers)
    per_gate = {}
    for gate in sorted(set(gates)):
        chosen = np.array([one == gate for one in gates])
        per_gate[gate] = {
            "questions": int(chosen.sum()),
            "agreement": round(float(correct[chosen].mean()), 4),
            "balanced": round(balanced(correct[chosen], answers[chosen]), 4),
            "ece": round(ece_score(confidence[chosen], correct[chosen]), 4),
        }
    return {
        "questions": len(samples),
        "agreement": round(float(correct.mean()), 4) if len(samples) else None,
        "balanced": round(balanced(correct, answers), 4) if len(samples) else None,
        "ece": round(ece_score(confidence, correct), 4) if len(samples) else None,
        "gates": per_gate,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="the checkpoint directory to calibrate")
    parser.add_argument("--data", required=True, help="the folder laya-dataset wrote (calibration.jsonl and test.jsonl are read)")
    parser.add_argument("--write", action="store_true", help="put the fitted temperatures into the checkpoint")
    parser.add_argument("--base", default=None,
                        help="the checkpoint to measure against; the one this was trained from by default")
    parser.add_argument("--no-base", action="store_true",
                        help="measure this checkpoint alone, without the base beside it")
    parser.add_argument("--report", default=None,
                        help=f"where the machine-readable report goes; <model>/{REPORT_NAME} by default")
    parser.add_argument("--asymmetric", action="append", default=None, metavar="GATE:QUESTION:ANSWER",
                        help="a gate's own declaration that Laya may settle this one answer of this question")
    parser.add_argument("--card-lock", default=None, metavar="PATH",
                        help="hold the node's card lock at PATH as a turn that gives way, declared as BMO_CARD_SERVICE")
    parser.add_argument("--quiet-s", type=float, default=30.0,
                        help="after giving way, how long the card stands quiet before it is asked for again")
    args = parser.parse_args()

    try:
        rules = [metrics.parse_asymmetric(one) for one in (args.asymmetric or [])]
    except ValueError as fault:
        sys.exit(f"calibrate: {fault}")

    config_path = os.path.join(args.model, "rl_agent_config.json")
    card = HeldCard(args.card_lock, args.model)
    agent = laya.load(args.model, device="cuda")
    skipped: Dict[str, Dict[str, int]] = {"calibration": {}, "test": {}}
    fitting = split_logits(agent, os.path.join(args.data, "calibration.jsonl"), card, args.quiet_s, skipped["calibration"])
    samples = split_logits(agent, os.path.join(args.data, "test.jsonl"), card, args.quiet_s, skipped["test"])
    if not fitting:
        sys.exit("calibrate: calibration.jsonl holds nothing to calibrate on")
    if not samples:
        sys.exit("calibrate: test.jsonl holds nothing to measure on")

    # What is left is work on the CPU, so the model comes off the card and the card is let go meanwhile.
    temperature, temperature_by_options = list(agent.temperature), dict(agent.temperature_by_options)
    del agent
    card.put_down("cuda")

    before = measure(samples, temperature, temperature_by_options)

    by_type = list(temperature)
    for qtype in range(len(QTYPE_NAMES)):
        chosen = [(one["z"], one["gold"]) for one in fitting if one["qtype"] == qtype]
        if len(chosen) >= MIN_BUCKET:
            by_type[qtype] = fit_one_temp(chosen)
    buckets: Dict[str, List[Tuple[np.ndarray, List[float]]]] = defaultdict(list)
    for one in fitting:
        buckets[temp_bucket(one["qtype"], len(one["z"]))].append((one["z"], one["gold"]))
    by_bucket = {bucket: fit_one_temp(chosen) for bucket, chosen in sorted(buckets.items()) if len(chosen) >= MIN_BUCKET}

    after = measure(samples, by_type, by_bucket)
    judged = judge(samples, by_type, by_bucket)

    # The base is measured on the very same rows, so the difference is one number rather than two runs
    # a reader is left to subtract.
    base_where = args.base or base_of(args.model)
    base_judged, base_model = None, None
    if not args.no_base and os.path.abspath(base_where) != os.path.abspath(args.model):
        card.take_up()
        base_agent = laya.load(base_where, device="cuda")
        base_judged = judge(split_logits(base_agent, os.path.join(args.data, "test.jsonl"), card, args.quiet_s),
                            list(base_agent.temperature), dict(base_agent.temperature_by_options))
        base_model = base_where
        del base_agent
    card.let_go("cuda")

    counted = metrics.report(
        model=args.model, data=args.data, judged=judged, base_judged=base_judged, base_model=base_model,
        rules=rules, ece=ece_of, written_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    )

    report = {
        "model": args.model,
        "buckets": {bucket: len(chosen) for bucket, chosen in sorted(buckets.items())},
        "skipped": skipped,
        "temperature": [round(t, 4) for t in by_type],
        "temperature_by_options": {bucket: round(t, 4) for bucket, t in by_bucket.items()},
        "before": before,
        "after": after,
        "written": False,
        "report": counted,
    }

    if args.write:
        with open(config_path) as handle:
            cfg = calibrated_config(json.load(handle), report["temperature"], report["temperature_by_options"])
        with open(config_path, "w") as handle:
            json.dump(cfg, handle, indent=2)
        report["written"] = True

    where = args.report or os.path.join(args.model, REPORT_NAME)
    os.makedirs(os.path.dirname(os.path.abspath(where)), exist_ok=True)
    with open(where, "w", encoding="utf-8") as handle:
        json.dump(counted, handle, ensure_ascii=False, indent=2)
    report["report_path"] = where

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
