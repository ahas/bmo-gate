"""A training run's hold on the card and its state taken off the card and put back, so the run can give the
card way in the middle of an epoch and carry on as though it never had (docs/training.md, 「One gate on
one node」).

What a run keeps on the card is its weights, the gradients of the accumulation window in hand and the
optimizer's moments. `Parking.park` copies each of them into a mapping of one file under the parked
folder and points the run at the mapped copy, so the card holds nothing of the run but its CUDA
context; `Parking.restore` copies them back onto the card and removes the file. The mapping lives in
the page cache rather than in the process's own memory, so on a machine whose memory is short the
kernel writes it to the disk instead of swapping or ending a process.

`HeldCard` is the run's turn at the node's card arbiter: the arbiter hands the card on the moment a
turn is given back, so the turn goes back only once the card holds nothing of the run but its context.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, List, Optional, Tuple

import torch

PARKED_DIR = Path.home() / ".cache" / "bmo-laya" / "parked"
# Each tensor starts on a boundary every dtype it may have divides.
ALIGN = 64

Slot = Tuple[Any, str]


def _get(owner: Any, key: str) -> torch.Tensor:
    if key == "data":
        return owner.data
    if key == "grad":
        return owner.grad
    return owner[key]


def _put(owner: Any, key: str, value: torch.Tensor) -> None:
    if key == "data":
        owner.data = value
    elif key == "grad":
        owner.grad = value
    else:
        owner[key] = value


def on(value: torch.Tensor, device: torch.device) -> bool:
    """Whether a tensor lies on `device`, a device named without an index standing for any of its kind:
    the run asks for `cuda`, and its tensors say `cuda:0`."""
    return value.device.type == device.type and (device.index is None or value.device.index == device.index)


def card_slots(model: torch.nn.Module, optimizer: Optional[torch.optim.Optimizer], device: torch.device) -> List[Slot]:
    """Every tensor of the run on `device`: each parameter, then its gradient where one stands — in that
    order, since a gradient is only taken on the device its parameter is on — then the optimizer's state,
    where the run has one: a calibration only asks the model."""
    slots: List[Slot] = []
    for param in model.parameters():
        if on(param.data, device):
            slots.append((param, "data"))
        if param.grad is not None and on(param.grad, device):
            slots.append((param, "grad"))
    for state in (optimizer.state.values() if optimizer is not None else ()):
        for key, value in state.items():
            if torch.is_tensor(value) and on(value, device):
                slots.append((state, key))
    return slots


def _padded(size: int) -> int:
    return -(-size // ALIGN) * ALIGN


class Parking:
    """One run's place in the parked folder, and the tensors it has parked there."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.slots: List[Slot] = []

    @staticmethod
    def clear(folder: Path = PARKED_DIR) -> None:
        """The folder emptied: a node trains one gate at a time, so whatever stands there is a killed run's."""
        if folder.is_dir():
            for stale in folder.iterdir():
                stale.unlink(missing_ok=True)

    def park(self, model: torch.nn.Module, optimizer: Optional[torch.optim.Optimizer], device: torch.device) -> Tuple[int, float]:
        """Everything of the run on the card copied into the mapping and dropped from the card; the bytes
        parked and the seconds it took."""
        began = time.monotonic()
        self.slots = card_slots(model, optimizer, device)
        sizes = [_get(owner, key).numel() * _get(owner, key).element_size() for owner, key in self.slots]
        total = sum(_padded(size) for size in sizes)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.unlink(missing_ok=True)
        mapped = torch.from_file(str(self.path), shared=True, size=max(1, total), dtype=torch.uint8)
        offset = 0
        for (owner, key), size in zip(self.slots, sizes):
            value = _get(owner, key)
            copy = mapped[offset:offset + size].view(value.dtype).view(value.shape)
            copy.copy_(value)
            _put(owner, key, copy)
            offset += _padded(size)
        if device.type == "cuda":
            torch.cuda.synchronize(device)
            torch.cuda.empty_cache()
        return sum(sizes), time.monotonic() - began

    def restore(self, device: torch.device) -> float:
        """Everything parked copied back onto the card and the file removed; the seconds it took."""
        began = time.monotonic()
        for owner, key in self.slots:
            _put(owner, key, _get(owner, key).to(device, copy=True))
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        self.slots = []
        self.path.unlink(missing_ok=True)
        return time.monotonic() - began


def parking_for(out: str, folder: Path = PARKED_DIR) -> Parking:
    """The parked place of the run writing `out`, named by the run's own folder."""
    name = os.path.basename(os.path.abspath(out)) or "run"
    return Parking(folder / f"{name}.bin")


