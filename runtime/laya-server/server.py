"""The Laya decision server: one checkpoint per gate behind two HTTP calls.

GET /health answers what is loaded for which gate and where; POST /decide takes {"gate", "state",
"questions"} and answers with that gate's checkpoint's own answer for each question. Every call
carries the service key as its bearer. docs/laya-server.md is the whole account of it.
"""

from __future__ import annotations

import ctypes
import fcntl
import gc
import hashlib
import hmac
import json
import os
import re
import socket
import sys
import threading
import time
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional

# Set before torch or transformers is first imported, whoever imports this module: USE_TF is the
# model card's cure for a load that hangs.
os.environ.setdefault("USE_TF", "0")

QUESTION_TYPES = ("choice", "score", "noul")
MAX_BODY_BYTES = 1 << 20
MAX_QUESTIONS = 128
# The warm-up call is asked in the gates' own language, written by its escapes.
WARM_STATE = "\ub0b4\uc77c \ubc30\ud3ec \uc77c\uc815\uc744 \ub2e4\uc2dc \uc7a1\uc544 \uc8fc\uc138\uc694."
WARM_QUESTIONS = {"warm": {"type": "noul", "instructions": "\uc774 \uba54\uc2dc\uc9c0\ub294 \uc77c\uc815 \ubcc0\uacbd \uc694\uccad\uc778\uac00?"}}


GATE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
HERE = os.path.dirname(os.path.abspath(__file__))


class Refused(Exception):
    """A request the server will not answer, with the reason it says back."""

    status = HTTPStatus.BAD_REQUEST


class Unserved(Refused):
    """A gate no checkpoint here is named for."""

    status = HTTPStatus.NOT_FOUND


class NoRoom(Exception):
    """The card would not take the checkpoint asked for, or its decision, even with every other one
    taken off it."""


class CardFull(Exception):
    """A forward pass that ran out of card. Not a RuntimeError, so Laya's own fallback to the CPU,
    which catches those, never sees it."""


class ForwardFailed(Exception):
    """A forward pass that failed any other way, kept from Laya's fallback to the CPU the same way."""


class CallerLeft(Exception):
    """The caller hung up before its turn at the card came."""


class Taken(Exception):
    """The card is taken outright: a claim stands on it, so no queue turn comes while it does."""


def read_token(env: Optional[Dict[str, str]] = None) -> str:
    """The service key, which the unit reads out of the service's environment file."""
    token = (os.environ if env is None else env).get("LAYA_TOKEN", "").strip()
    if not token:
        raise SystemExit("laya-server: LAYA_TOKEN is not set; the unit reads it from its environment file")
    return token


def read_checkpoints(text: str, base: str = HERE) -> "OrderedDict[str, str]":
    """The gate=directory pairs of LAYA_CHECKPOINTS, in the order given; a relative directory is
    read from base. A pair that cannot be read stops the server rather than serving part of it."""
    named: "OrderedDict[str, str]" = OrderedDict()
    for pair in text.split():
        gate, sep, directory = pair.partition("=")
        if not sep or not GATE_NAME.match(gate) or not directory:
            raise SystemExit(f"laya-server: LAYA_CHECKPOINTS has {pair!r}, not gate=directory")
        if gate in named:
            raise SystemExit(f"laya-server: LAYA_CHECKPOINTS names {gate} twice")
        named[gate] = os.path.join(base, os.path.expanduser(directory))
    return named


def check_request(body: Any) -> tuple[str, Any, Dict[str, Dict[str, Any]]]:
    """The gate, state and questions of a /decide body, or Refused saying what is wrong with it."""
    if not isinstance(body, dict):
        raise Refused("the body is not an object")
    gate = body.get("gate")
    if not isinstance(gate, str) or not GATE_NAME.match(gate):
        raise Refused("gate must name the gate asking")
    state = body.get("state")
    questions = body.get("questions")
    if not isinstance(state, (str, dict, list)) or state in ("", {}, []):
        raise Refused("state must be a non-empty string, object or list")
    if not isinstance(questions, dict) or not questions:
        raise Refused("questions must be a non-empty object")
    if len(questions) > MAX_QUESTIONS:
        raise Refused(f"at most {MAX_QUESTIONS} questions per call")
    for qid, question in questions.items():
        if not isinstance(question, dict):
            raise Refused(f"question {qid} is not an object")
        if question.get("type") not in QUESTION_TYPES:
            raise Refused(f"question {qid} has no type among {', '.join(QUESTION_TYPES)}")
        if not isinstance(question.get("instructions"), str) or not question["instructions"].strip():
            raise Refused(f"question {qid} has no instructions")
        criteria = question.get("criteria")
        if question["type"] == "choice" and not (isinstance(criteria, (dict, list)) and len(criteria) >= 2):
            raise Refused(f"question {qid} is a choice with fewer than two options")
        if question["type"] == "score" and not (isinstance(criteria, list) and len(criteria) >= 2):
            raise Refused(f"question {qid} is a score with fewer than two levels")
    return gate, state, questions


class NoPlace(Exception):
    """The node's card arbiter has no place for this engine among the node's occupants."""


