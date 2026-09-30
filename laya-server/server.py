"""The Laya decision server: one checkpoint per gate behind two HTTP calls.

GET /health answers what is loaded for which gate and where; POST /decide takes {"gate", "state",
"questions"} and answers with that gate's checkpoint's own answer for each question. Every call
carries the service key as its bearer. docs/laya-server.md is the whole account of it.
"""

from __future__ import annotations

import fcntl
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
from typing import Any, Callable, Dict, Optional

# Set before torch or transformers is first imported, whoever imports this module: USE_TF is the
# model card's cure for a load that hangs.
os.environ.setdefault("USE_TF", "0")

QUESTION_TYPES = ("choice", "score", "noul")
MAX_BODY_BYTES = 1 << 20
MAX_QUESTIONS = 128
WARM_STATE = "내일 배포 일정을 다시 잡아 주세요."
WARM_QUESTIONS = {"warm": {"type": "noul", "instructions": "이 메시지는 일정 변경 요청인가?"}}


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


class Busy(Exception):
    """Another service holds the shared card lock."""


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


class CardLock:
    """The lock the services sharing a card take turns by: an exclusive flock on one file, taken
    before anything goes on the card and let go once everything is off it. With no file named there is
    no lock, and taking it always succeeds."""

    def __init__(self, path: Optional[str]):
        self.path = path
        self.fd: Optional[int] = None

    @property
    def held(self) -> bool:
        return self.fd is not None

    def take(self, wait: bool = False) -> bool:
        if self.path is None or self.fd is not None:
            return True
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            os.close(fd)
            return False
        self.fd = fd
        return True

    def release(self) -> None:
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None

    def described(self) -> Dict[str, Any]:
        return {"path": self.path, "held": self.held}


def after(seconds: float, action: Callable[[], None]) -> Any:
    """Run action once, seconds from now, on a thread of its own; the handle it gives back cancels it."""
    timer = threading.Timer(seconds, action)
    timer.daemon = True
    timer.start()
    return timer


class Checkpoint:
    """One gate's loaded checkpoint, on the card or waiting in host memory.

    Laya builds its weights in 32 bits on the card. Taken off, each weight waits in pinned host
    memory in the 16 bits it was saved in where that holds it exactly, and in its own width where it
    does not, so putting it back reproduces the card's copy bit for bit.
    """

    def __init__(self, gate: str, source: str, agent: Any, load_ms: int):
        import torch

        self.gate = gate
        self.source = source
        self.agent = agent
        self.load_ms = load_ms
        self.device = agent.device
        self.dtype = agent.dtype
        self.on_card = True
        self.move_ms: Optional[float] = None
        guard_forward(agent.model)
        self.slots = []
        for module in agent.model.modules():
            for table in (module._parameters, module._buffers):
                for name, tensor in table.items():
                    if tensor is None:
                        continue
                    host = tensor.detach().to("cpu")
                    if host.dtype == torch.float32 and torch.equal(host.half().float(), host):
                        host = host.half()
                    self.slots.append((table, name, tensor.dtype, host.pin_memory()))

    def put_on_card(self) -> None:
        import torch

        started = time.perf_counter()
        for table, name, dtype, host in self.slots:
            table[name].data = host.to(self.device, non_blocking=True).to(dtype)
        torch.cuda.synchronize(self.device)
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
            "where": "card" if self.on_card else "pinned",
            "pinnedBytes": sum(host.numel() * host.element_size() for _, _, _, host in self.slots),
            "moveMs": self.move_ms,
            "loadMs": self.load_ms,
            "temperature": getattr(self.agent, "temperature", None),
            "temperatureByOptions": getattr(self.agent, "temperature_by_options", None),
        }


def is_out_of_memory(error: BaseException) -> bool:
    return "out of memory" in str(error).lower()


def guard_forward(model: Any) -> None:
    """Make the model's forward pass fail as CardFull or ForwardFailed rather than a RuntimeError, so
    Laya's own fallback to the CPU never runs and a decision that ran out of card is the Decider's to
    make room for. The error is let go before its stand-in is raised, so the activations its frames
    held are free by the time the room is made."""
    forward = model.forward

    def guarded(*args: Any, **kwargs: Any) -> Any:
        try:
            return forward(*args, **kwargs)
        except RuntimeError as error:
            failed = CardFull if is_out_of_memory(error) else ForwardFailed
            reason = f"{type(error).__name__}: {str(error)[:300]}"
        raise failed(reason)

    model.forward = guarded


