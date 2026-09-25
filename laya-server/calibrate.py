"""Fits a Laya checkpoint's temperatures on the calibration rows and measures it on the test rows
(docs/laya-server.md, 「The training loop and calibration」).

    .venv/bin/python calibrate.py --model <checkpoint dir> --data <dir the merge wrote> [--write]

One temperature per (question type, option count) bucket — the buckets Laya's runtime reads — fitted
by LBFGS on the calibration split, as the model card advises, with one per question type besides as
the fallback for a bucket too small to fit. It prints the calibration error and the agreement with
the LLM's verdicts on the test split, which neither the training nor the fit has seen, under the
checkpoint's own temperatures and under the fitted ones; `--write` puts the fitted ones into the
checkpoint's rl_agent_config.json.

It also writes the machine-readable report the verification table is assembled from
(docs/training.md, 「The tables」): per gate the agreement plain and balanced, the
calibration error and the counts behind them, the same figures for the base model measured on the
very same rows so the difference is computed rather than left to a reader, and — for a gate that
declares one answer settleable — how many calls that answer would have missed at each threshold.
Which answer a gate may settle is that gate's own declaration and is given with `--asymmetric`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Tuple

os.environ.setdefault("USE_TF", "0")

import numpy as np  # noqa: E402
import torch  # noqa: E402

import laya  # noqa: E402
from laya.common import QTYPE_NAMES, TEMP_MAX, TEMP_MIN, ece_score, temp_bucket  # noqa: E402

import metrics  # noqa: E402
from finetune import base_dir, collate, training_item  # noqa: E402

# The report file, written into the checkpoint itself so it travels with it.
REPORT_NAME = "calibration.json"

# A bucket with fewer held-out questions than this keeps the per-type temperature, as the notebook
# keeps 1.0 for a type with too few.
MIN_BUCKET = 10


def fit_one_temp(samples: List[Tuple[np.ndarray, List[float]]]) -> float:
    """The temperature that best explains the gold distributions, fitted as the notebook fits it and
    held to the range Laya's runtime will apply."""
    kmax = max(len(z) for z, _ in samples)
    logits = torch.full((len(samples), kmax), -1e4)
    target = torch.zeros((len(samples), kmax))
    for index, (z, gold) in enumerate(samples):
        logits[index, : len(z)] = torch.tensor(z)
        target[index, : len(gold)] = torch.tensor(gold, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        optimizer.zero_grad()
        loss = -(target * torch.log_softmax(logits / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(min(TEMP_MAX, max(TEMP_MIN, log_t.exp().item())))


def split_logits(agent, path: str) -> List[Dict[str, Any]]:
    """Every question of one split with its raw logits: the question type, the logits, the gold
    distribution, the gate it came from, the question's own name and the answers it may be given."""
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                state, questions, gold = json.loads(row["state"]), json.loads(row["questions"]), json.loads(row["gold"])
                for qid, question in questions.items():
                    if qid in gold:
                        item = training_item(agent.tok, agent.cfg, state, qid, question, gold[qid])
                        if item is not None:
                            rows.append((item, row["gate"], qid, metrics.answer_names(question)))
    out = []
    agent.model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), 16):
            chunk = rows[start:start + 16]
            batch = collate([item for item, _, _, _ in chunk], agent.tok.pad_token_id)
            with torch.autocast(agent.device.type, dtype=agent.dtype, enabled=agent.device.type == "cuda"):
                logits, _ = agent.model(*(batch[key].to(agent.device) for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")))
            values = logits.float().cpu().numpy()
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
    args = parser.parse_args()

    try:
        rules = [metrics.parse_asymmetric(one) for one in (args.asymmetric or [])]
    except ValueError as fault:
        sys.exit(f"calibrate: {fault}")

    config_path = os.path.join(args.model, "rl_agent_config.json")
    agent = laya.load(args.model, device="cuda")
    fitting = split_logits(agent, os.path.join(args.data, "calibration.jsonl"))
    samples = split_logits(agent, os.path.join(args.data, "test.jsonl"))
    if not fitting:
        sys.exit("calibrate: calibration.jsonl holds nothing to calibrate on")
    if not samples:
        sys.exit("calibrate: test.jsonl holds nothing to measure on")

    before = measure(samples, list(agent.temperature), dict(agent.temperature_by_options))

    by_type = list(agent.temperature)
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
    # a reader is left to subtract. The card holds one model at a time: this one is let go of first.
    base_where = args.base or base_of(args.model)
    base_judged, base_model = None, None
    if not args.no_base and os.path.abspath(base_where) != os.path.abspath(args.model):
        del agent
        torch.cuda.empty_cache()
        base_agent = laya.load(base_where, device="cuda")
        base_judged = judge(split_logits(base_agent, os.path.join(args.data, "test.jsonl")),
                            list(base_agent.temperature), dict(base_agent.temperature_by_options))
        base_model = base_where
        del base_agent
        torch.cuda.empty_cache()

    counted = metrics.report(
        model=args.model, data=args.data, judged=judged, base_judged=base_judged, base_model=base_model,
        rules=rules, ece=ece_of, written_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    )

    report = {
        "model": args.model,
        "buckets": {bucket: len(chosen) for bucket, chosen in sorted(buckets.items())},
        "temperature": [round(t, 4) for t in by_type],
        "temperature_by_options": {bucket: round(t, 4) for bucket, t in by_bucket.items()},
        "before": before,
        "after": after,
        "written": False,
        "report": counted,
    }

    if args.write:
        with open(config_path) as handle:
            cfg = json.load(handle)
        cfg["temperature"] = report["temperature"]
        cfg["temperature_by_options"] = report["temperature_by_options"]
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