class CardLock:
    """The lock the services sharing a card take turns by: an exclusive flock on one file, taken
    before anything goes on the card and let go once everything is off it. With no file named there is
    no lock, and taking it always succeeds. Where the node's card arbiter keeps a hold queue (`turn`), the
    engine waits its turn there first, with the answer held open, for as long as its caller waits: no call
    is ever answered held, and only a card taken outright by a claim ends the wait at once.

    With nothing left in hand the turn rests (the arbiter's docs/node-arbiter.md, 「Resting」): the lock and the ticket kept, the
    checkpoints on the card, until the arbiter says another wants the card. Having given way, the engine
    asks a ticket that only rests (`returning`), and takes the lock again once the arbiter grants it."""

    # How long one held-open ask lasts, so a call whose caller left is seen within it.
    ASK_S = 1.0
    # How often a lock held by a process asking for no turns is asked for again.
    AGAIN_S = 0.2

    def __init__(self, path: Optional[str], turn: Any = None,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.path = path
        self.fd: Optional[int] = None
        self.turn = turn
        self.clock = clock
        self.sleep = sleep
        self.resting = False
        self.returning = False
        # Whether this node's arbiter has ever rested the turn, so the card is asked back after giving way.
        self.knows_rests = False

    @property
    def held(self) -> bool:
        return self.fd is not None

    def try_lock(self, block: bool) -> bool:
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if block else fcntl.LOCK_NB))
        except BlockingIOError:
            os.close(fd)
            return False
        self.fd = fd
        return True

    def take(self, wait: bool = False, waited_s: float = 0.0, caller_waiting: Callable[[], bool] = lambda: True) -> None:
        """The lock taken, for as long as it takes: at start (`wait`) whatever stands, for a call while its
        caller waits, the ticket standing by a call that has waited `waited_s` already. CallerLeft where the
        caller hung up meanwhile, Taken where a claim stands on the card, NoPlace where the node has no place
        for the engine."""
        if self.path is None or self.fd is not None:
            return
        if self.returning:
            # The ticket that only rests goes, and the call stands in line by its own arrival.
            self.returning = False
            self.turn.give_back()
        first = True
        while True:
            if not wait and not caller_waiting():
                # The ticket goes with the call, so the card is never granted to a turn nobody will take.
                if self.turn is not None:
                    self.turn.give_back()
                raise CallerLeft("the caller left while its call waited for the card")
            asked_at = self.clock()
            turn_come = True
            if self.turn is not None:
                try:
                    answered = self.turn.ask(wait_s=self.ASK_S, waited_s=waited_s if first else None)
                except PermissionError as refused:
                    if wait:
                        raise SystemExit(f"laya-server: {refused}") from None
                    raise NoPlace(str(refused)) from None
                first = False
                turn_come = answered is None or answered.turn
                if not turn_come and not wait and getattr(answered, "claim", None):
                    self.turn.give_back()
                    raise Taken(f"the card is taken for {answered.claim}")
            if turn_come:
                if wait:
                    self.try_lock(block=True)
                    return
                if self.try_lock(block=False):
                    return
            # A lock somebody took in the moment between, or an answer that came back early with no turn
            # (an arbiter that holds no answer open), is not asked again at once.
            if turn_come or self.clock() - asked_at < self.ASK_S - 0.05:
                self.sleep(self.AGAIN_S)

    def keeps(self, next_waited_s: float) -> bool:
        """Whether the card carries on to the next call in hand, which has waited `next_waited_s`: while the
        node's queue says it still stands first; on a node keeping no queue, always (docs/laya-server.md,
        「Sharing the card」)."""
        return self.turn is None or self.turn.keep(next_waited_s)

    def rest(self) -> str:
        """The turn told it has nothing left in hand: `rests` where the arbiter keeps it so, the lock kept;
        `gives way` where somebody already wants the card; `lets go` where the arbiter keeps no rests, or
        none answers (docs/laya-server.md, 「Sharing the card」)."""
        answered = None if self.turn is None or self.fd is None else self.turn.rest()
        if answered is None or not answered.turn or not getattr(answered, "resting", False):
            return "lets go"
        self.knows_rests = True
        if answered.give_way_for is not None:
            return "gives way"
        self.resting = True
        return "rests"

    def resume(self, next_waited_s: float) -> bool:
        """A call come while the turn rests: whether the arbiter says it carries on with the card as it
        stands, which ends the rest."""
        kept = self.keeps(next_waited_s)
        if kept:
            self.resting = False
        return kept

    def come_back(self) -> None:
        """Having given way, a ticket asked that only rests, granted once nobody else wants the card."""
        if self.turn is None or self.fd is not None:
            return
        try:
            self.returning = self.turn.ask(rest=True) is not None
        except PermissionError:
            self.returning = False

    def take_returned(self) -> bool:
        """The lock taken for a ticket that only rests, now granted; the turn rests from the start. False
        where somebody took the lock in the moment between."""
        if self.fd is None and not self.try_lock(block=False):
            return False
        self.returning = False
        self.resting = True
        return True

    def release(self) -> None:
        self.resting = False
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
            if self.turn is not None:
                self.turn.give_back()

    def described(self) -> Dict[str, Any]:
        return {"path": self.path, "held": self.held, "resting": self.resting, "returning": self.returning}


class PinnedCopies:
    """Host copies kept in page-locked memory: the fastest way onto the card, held by the process for
    its whole life."""

    where = "pinned"
    # Nothing but these copies holds the weights off the card, so they are kept while it is on it.
    kept_on_card = True

    def keep(self, source: str, hosts: List[Any]) -> List[Any]:
        return [host.pin_memory() for host in hosts]


