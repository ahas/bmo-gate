"""The bookkeeping a killed training run is carried on from (docs/training.md, 「The resume
contract」): where a run's step checkpoints stand, which of them can be resumed from, what a resume has
to match, how the data order is reproduced, which old checkpoints are dropped, and how a finished run
says that it is finished.

Nothing here imports torch, so `compare.py` and the tests read it on any machine: what needs torch is
the tensors themselves, and those are written beside the state this module keeps.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
from typing import Any, Dict, List, Optional, Tuple

STEPS_DIR = "steps"
STATE_NAME = "trainer_state.json"
TENSOR_NAME = "trainer_state.pt"
COMPLETE_NAME = "training_complete.json"
PARTIAL_SUFFIX = ".partial"
STATE_KIND = "laya-finetune-trainer-state"
COMPLETE_KIND = "laya-finetune-complete"
STATE_VERSION = 1

# What a resume has to find unchanged. A run continued under another seed, another batch or another
# train.jsonl is a different training wearing the first one's directory, and its figures would be read
# as one run's.
RUN_FIELDS = (
    "seed", "epochs", "micro_batch", "effective_batch", "accumulate", "group",
    "items", "data_sha256", "balance_ratio", "kind_ratios", "per_gate", "freeze_embeddings", "optimizer",
    "sigma_start", "sigma_end", "lr_encoder", "lr_head",
)

_STEP_DIR = re.compile(r"^step-(\d{6,})$")


def step_dir_name(step: int) -> str:
    """The folder one step's checkpoint stands in. The number is padded so a plain listing sorts."""
    return f"step-{step:06d}"


def step_of_dir(name: str) -> Optional[int]:
    """The step a folder name says, or None where the name is not one of ours."""
    found = _STEP_DIR.match(name)
    return int(found.group(1)) if found else None


def steps_root(out: str) -> str:
    return os.path.join(out, STEPS_DIR)


def step_dirs(out: str) -> List[Tuple[int, str]]:
    """Every step checkpoint of a run that is whole, oldest first. A folder still being written carries
    the partial suffix, and one missing either of its two state files is not resumable however it is
    named — neither is returned, so a run killed inside a save resumes from the save before it."""
    root = steps_root(out)
    if not os.path.isdir(root):
        return []
    found: List[Tuple[int, str]] = []
    for name in sorted(os.listdir(root)):
        step = step_of_dir(name)
        if step is None:
            continue
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        if all(os.path.exists(os.path.join(path, part)) for part in (STATE_NAME, TENSOR_NAME)):
            found.append((step, path))
    found.sort()
    return found


def latest_step(out: str) -> Optional[Tuple[int, str]]:
    """The newest step checkpoint a run can be resumed from, or None where it has none."""
    found = step_dirs(out)
    return found[-1] if found else None


def read_state(directory: str) -> Optional[Dict[str, Any]]:
    """One step checkpoint's state, or None where the file is missing or is not one of ours."""
    path = os.path.join(directory, STATE_NAME)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) and state.get("kind") == STATE_KIND else None


def write_state(directory: str, state: Dict[str, Any]) -> None:
    with open(os.path.join(directory, STATE_NAME), "w", encoding="utf-8") as handle:
        json.dump({"kind": STATE_KIND, "version": STATE_VERSION, **state}, handle, ensure_ascii=False, indent=2)


def completion(out: str) -> Optional[Dict[str, Any]]:
    """What a finished run wrote about itself, or None where the run did not finish."""
    path = os.path.join(out, COMPLETE_NAME)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        return None
    return marker if isinstance(marker, dict) and marker.get("kind") == COMPLETE_KIND else None


def is_finished(out: str) -> bool:
    """Whether the run in this directory finished. A directory exists from the first rolling save on,
    so its existence says a run was started and never that one ended."""
    return completion(out) is not None


def mark_complete(out: str, marker: Dict[str, Any]) -> None:
    with open(os.path.join(out, COMPLETE_NAME), "w", encoding="utf-8") as handle:
        json.dump({"kind": COMPLETE_KIND, **marker}, handle, ensure_ascii=False, indent=2)