class Decider:
    """The gates' checkpoints and the card they take turns on. One decision at a time.

    The card is used only under the card lock, and a call that finds the lock held elsewhere is
    refused at once. At most card_models checkpoints are on the card; asking a gate whose checkpoint
    waits in host memory takes the least recently asked one off first. A decision that runs out of
    card lowers card_models to the number that left it room. idle_seconds after the last decision
    every checkpoint leaves the card and the lock is let go; with none given they stay.
    """

    def __init__(self, checkpoints: Dict[str, Any], card_models: int, device: str, versions: Dict[str, str],
                 vram: Callable[[], Optional[int]], card_lock: Optional[CardLock] = None,
                 idle_seconds: Optional[float] = None, schedule: Callable[[float, Callable[[], None]], Any] = after,
                 clock: Callable[[], float] = time.monotonic):
        self.checkpoints = checkpoints
        self.card_lock = card_lock or CardLock(None)
        self.idle_seconds = idle_seconds
        self.schedule = schedule
        self.clock = clock
        self.rest_timer: Any = None
        self.last_decision = clock()
        self.busy_refused = 0
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

    def bring(self, checkpoint: Any) -> None:
        if checkpoint.on_card:
            self.card.move_to_end(checkpoint.gate)
            return
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
        self.card[checkpoint.gate] = checkpoint

    def predict_on_card(self, checkpoint: Any, state: Any, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """The checkpoint's decision, made on the card. One that runs out of card is asked again with the
        least recently asked other checkpoint taken off, until the asking one is alone there."""
        made_room = False
        while True:
            try:
                result = checkpoint.predict(state, questions)
                break
            except CardFull:
                pass
            others = [gate for gate in self.card if gate != checkpoint.gate]
            if not others:
                raise NoRoom(f"the card has no room for this {checkpoint.gate} decision even with its checkpoint alone on it")
            self.card.pop(others[0]).take_off_card()
            made_room = True
        if made_room:
            self.room_made += 1
            self.card_models = len(self.card)
        return result

    def decide(self, gate: str, state: Any, questions: Dict[str, Dict[str, Any]],
               caller_waiting: Callable[[], bool] = lambda: True) -> Dict[str, Any]:
        checkpoint = self.checkpoints.get(gate)
        if checkpoint is None:
            raise Unserved(f"no checkpoint here serves the gate {gate}")
        started = time.perf_counter()
        with self.lock:
            if not caller_waiting():
                self.dropped_calls += 1
                raise CallerLeft(f"the caller of a {gate} decision left before its turn")
            if not self.card_lock.take():
                self.busy_refused += 1
                raise Busy(f"the card is busy: another service holds {self.card_lock.path}")
            try:
                self.bring(checkpoint)
                result = self.predict_on_card(checkpoint, state, questions)
            except ValueError as error:
                # Laya's own refusal of a question it cannot lay out (options past its head budget).
                raise Refused(str(error)) from error
            finally:
                checkpoint.settle()
                if not checkpoint.on_card:
                    self.card.pop(gate, None)
                self.last_decision = self.clock()
                self.plan_rest()
        return {**result, "ms": round((time.perf_counter() - started) * 1000, 2)}

    def plan_rest(self) -> None:
        if self.idle_seconds is None:
            return
        if self.rest_timer is not None:
            self.rest_timer.cancel()
        self.rest_timer = self.schedule(self.idle_seconds, self.rest)

    def rest(self) -> None:
        """Take every checkpoint off the card and let the lock go once the idle time has passed since
        the last decision; a timer that fires early is planned again for what is left."""
        with self.lock:
            left = self.idle_seconds - (self.clock() - self.last_decision)
            if left > 0:
                self.rest_timer = self.schedule(left, self.rest)
                return
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
            "cardLock": {**self.card_lock.described(), "idleSeconds": self.idle_seconds,
                         "busyRefused": self.busy_refused},
            "roomMade": self.room_made,
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

        def answer(self, status: int, payload: Dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            try:
                self.send_response(status)
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
            except (Busy, NoRoom) as error:
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
    idle = os.environ.get("LAYA_CARD_IDLE_SECONDS", "").strip()
    card_lock = CardLock(os.environ.get("LAYA_GPU_LOCK", "").strip() or None)
    if card_lock.path is not None:
        # The one wait on the lock: nothing is answered before every checkpoint has been tried anyway.
        sys.stderr.write(f"laya-server: waiting for the card lock {card_lock.path}\n")
        card_lock.take(wait=True)
    checkpoints: Dict[str, Checkpoint] = {}
    for gate, directory in named.items():
        started = time.perf_counter()
        agent = laya.load(directory, device="cuda")
        load_ms = round((time.perf_counter() - started) * 1000)
        # One decision before the port opens: a server that answers /health can also decide for
        # every gate it names, and a checkpoint that cannot run a forward pass stops the unit
        # instead of failing every call.
        agent.predict(WARM_STATE, WARM_QUESTIONS)
        # Named as the settings file names it, which is shorter than the whole path under ~/bmo-laya.
        source = os.path.relpath(directory, HERE) if directory.startswith(HERE + os.sep) else directory
        checkpoint = Checkpoint(gate, source, agent, load_ms)
        checkpoint.take_off_card()
        checkpoints[gate] = checkpoint
        sys.stderr.write(f"laya-server: {gate} from {directory} in {load_ms} ms\n")

    def vram() -> Optional[int]:
        return int(torch.cuda.memory_reserved()) if torch.cuda.is_available() else None

    card_lock.release()
    versions = {"laya": laya.__version__, "torch": torch.__version__, "transformers": transformers.__version__}
    return Decider(checkpoints, card_models, "cuda", versions, vram, card_lock, float(idle) if idle else None)


def main() -> None:
    host = os.environ.get("LAYA_HOST", "127.0.0.1")
    port = int(os.environ.get("LAYA_PORT", "7431"))
    token = read_token()
    decider = load_decider()
    sys.stderr.write(f"laya-server: serving {decider.model_line()}, {decider.card_models} on the card at a time\n")
    ThreadingHTTPServer((host, port), handler_for(decider, token)).serve_forever()


if __name__ == "__main__":
    main()