class MappedCopies:
    """Host copies kept in a dump file under `folder`, read back memory-mapped: they stand in the page
    cache, which the kernel may drop under pressure and read again from the file, so a machine whose
    memory is a person's first is not held to them. One dump a checkpoint, named by its source and by a
    digest of the source's files, so a checkpoint replaced under the same name is dumped afresh; a dump
    that does not read back exactly is made again. A checkpoint on the card holds no mapping: its dump
    already holds what the card holds, and is mapped again for the next move onto the card."""

    where = "mapped"
    kept_on_card = False

    def __init__(self, folder: str):
        self.folder = folder

    @staticmethod
    def digest(source: str) -> str:
        """The source's files by name, size and time, which change whenever the checkpoint does."""
        listed = []
        for root, _, files in sorted(os.walk(source)):
            for name in sorted(files):
                stat = os.stat(os.path.join(root, name))
                listed.append(f"{os.path.relpath(os.path.join(root, name), source)}:{stat.st_size}:{stat.st_mtime_ns}")
        return hashlib.sha256("\n".join(listed).encode()).hexdigest()[:16]

    def path(self, source: str) -> str:
        name = os.path.abspath(source).strip(os.sep).replace(os.sep, "--")
        return os.path.join(self.folder, f"{name}--{self.digest(source)}.pt")

    def keep(self, source: str, hosts: List[Any]) -> List[Any]:
        import torch

        path = self.path(source)
        kept = self.read(path, hosts)
        if kept is None:
            os.makedirs(self.folder, exist_ok=True)
            partial = f"{path}.partial"
            torch.save(hosts, partial)
            os.replace(partial, path)
            kept = self.read(path, hosts)
            if kept is None:
                raise RuntimeError(f"the dump {path} does not read back as the checkpoint")
        stem = os.path.basename(path).rsplit("--", 1)[0]
        for other in os.listdir(self.folder):
            if other.startswith(f"{stem}--") and os.path.join(self.folder, other) != path:
                os.remove(os.path.join(self.folder, other))
        return kept

    def reopen(self, path: str, shapes: List[tuple]) -> List[Any]:
        """The dump `keep` made at `path` mapped again for a move onto the card, held to the dtype and shape
        of each copy it was made from."""
        import torch

        mapped = torch.load(path, mmap=True, weights_only=True)
        if not isinstance(mapped, list) or [(one.dtype, tuple(one.shape)) for one in mapped] != shapes:
            raise RuntimeError(f"the dump {path} no longer reads as the checkpoint it was made from")
        return mapped

    @staticmethod
    def read(path: str, hosts: List[Any]) -> Optional[List[Any]]:
        import torch

        if not os.path.exists(path):
            return None
        try:
            mapped = torch.load(path, mmap=True, weights_only=True)
        except Exception:  # noqa: BLE001 - a dump that cannot be read is made again
            return None
        if not isinstance(mapped, list) or len(mapped) != len(hosts):
            return None
        for kept, host in zip(mapped, hosts):
            if kept.dtype != host.dtype or kept.shape != host.shape or not torch.equal(kept, host):
                return None
        return mapped