# What letting go is counted at, in seconds, before the run has measured its own.
FIRST_GIVE_WAY_S = 10.0
# The most of the run's own memory the card may still hold once its state is off it: the tensors torch
# keeps for itself beside the context, never the run's weights.
PARKED_LEFT_BYTES = 64 << 20


def waiting_line():
    """What the log says while the run waits for its turn: its place, each time it moves."""
    shown: List[Optional[int]] = [None]

    def said(answered) -> None:
        if answered.position != shown[0]:
            shown[0] = answered.position
            print(f"turn: waiting for the card, {answered.position} in line, about {answered.wait_s:g} s", flush=True)
    return said


class HeldCard:
    """The node's card held as a turn that gives way (the arbiter's docs/node-arbiter.md, 「Giving way」), or nothing where the
    run was given no lock. The service the turn is asked under is the one the run declares to the card
    arbiter.

    The arbiter hands the card to the next in line the moment the turn is given back, so every way off
    the card goes through `let_go`, which gives it back only once the card holds nothing of the run but
    its context."""

    def __init__(self, lock: Optional[str], out: str) -> None:
        self.turn = None
        self.parking = parking_for(out)
        self.gave_way, self.away_seconds = 0, 0.0
        if lock is None:
            return
        import turn  # the card arbiter's client, carried beside this script

        self.quiet = turn.quiet
        Parking.clear()
        client = turn.TurnClient(os.environ.get("BMO_CARD_SERVICE", "laya-train"), gives_way_s=FIRST_GIVE_WAY_S)
        self.turn = turn.GivingTurn(client, Path(lock))
        self.turn.take(said=waiting_line())

    def asked_for(self) -> Optional[str]:
        return None if self.turn is None else self.turn.asked_for()

    def give_way(self, model, optimizer: Optional[torch.optim.Optimizer], device, quiet_s: float) -> None:
        """The run's state parked and the card let go, the card waited for until it has stood quiet, and
        the state put back. Each move is said in the log, and a line every ten minutes while it waits, so
        a run off the card is not taken for one that died."""
        asked, away = self.turn.asked_for(), time.monotonic()
        parked, seconds = self.parking.park(model, optimizer, device)
        self.let_go(device)
        self.turn.client.gives_way_s = max(1.0, seconds)
        print(f"  {time.strftime('%H:%M:%S')} gave way to {asked}: {parked / 2**30:.2f} GiB parked in {seconds:.1f}s", flush=True)
        self.quiet(self.turn.client, quiet_s,
                   said=lambda waited: print(f"  waiting for the card to stand quiet, {waited / 60:.0f} min so far", flush=True))
        self.turn.take(said=waiting_line())
        restored = self.parking.restore(device)
        self.gave_way += 1
        self.away_seconds += time.monotonic() - away
        print(f"  {time.strftime('%H:%M:%S')} back on the card after {time.monotonic() - away:.0f}s, restored in {restored:.1f}s", flush=True)

    def put_down(self, device) -> None:
        """The card let go between two stretches of the run's work, so work that cannot give way — a fit on
        the CPU, a model loading — keeps nobody waiting."""
        if self.turn is None or self.turn.fd is None:
            return
        self.let_go(device)
        print(f"  {time.strftime('%H:%M:%S')} let the card go between two stretches of work", flush=True)

    def take_up(self) -> None:
        """The card asked for again after `put_down`, as a turn that gives way."""
        if self.turn is None or self.turn.fd is not None:
            return
        self.turn.take(said=waiting_line())
        print(f"  {time.strftime('%H:%M:%S')} back on the card", flush=True)

    def finish(self, model, optimizer: Optional[torch.optim.Optimizer], device) -> None:
        """The finished run's state dropped from the card, its checkpoint already written, and the card let
        go: the process is still alive while the turn passes on, so nothing of the run may wait for its
        exit to leave the card. Each tensor is emptied where it stands rather than moved, so the lists and
        the optimizer still pointing at it keep nothing on the card either."""
        if optimizer is not None:
            optimizer.state.clear()
        for tensor in (*model.parameters(), *model.buffers()):
            if on(tensor, torch.device(device)):
                tensor.grad = None
                tensor.data = torch.empty(0, dtype=tensor.dtype)
        self.let_go(device)

    def let_go(self, device) -> None:
        """The lock and the ticket given back, once the cache is given back too and the card holds nothing
        of the run but its context; a run that finds its own memory still there ends instead, which empties
        the card."""
        if self.turn is None:
            return
        if self.turn.fd is not None:
            torch.cuda.empty_cache()
            left = torch.cuda.memory_allocated(device)
            if left > PARKED_LEFT_BYTES:
                sys.exit(f"{os.path.basename(sys.argv[0])}: {left / 2**20:.0f} MiB of the run stayed on the card; ending rather than letting the lock go")
        self.turn.let_go()