TENSOR_KEYS = ("model", "optimizer", "scheduler")


def tensor_payload(model_state: Any, optimizer: Any, scheduler: Any) -> Dict[str, Any]:
    """What is written beside a step checkpoint's served weights: the weights again in the precision
    they are trained in, the optimizer's moments and the schedule's position. Without the last two a
    resumed run would start Adam and the cosine schedule from nothing, which is the restart this whole
    mechanism exists to avoid."""
    return {"model": model_state, "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict()}


def apply_tensors(payload: Dict[str, Any], model: Any, optimizer: Any, scheduler: Any) -> None:
    """The three back into the run that is carrying on. A payload short of any of them is refused rather
    than half-applied, since a training continued with one of the three reset is not a continuation."""
    missing = [key for key in TENSOR_KEYS if key not in payload]
    if missing:
        raise ValueError(f"the checkpoint carries no {', '.join(missing)}")
    model.load_state_dict(payload["model"], strict=True)
    optimizer.load_state_dict(payload["optimizer"])
    scheduler.load_state_dict(payload["scheduler"])


def prunable(steps: List[Tuple[int, str]], keep: int) -> List[str]:
    """The step checkpoints to drop once a newer one stands whole: everything but the newest `keep`.
    The newest is never among them, whatever `keep` is asked for, so a run always keeps one it can be
    resumed from."""
    kept = max(1, keep)
    return [path for _, path in steps[:-kept]]


def run_fields(values: Dict[str, Any]) -> Dict[str, Any]:
    """The part of a run's settings a resume is checked against."""
    return {field: values.get(field) for field in RUN_FIELDS}


def resume_fault(state: Dict[str, Any], run: Dict[str, Any]) -> Optional[str]:
    """Why this state cannot be resumed under these settings, or None where it can."""
    saved = state.get("run")
    if not isinstance(saved, dict):
        return "the checkpoint carries no record of the run it belongs to"
    wanted = run_fields(run)
    differing = [field for field in RUN_FIELDS if saved.get(field) != wanted.get(field)]
    if differing:
        return "; ".join(f"{field} was {saved.get(field)!r} and is now {wanted.get(field)!r}" for field in differing)
    return None


def order_seed(seed: int, epoch: int) -> int:
    """One epoch's own seed, derived from the run's. Each epoch's order stands on its own rather than on
    the epochs before it, which is what lets an epoch in the middle be rebuilt without replaying them."""
    return (int(seed) * 1_000_003 + int(epoch) * 7_919 + 1) % (2 ** 31 - 1)


def epoch_order(count: int, seed: int, epoch: int) -> List[int]:
    """The order one epoch reads the items in: a permutation of their positions, the same every time for
    the same run and epoch."""
    order = list(range(count))
    random.Random(order_seed(seed, epoch)).shuffle(order)
    return order


def next_position(epoch: int, item_index: int, count: int, epochs: int) -> Tuple[int, int]:
    """Where a run carries on from, as the epoch and the position within that epoch's order. An index at
    or past the end of an epoch is the start of the next one, and a position past the last epoch says the
    training has no items left to read."""
    if count <= 0:
        return epochs, 0
    while item_index >= count and epoch < epochs:
        epoch += 1
        item_index = 0
    return epoch, max(0, item_index)


def file_digest(path: str) -> str:
    """A file's sha256, which is how a resume tells the data it was trained on from data that moved."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_action(out: str) -> str:
    """What is to be done with a run directory, read from the directory alone:

    - `train` — nothing is there yet.
    - `measure` — the run finished and its checkpoint is the one to read.
    - `resume` — the run was started and did not finish, and a step checkpoint stands to carry on from.
    - `stuck` — the run was started and did not finish, and nothing resumable is left; the directory is
      named rather than written over, since removing a checkpoint is nobody's to do quietly.
    """
    if not os.path.exists(out):
        return "train"
    if is_finished(out):
        return "measure"
    return "resume" if latest_step(out) else "stuck"