class Checkpoint:
    """One gate's loaded checkpoint, on the card or waiting in host memory.

    Laya builds its weights in 32 bits on the card. Taken off, each weight waits in host memory, pinned
    or mapped from a dump as the node keeps its copies, in the 16 bits it was saved in where that holds
    it exactly, and in its own width where it does not, so putting it back reproduces the card's copy
    bit for bit.
    """

    def __init__(self, gate: str, source: str, agent: Any, load_ms: int, copies: Any = None, directory: str = "",
                 room: Optional[Room] = None):
        import torch

        self.gate = gate
        self.source = source
        self.agent = agent
        self.load_ms = load_ms
        self.device = agent.device
        self.dtype = agent.dtype
        self.on_card = True
        self.move_ms: Optional[float] = None
        self.copies = copies or PinnedCopies()
        guard_forward(agent.model, room)
        places = []
        hosts = []
        # What its copy takes on the card, in the widths the card keeps it in, which is what a batch
        # makes room for.
        self.card_bytes = 0
        for module in agent.model.modules():
            for table in (module._parameters, module._buffers):
                for name, tensor in table.items():
                    if tensor is None:
                        continue
                    host = tensor.detach().to("cpu")
                    if host.dtype == torch.float32 and torch.equal(host.half().float(), host):
                        host = host.half()
                    places.append((table, name, tensor.dtype))
                    hosts.append(host)
                    self.card_bytes += tensor.numel() * tensor.element_size()
        # Where copies that are not kept on the card come back from: the dump made of them now.
        self.dump = None if getattr(self.copies, "kept_on_card", True) else self.copies.path(directory or source)
        kept = self.copies.keep(directory or source, hosts)
        self.shapes = [(host.dtype, tuple(host.shape)) for host in kept]
        self.host_bytes = sum(host.numel() * host.element_size() for host in kept)
        self.slots = [(table, name, dtype, host) for (table, name, dtype), host in zip(places, kept)]

    def put_on_card(self) -> None:
        import torch

        started = time.perf_counter()
        if self.dump is not None and self.slots and self.slots[0][3] is None:
            mapped = self.copies.reopen(self.dump, self.shapes)
            self.slots = [(table, name, dtype, host) for (table, name, dtype, _), host in zip(self.slots, mapped)]
        for table, name, dtype, host in self.slots:
            table[name].data = host.to(self.device, non_blocking=True).to(dtype)
        torch.cuda.synchronize(self.device)
        if self.dump is not None:
            # On the card the checkpoint holds no host copy; its dump is mapped again for the next move.
            self.slots = [(table, name, dtype, None) for table, name, dtype, _ in self.slots]
        self.on_card = True
        self.move_ms = round((time.perf_counter() - started) * 1000, 1)

    def take_off_card(self) -> None:
        import torch

        for table, name, dtype, _ in self.slots:
            table[name].data = torch.empty(0, dtype=dtype)
        self.on_card = False
        torch.cuda.empty_cache()

    def settle(self) -> None:
        """Undo Laya's own fallback to the CPU after a decision that ran out of card: the next call
        puts the checkpoint back on the card instead of the gate deciding on the CPU from then on."""
        if self.agent.device != self.device:
            self.agent.device = self.device
            self.agent.dtype = self.dtype
            self.take_off_card()

    def predict(self, state: Any, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        return self.agent.predict(state, questions)

    def described(self) -> Dict[str, Any]:
        return {
            "model": self.source,
            "where": "card" if self.on_card else self.copies.where,
            "hostBytes": self.host_bytes,
            "moveMs": self.move_ms,
            "loadMs": self.load_ms,
            "temperature": getattr(self.agent, "temperature", None),
            "temperatureByOptions": getattr(self.agent, "temperature_by_options", None),
        }


def card_turn() -> Any:
    """The engine's ticket at the node's card arbiter, under the service name its unit declares, where the
    arbiter's client stands beside the engine; None where it does not, and the lock is taken as it comes."""
    try:
        from turn import TurnClient
    except ImportError:
        return None
    return TurnClient(os.environ.get("BMO_CARD_SERVICE", "") or "laya")


def host_copies(kind: str, folder: str) -> Any:
    """How the node keeps the checkpoints between their turns on the card: `pinned`, or `mapped` from dumps
    under `folder`."""
    if kind == "mapped":
        return MappedCopies(folder)
    if kind == "pinned":
        return PinnedCopies()
    raise SystemExit(f"laya-server: LAYA_HOST_COPY is {kind!r}, not pinned or mapped")


def tokenizer_digest(directory: str) -> Optional[str]:
    """The tokenizer files of a checkpoint by name, size and content, or None where it keeps none."""
    folder = os.path.join(directory, "tokenizer")
    if not os.path.isdir(folder):
        return None
    digest = hashlib.sha256()
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            digest.update(f"{name}:{os.path.getsize(path)}:".encode())
            with open(path, "rb") as handle:
                for block in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(block)
    return digest.hexdigest()


def share_tokenizer(agent: Any, directory: str, tokenizers: Dict[str, Any]) -> None:
    """The agent given the tokenizer loaded first for the same tokenizer files, so checkpoints that read
    alike hold one copy of it between them; its own is let go."""
    digest = tokenizer_digest(directory)
    if digest is None or getattr(agent, "tok", None) is None:
        return
    if digest in tokenizers:
        agent.tok = tokenizers[digest]
    else:
        tokenizers[digest] = agent.tok


def card_fit(free_bytes: int, keep_free_bytes: int, room_bytes: int, largest_bytes: int) -> int:
    """How many checkpoints the card takes at once beside the decision room and what is kept free for
    others, counted at the largest checkpoint; at least one, since a gate asked is always put on."""
    if largest_bytes <= 0:
        return 1
    return max(1, (free_bytes - keep_free_bytes - room_bytes) // largest_bytes)


def is_out_of_memory(error: BaseException) -> bool:
    return "out of memory" in str(error).lower()


class Room:
    """What a forward pass takes of the card by the size of the block it lays out — its questions times
    their padded length, in cells — kept in steps of a power of two, the most taken in each, and whether
    a pass of so many cells fits in what the card has free (docs/laya-server.md, 「Sharing the card」).
    `ahead` says whether room can still be made for the pass in hand by taking another checkpoint off;
    with no measure yet, or nothing left to take off, every pass runs as it comes."""

    def __init__(self, free: Callable[[], Optional[int]] = lambda: None,
                 peak: Optional[tuple[Callable[[], int], Callable[[int], int]]] = None):
        self.free = free
        # What starts a pass's measure, answering the card memory allocated then, and what answers how much
        # more the pass took at its peak; None where nothing is measured.
        self.peak = peak
        # By step, the most a pass there took and the cells of that pass.
        self.taken: Dict[int, tuple[int, int]] = {}
        self.ahead = False

    def need(self, cells: int) -> Optional[float]:
        """What a pass of so many cells is counted at: what the smallest step at least its size took, or
        past the largest step measured, what that one took scaled by its cells; None before any pass."""
        step = cells.bit_length()
        above = [one for one in self.taken if one >= step]
        if above:
            return float(self.taken[min(above)][0])
        if not self.taken:
            return None
        taken, at = self.taken[max(self.taken)]
        return taken * cells / at

    def short(self, cells: int) -> bool:
        if not self.ahead or cells <= 0:
            return False
        need = self.need(cells)
        free = None if need is None else self.free()
        return free is not None and need > free

    def measured(self, cells: int, taken: int) -> None:
        if cells > 0 and taken > 0:
            step = cells.bit_length()
            if taken > self.taken.get(step, (0, 0))[0]:
                self.taken[step] = (taken, cells)


def cells_of(args: tuple) -> int:
    """The cells of the block a pass lays out, read off its first argument, the input ids."""
    shape = getattr(args[0], "shape", None) if args else None
    return int(shape[0]) * int(shape[1]) if shape is not None and len(shape) == 2 else 0


def guard_forward(model: Any, room: Optional[Room] = None) -> None:
    """Make the model's forward pass fail as CardFull or ForwardFailed rather than a RuntimeError, so
    Laya's own fallback to the CPU never runs and a decision that ran out of card is the Decider's to
    make room for. The error is let go before its stand-in is raised, so the activations its frames
    held are free by the time the room is made. With a `room`, a pass counted short of the card's free
    memory fails as CardFull before it starts, and every pass that runs is measured."""
    forward = model.forward

    def guarded(*args: Any, **kwargs: Any) -> Any:
        cells = cells_of(args) if room is not None else 0
        if room is not None and room.short(cells):
            raise CardFull(f"a pass of {cells} cells is counted past the card's free memory")
        began = room.peak[0]() if room is not None and room.peak is not None else None
        try:
            answer = forward(*args, **kwargs)
        except RuntimeError as error:
            failed = CardFull if is_out_of_memory(error) else ForwardFailed
            reason = f"{type(error).__name__}: {str(error)[:300]}"
        else:
            if began is not None:
                room.measured(cells, room.peak[1](began))
            return answer
        raise failed(reason)

    model.forward = guarded


class Decider:
    """The gates' checkpoints and the card they take turns on. One decision at a time.

    The card is used only under the card lock, and a call that finds the lock held elsewhere is
    refused at once. The card holds a batch: the asking gate, the gates of the calls in hand, the gates
    asked most recently and then the rest, as many as card_models allows and the card's free memory
    takes beside the decision room. A call whose checkpoint waits in host memory takes off together
    every checkpoint outside the next batch and puts its own on; the batch's other members go on while
    the card is idle (tend), one move at a time. A decision that needs room has the least recently asked
    others taken off for it, and they go back on as the card is filled again. Where the card is shared
    under a named lock, a call that ends with others in hand keeps the card for the oldest of them while
    the node's queue says it still stands first, and one that ends with none rests with every checkpoint
    on the card until the arbiter says another wants it (watch_card); otherwise every checkpoint comes off
    and the lock is let go at once. A call counts from the moment it asks. Where no lock is named the
    checkpoints stay.
    """

    def __init__(self, checkpoints: Dict[str, Any], card_models: int, device: str, versions: Dict[str, str],
                 vram: Callable[[], Optional[int]], card_lock: Optional[CardLock] = None,
                 free_bytes: Callable[[], Optional[int]] = lambda: None, room_bytes: int = 768 << 20,
                 fill_quiet_s: float = 0.5, clock: Callable[[], float] = time.monotonic, room: Optional[Room] = None):
        self.checkpoints = checkpoints
        # The count of a pass's room the checkpoints' forward passes share, told whether room can be made.
        self.room = room or Room()
        self.card_lock = card_lock or CardLock(None)
        # Calls asked and not yet ended, those waiting their turn included; counted under its own lock
        # so a call is counted before it waits on the decision lock. Beside them, the gates they ask.
        self.in_hand = 0
        self.in_hand_lock = threading.Lock()
        self.waiting: Dict[str, int] = {}
        # When each call in hand asked, by a key of its own: the oldest is the next to stand in the queue.
        self.arrivals: Dict[int, float] = {}
        self.calls = 0
        # The gates in the order they were last asked, the most recent last.
        self.asked: "OrderedDict[str, None]" = OrderedDict()
        self.free_bytes = free_bytes
        self.room_bytes = room_bytes
        # A caller asks a turn's gates back to back, so a move made in the moment between two calls only
        # holds up the second; the card is filled once it has been quiet this long.
        self.fill_quiet_s = fill_quiet_s
        self.clock = clock
        self.idle_since = clock()
        self.moves = 0
        self.filled = 0
        self.wake = threading.Event()
        # Woken when the card starts to rest or to wait to come back, which the watcher then asks after.
        self.watch_wake = threading.Event()
        self.gave_way = 0
        self.taken_refused = 0
        self.card_models = max(1, card_models)
        self.device = device
        self.versions = versions
        self.vram = vram
        self.lock = threading.Lock()
        self.room_made = 0
        self.dropped_calls = 0
        # Least recently asked first: the order checkpoints leave the card in.
        self.card: "OrderedDict[str, Any]" = OrderedDict(
            (gate, checkpoint) for gate, checkpoint in checkpoints.items() if checkpoint.on_card)

    def next_batch(self, first: str) -> list:
        """The gates the card should hold next, worked out from the card as it is: the first, the gates
        of the calls in hand, the gates asked most recently, then the rest in the settings' order, each
        while there are fewer than card_models and its copy fits the card's free memory — the copies
        already there counted as free — with the decision room left over. The first is always in it."""
        free = self.free_bytes()
        budget = None if free is None else free - self.room_bytes + sum(
            getattr(checkpoint, "card_bytes", 0) for checkpoint in self.card.values())
        # The calls in hand are counted under their own lock, by the handler threads, so they are read
        # under it too.
        with self.in_hand_lock:
            waiting = [gate for gate, calls in self.waiting.items() if calls > 0]
        batch: list = []
        for gate in [first, *waiting, *reversed(self.asked), *self.checkpoints]:
            if gate in batch or gate not in self.checkpoints:
                continue
            if len(batch) >= self.card_models:
                break
            need = getattr(self.checkpoints[gate], "card_bytes", 0)
            if batch and budget is not None and need > budget:
                continue
            batch.append(gate)
            if budget is not None:
                budget -= need
        return batch

    def bring(self, checkpoint: Any) -> None:
        if checkpoint.on_card:
            self.card.move_to_end(checkpoint.gate)
            return
        batch = self.next_batch(checkpoint.gate)
        for gate in [gate for gate in self.card if gate not in batch]:
            self.card.pop(gate).take_off_card()
        while len(self.card) >= self.card_models:
            self.card.popitem(last=False)[1].take_off_card()
        try:
            checkpoint.put_on_card()
        except Exception as error:  # noqa: BLE001 - only running out of card is retried
            if not is_out_of_memory(error):
                raise
            checkpoint.take_off_card()
            while self.card:
                self.card.popitem(last=False)[1].take_off_card()
            try:
                checkpoint.put_on_card()
            except Exception as again:  # noqa: BLE001
                checkpoint.take_off_card()
                if is_out_of_memory(again):
                    raise NoRoom(f"the card has no room for the {checkpoint.gate} checkpoint") from again
                raise
        self.moves += 1
        self.card[checkpoint.gate] = checkpoint

    def fill_one(self) -> bool:
        """One more member of the batch put on the card ahead of its call, where one is missing and the
        card takes it. A copy the card turns out to have no room for ends the filling, not the card."""
        if not self.checkpoints:
            return False
        first = next(reversed(self.asked)) if self.asked else next(iter(self.checkpoints))
        for gate in self.next_batch(first):
            checkpoint = self.checkpoints[gate]
            if checkpoint.on_card:
                continue
            if len(self.card) >= self.card_models:
                return False
            try:
                checkpoint.put_on_card()
            except Exception as error:  # noqa: BLE001 - a fill that fails leaves the card as it was
                checkpoint.take_off_card()
                if not is_out_of_memory(error):
                    sys.stderr.write(f"laya-server: filling {gate} failed: {type(error).__name__}\n")
                return False
            self.filled += 1
            self.card[gate] = checkpoint
            # Put ahead of its call, it is not yet asked: first to leave.
            self.card.move_to_end(gate, last=False)
            return True
        return False

    def tend(self) -> None:
        """One step of the idle card: one more of the batch put on it, taken only between calls, one move
        at a time. A card under a named lock is filled only while it rests: one found held with no call in
        hand is told to rest, and let go where the arbiter keeps no rests."""
        if self.in_hand or (self.card_lock.path is not None and not self.card_lock.held):
            return
        if not self.lock.acquire(blocking=False):
            return
        try:
            if self.in_hand:
                return
            if self.card_lock.path is not None and not self.card_lock.resting:
                self.settle_card()
                return
            if self.clock() - self.idle_since >= self.fill_quiet_s:
                self.fill_one()
        finally:
            self.lock.release()

    def settle_card(self) -> None:
        """The card held with nothing in hand, under the decision lock: rested, or given way to whoever
        already wants it and asked back, or let go where the arbiter keeps no rests."""
        said = self.card_lock.rest()
        if said == "rests":
            self.idle_since = self.clock()
            self.wake.set()
            self.watch_wake.set()
            return
        self.let_go()
        if said == "gives way":
            self.gave_way += 1
        if said == "gives way" or self.card_lock.knows_rests:
            # Asked back, as an arbiter that rested the turn before grants once the card is free.
            self.card_lock.come_back()
            self.watch_wake.set()

    def watch_card(self, again_s: float = 0.2) -> None:
        """The card watched for the process's life, on a thread of its own (watch_step), asked again after a
        pause where an answer came back at once."""
        while True:
            asked_at = time.monotonic()
            try:
                asked = self.watch_step()
            except OSError:
                # An arbiter that does not answer is asked again after a pause; the lock still guards the card.
                asked = True
            except Exception as error:  # noqa: BLE001 - the watcher stays up for the next rest
                sys.stderr.write(f"laya-server: watching the card failed: {type(error).__name__}: {str(error)[:300]}\n")
                asked = True
            if not asked:
                self.watch_wake.wait(1.0)
                self.watch_wake.clear()
            elif time.monotonic() - asked_at < 0.05:
                time.sleep(again_s)

    def watch_step(self) -> bool:
        """One ask after the resting card's ticket, its answer held open until another wants the card, or,
        once the card was given way, after the ticket that only rests until it is granted; False where there
        is neither to ask after. What the answer calls for is done under the decision lock, and only where the
        card still stands as it did when asked: a call that came meanwhile has the card its own way."""
        lock = self.card_lock
        ticket = None if lock.turn is None else lock.turn.ticket
        resting, returning = lock.resting, lock.returning
        if ticket is None or not (resting or returning):
            return False
        answered = lock.turn.watch(ticket)
        with self.lock:
            if self.in_hand or lock.turn.ticket != ticket or (lock.resting, lock.returning) != (resting, returning):
                return True
            if resting and (answered is None or not answered.turn or answered.give_way_for is not None):
                # Asked for by another, or the arbiter no longer knows the turn: off the card, and back once free.
                self.let_go()
                self.gave_way += 1
                lock.come_back()
            elif returning and answered is None:
                lock.come_back()
            elif returning and answered.turn and lock.take_returned():
                self.idle_since = self.clock()
                self.wake.set()
        return True

    def keep(self, tick_s: float = 0.05) -> None:
        """The idle card tended for the process's life, on a thread of its own."""
        while True:
            self.wake.wait(tick_s)
            self.wake.clear()
            try:
                self.tend()
            except Exception as error:  # noqa: BLE001 - the keeper stays up for the next call
                sys.stderr.write(f"laya-server: tending the card failed: {type(error).__name__}: {str(error)[:300]}\n")

    def predict_on_card(self, checkpoint: Any, state: Any, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """The checkpoint's decision, made on the card. One that runs out of card, or is counted short of it
        before it starts, is asked again with the least recently asked other checkpoint taken off, until the
        asking one is alone there. The room is lent: the checkpoints taken off go back on as the card is
        filled again."""
        made_room = False
        while True:
            others = [gate for gate in self.card if gate != checkpoint.gate]
            self.room.ahead = bool(others)
            try:
                result = checkpoint.predict(state, questions)
                break
            except CardFull:
                pass
            finally:
                self.room.ahead = False
            if not others:
                raise NoRoom(f"the card has no room for this {checkpoint.gate} decision even with its checkpoint alone on it")
            self.card.pop(others[0]).take_off_card()
            made_room = True
        if made_room:
            self.room_made += 1
        return result

    def decide(self, gate: str, state: Any, questions: Dict[str, Dict[str, Any]],
               caller_waiting: Callable[[], bool] = lambda: True) -> Dict[str, Any]:
        checkpoint = self.checkpoints.get(gate)
        if checkpoint is None:
            raise Unserved(f"no checkpoint here serves the gate {gate}")
        started = time.perf_counter()
        with self.in_hand_lock:
            self.in_hand += 1
            self.waiting[gate] = self.waiting.get(gate, 0) + 1
            self.calls += 1
            call = self.calls
            self.arrivals[call] = self.clock()
        with self.lock:
            try:
                result = self.decide_in_turn(checkpoint, state, questions, caller_waiting, self.arrivals[call])
            finally:
                with self.in_hand_lock:
                    self.in_hand -= 1
                    self.waiting[gate] -= 1
                    del self.arrivals[call]
                    oldest = min(self.arrivals.values()) if self.arrivals else None
                if self.card_lock.path is not None and self.card_lock.held:
                    if oldest is None:
                        self.settle_card()
                    elif not self.card_lock.keeps(self.clock() - oldest):
                        self.let_go()
                elif oldest is None:
                    self.idle_since = self.clock()
                    self.wake.set()
                    if self.card_lock.path is not None and self.card_lock.knows_rests and not self.card_lock.returning:
                        # A call that ended off the card, refused or left, leaves the card asked back all the same.
                        self.card_lock.come_back()
                        self.watch_wake.set()
        return {**result, "ms": round((time.perf_counter() - started) * 1000, 2)}

    def decide_in_turn(self, checkpoint: Any, state: Any, questions: Dict[str, Dict[str, Any]],
                       caller_waiting: Callable[[], bool], arrived: Optional[float] = None) -> Dict[str, Any]:
        gate = checkpoint.gate
        if not caller_waiting():
            self.dropped_calls += 1
            raise CallerLeft(f"the caller of a {gate} decision left before its turn")
        waited_s = 0.0 if arrived is None else self.clock() - arrived
        if self.card_lock.resting and not self.card_lock.resume(waited_s):
            # Another stands first for the card: the rest ends in giving way, and the call asks in line.
            self.let_go()
            self.gave_way += 1
        try:
            self.card_lock.take(waited_s=waited_s, caller_waiting=caller_waiting)
        except CallerLeft:
            self.dropped_calls += 1
            raise
        except (Taken, NoPlace):
            self.taken_refused += 1
            raise
        # How long the call stood before the card was its own: its wait behind the calls ahead of it here
        # and for its turn in the node's queue.
        waited_ms = None if arrived is None else round((self.clock() - arrived) * 1000, 2)
        self.asked[gate] = None
        self.asked.move_to_end(gate)
        try:
            self.bring(checkpoint)
            return {**self.predict_on_card(checkpoint, state, questions), "waitMs": waited_ms}
        except ValueError as error:
            # Laya's own refusal of a question it cannot lay out (options past its head budget).
            raise Refused(str(error)) from error
        finally:
            checkpoint.settle()
            if not checkpoint.on_card:
                self.card.pop(gate, None)

    def let_go(self) -> None:
        """Take every checkpoint off the card and let the lock go. Called under the decision lock."""
        for checkpoint in self.checkpoints.values():
            if checkpoint.on_card:
                checkpoint.take_off_card()
        self.card.clear()
        self.card_lock.release()

    def model_line(self) -> str:
        return ", ".join(f"{gate}={checkpoint.source}" for gate, checkpoint in self.checkpoints.items()) or "no gate"

    def health(self) -> Dict[str, Any]:
        return {
            "state": "up",
            "model": self.model_line(),
            "device": self.device,
            "vramBytes": self.vram(),
            "loadMs": sum(checkpoint.load_ms for checkpoint in self.checkpoints.values()),
            "cardModels": self.card_models,
            "moves": self.moves,
            "filled": self.filled,
            "cardLock": {**self.card_lock.described(), "takenRefused": self.taken_refused},
            "roomMade": self.room_made,
            "gaveWay": self.gave_way,
            "freeBytes": self.free_bytes(),
            "droppedCalls": self.dropped_calls,
            "versions": self.versions,
            "gates": {gate: checkpoint.described() for gate, checkpoint in self.checkpoints.items()},
        }


def handler_for(decider: Decider, token: str):
    expected = f"Bearer {token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "bmo-laya"

        def log_message(self, fmt: str, *args: Any) -> None:
            # A line per call without a body: what was asked of which path and how it ended.
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def answer(self, status: int, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            try:
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                decider.dropped_calls += 1
                sys.stderr.write(f"{self.address_string()} left before its answer\n")

        def caller_waiting(self) -> bool:
            """Whether the caller still holds its end of the connection: one it closed reads as ended."""
            try:
                return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) != b""
            except (BlockingIOError, InterruptedError):
                return True
            except OSError:
                return False

        def authorised(self) -> bool:
            given = (self.headers.get("Authorization") or "").encode()
            if hmac.compare_digest(given, expected):
                return True
            self.answer(HTTPStatus.UNAUTHORIZED, {"error": "unauthorised"})
            return False

        def do_GET(self) -> None:
            if not self.authorised():
                return
            if self.path != "/health":
                self.answer(HTTPStatus.NOT_FOUND, {"error": "no such path"})
                return
            self.answer(HTTPStatus.OK, decider.health())

        def do_POST(self) -> None:
            if not self.authorised():
                return
            if self.path != "/decide":
                self.answer(HTTPStatus.NOT_FOUND, {"error": "no such path"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise Refused(f"the body must be 1 to {MAX_BODY_BYTES} bytes")
                try:
                    body = json.loads(self.rfile.read(length))
                except json.JSONDecodeError as error:
                    raise Refused("the body is not JSON") from error
                gate, state, questions = check_request(body)
                self.answer(HTTPStatus.OK, decider.decide(gate, state, questions, self.caller_waiting))
            except CallerLeft as error:
                self.close_connection = True
                sys.stderr.write(f"{self.address_string()} {error}\n")
            except Refused as error:
                self.answer(error.status, {"error": str(error)})
            except (NoRoom, NoPlace, Taken) as error:
                # Never told when to come back: a call is either waited out or cannot be taken here at all.
                self.answer(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - the process stays up for the next call
                sys.stderr.write(f"decide failed: {type(error).__name__}: {str(error)[:300]}\n")
                self.answer(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": type(error).__name__})

    return Handler


def load_decider() -> Decider:
    import laya
    import torch
    import transformers

    named = read_checkpoints(os.environ.get("LAYA_CHECKPOINTS", ""))
    card_models = int(os.environ.get("LAYA_CARD_MODELS", "1"))
    keep_free_bytes = int(os.environ.get("LAYA_CARD_KEEP_FREE_MIB", "0")) << 20
    copies = host_copies(os.environ.get("LAYA_HOST_COPY", "pinned"),
                         os.environ.get("LAYA_DUMP_DIR", "") or os.path.expanduser("~/.cache/bmo-laya/dumps"))

    fill_quiet_s = float(os.environ.get("LAYA_FILL_QUIET_MS", "500")) / 1000
    room_bytes = int(os.environ.get("LAYA_DECISION_ROOM_MIB", "768")) << 20

    def room_free() -> Optional[int]:
        """The card's free memory, what the allocator holds unused counted with it: what a pass or a
        checkpoint's copy may take."""
        try:
            return int(torch.cuda.mem_get_info()[0]) + int(torch.cuda.memory_reserved()) - int(torch.cuda.memory_allocated())
        except Exception:  # noqa: BLE001 - a card whose free memory cannot be read is held to the count alone
            return None

    def pass_began() -> int:
        torch.cuda.reset_peak_memory_stats()
        return int(torch.cuda.memory_allocated())

    room = Room(room_free, (pass_began, lambda began: int(torch.cuda.max_memory_allocated()) - began))
    card_lock = CardLock(os.environ.get("LAYA_GPU_LOCK", "").strip() or None, card_turn())
    if card_lock.path is not None:
        # The one wait on the lock: nothing is answered before every checkpoint has been tried anyway.
        sys.stderr.write(f"laya-server: waiting for the card lock {card_lock.path}\n")
        card_lock.take(wait=True)
    checkpoints: Dict[str, Checkpoint] = {}
    tokenizers: Dict[str, Any] = {}
    for gate, directory in named.items():
        started = time.perf_counter()
        agent = laya.load(directory, device="cuda")
        load_ms = round((time.perf_counter() - started) * 1000)
        share_tokenizer(agent, directory, tokenizers)
        # One decision before the port opens: a server that answers /health can also decide for
        # every gate it names, and a checkpoint that cannot run a forward pass stops the unit
        # instead of failing every call.
        agent.predict(WARM_STATE, WARM_QUESTIONS)
        # Named as the settings file names it, which is shorter than the whole path under ~/bmo-laya.
        source = os.path.relpath(directory, HERE) if directory.startswith(HERE + os.sep) else directory
        checkpoint = Checkpoint(gate, source, agent, load_ms, copies, directory, room)
        checkpoint.take_off_card()
        checkpoints[gate] = checkpoint
        sys.stderr.write(f"laya-server: {gate} from {directory} in {load_ms} ms\n")

    def vram() -> Optional[int]:
        return int(torch.cuda.memory_reserved()) if torch.cuda.is_available() else None

    # A load leaves what it built on the processor in the C heap, which the process would otherwise hold,
    # mostly in swap, for as long as it runs; the tokenizers shared away go with it.
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass  # not glibc: nothing to trim this way
    # The lock stays: the card rests from here with the checkpoints going back on, or is let go where the
    # arbiter keeps no rests (Decider.tend).
    if checkpoints and torch.cuda.is_available():
        # Read with every checkpoint off the card: what the card has beside the engine's own context.
        fit = card_fit(room_free() or int(torch.cuda.mem_get_info()[1]), keep_free_bytes, room_bytes,
                       max(checkpoint.card_bytes for checkpoint in checkpoints.values()))
        kept_free = f" and {keep_free_bytes >> 20} MiB kept free" if keep_free_bytes else ""
        sys.stderr.write(f"laya-server: the card takes {fit} checkpoints beside the decision room{kept_free};"
                         f" at most {card_models} are let on\n")
        card_models = min(card_models, fit)
    versions = {"laya": laya.__version__, "torch": torch.__version__, "transformers": transformers.__version__}
    return Decider(checkpoints, card_models, "cuda", versions, vram, card_lock,
                   free_bytes=room_free, room_bytes=room_bytes, fill_quiet_s=fill_quiet_s, room=room)


def main() -> None:
    host = os.environ.get("LAYA_HOST", "127.0.0.1")
    port = int(os.environ.get("LAYA_PORT", "7431"))
    token = read_token()
    decider = load_decider()
    threading.Thread(target=decider.keep, daemon=True).start()
    threading.Thread(target=decider.watch_card, daemon=True).start()
    sys.stderr.write(f"laya-server: serving {decider.model_line()}, {decider.card_models} on the card at a time,"
                     " each call waiting for its turn for as long as its caller does\n")
    ThreadingHTTPServer((host, port), handler_for(decider, token)).serve_forever()


if __name__ == "__main__":
    main()
