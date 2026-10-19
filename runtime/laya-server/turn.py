"""The gate's own client of the node card arbiter's `POST /turns` (`docs/boundary-api.md`, 「bmo-arbiter」).

Waiting a turn for the card through the node's card arbiter (the arbiter's docs/node-arbiter.md, 「The hold」), for an occupant
that runs in a process of its own: the Laya engine, the voice server, a training run.

An occupant asks the arbiter on the node's loopback for a ticket under its own service name. The answer is
200 with `turn: true` where the card is its now, or 202 with its place in the queue and how long the wait
is counted at; the answer is held open until the turn comes or a while passes, so the occupant hears of its
turn the moment the card is handed on, then takes the node's card lock itself and gives the ticket back
once it has let go. An occupant serving requests one after another asks after each whether its next request
still stands first (`keep`), and carries on with the card where it does (the arbiter's docs/node-arbiter.md, 「One queue of
requests」). A node whose arbiter does not answer keeps no queue, and the occupant takes the lock as it
comes, as it always did.

Run as a command, it holds a turn and the lock around another command:

    python turn.py --service laya [--lock ~/.gpu.lock] -- <command> [<argument> …]

An occupant that can let go of the card in the middle of its work holds a turn that gives way instead
(the arbiter's docs/node-arbiter.md, 「Giving way」): `GivingTurn` asks for it with the seconds letting go takes, watches its
ticket while the card is held, and says once an occupant above it wants the card; `quiet` waits until
the card has stood unasked for a while before it is asked for again.

An occupant with nothing left to serve rests on the card with its weights there (the arbiter's docs/node-arbiter.md, 「Resting」):
`rest` says so of its turn, `watch` holds an ask open until it is to give way, and a ticket asked with
`rest` stands only for coming back to the card once it is free.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

PORT = int(os.environ.get("CARD_TURN_PORT", "7439"))
ASK_TIMEOUT_S = 2.0
# How long a waiter has its answer held open at most, well inside the time a silent ticket is kept.
HOLD_OPEN_S = 20.0
# How long a waiter pauses before asking again where an answer came back early with no turn: an arbiter
# that holds no answer open, or a lock taken in the moment between by a process that asks for no turns.
AGAIN_S = 0.5


@dataclass
class Answer:
    """What the arbiter said of a ticket: the card is the occupant's now, or where it stands, how long its
    wait is counted at and the claimant the card waits for, if any; and for a turn that gives way, who it
    is to let go for."""
    turn: bool
    position: int | None = None
    wait_s: float | None = None
    give_way_for: str | None = None
    claim: str | None = None
    # Whether the turn rests, its weights on the card with nothing left to serve; an arbiter that keeps
    # no rests never says so.
    resting: bool = False


class TurnClient:
    """One occupant's ticket at the node's arbiter, kept across asks and given back after the lock. With
    `gives_way_s` its turns give way, the seconds being how long letting go takes it."""

    def __init__(self, service: str, port: int = PORT, gives_way_s: float | None = None) -> None:
        self.service = service
        self.base = f"http://127.0.0.1:{port}/turns"
        self.ticket: str | None = None
        self.gives_way_s = gives_way_s

    def _call(self, method: str, url: str, body: dict | None = None, held_s: float = 0.0) -> tuple[int, dict] | None:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=ASK_TIMEOUT_S + held_s) as answer:
                text = answer.read()
                return answer.status, json.loads(text) if text else {}
        except urllib.error.HTTPError as refused:
            try:
                return refused.code, json.loads(refused.read() or b"{}")
            except ValueError:
                return refused.code, {}
        except (OSError, ValueError):
            return None

    def ask(self, wait_s: float = 0.0, waited_s: float | None = None, rest: bool = False) -> Answer | None:
        """The card asked for, or the ticket asked after; None where no arbiter answers, so the occupant takes
        the lock as it comes. With `wait_s` the answer is held open until the turn comes, that long at most;
        a new ticket stands by its request's arrival, `waited_s` ago, or with `rest` for no request, only to
        rest on the card once it is free. A service the node has no place for is told so as a refusal."""
        held_s = max(0.0, min(wait_s, HOLD_OPEN_S))
        query = f"?waitS={held_s:g}" if held_s > 0 else ""
        answered = self._call("GET", f"{self.base}/{self.ticket}{query}", held_s=held_s) if self.ticket is not None else None
        if answered is None or answered[0] == 404:
            asked: dict = {"service": self.service}
            if self.gives_way_s is not None:
                asked["givesWayS"] = round(self.gives_way_s, 1)
            if waited_s is not None and waited_s > 0:
                asked["waitedS"] = round(waited_s, 3)
            if rest:
                asked["rest"] = True
            if held_s > 0:
                asked["waitS"] = held_s
            answered = self._call("POST", self.base, asked, held_s=held_s)
        if answered is None:
            self.ticket = None
            return None
        status, body = answered
        if status == 403:
            raise PermissionError(body.get("error", f"{self.service} has no place among this node's occupants"))
        if status not in (200, 202):
            return None
        self.ticket = body.get("ticket")
        return answer_of(body)

    def watch(self, ticket: str, wait_s: float = HOLD_OPEN_S) -> Answer | None:
        """A turn that gives way asked after with its answer held open until it is to give way, `wait_s` at
        most (the arbiter's docs/node-arbiter.md, 「Handing on」). It never asks for a new ticket: None where the arbiter no longer
        holds this one, and an OSError where no arbiter answers."""
        held_s = max(0.0, min(wait_s, HOLD_OPEN_S))
        answered = self._call("GET", f"{self.base}/{ticket}?waitS={held_s:g}", held_s=held_s)
        if answered is None:
            raise OSError("the card arbiter did not answer")
        status, body = answered
        return answer_of(body) if status in (200, 202) else None

    def keep(self, next_waited_s: float) -> bool:
        """Whether a turn carries on to the occupant's next request, which has waited `next_waited_s`: true only
        where the arbiter says that request still stands first. Anything else — another before it, no ticket,
        no arbiter, one that does not answer the question — lets the card go."""
        if self.ticket is None:
            return False
        answered = self._call("GET", f"{self.base}/{self.ticket}?next={max(0.0, next_waited_s):.3f}")
        return answered is not None and answered[0] == 200 and answered[1].get("keep") is True

    def rest(self) -> Answer | None:
        """The turn told it has nothing left to serve and keeps its weights on the card (the arbiter's docs/node-arbiter.md,
        「Resting」). The answer says whether the arbiter rests it (`resting`) and whether it is to give way at
        once; None where there is no ticket, no arbiter, or one that no longer holds the ticket."""
        if self.ticket is None:
            return None
        answered = self._call("GET", f"{self.base}/{self.ticket}?rest=1")
        return answer_of(answered[1]) if answered is not None and answered[0] == 200 else None

    def give_back(self) -> None:
        if self.ticket is not None:
            self._call("DELETE", f"{self.base}/{self.ticket}")
            self.ticket = None

    def state(self) -> dict | None:
        """The arbiter's state of the card, or None where no arbiter answers."""
        answered = self._call("GET", self.base)
        return answered[1] if answered is not None and answered[0] == 200 else None


def answer_of(body: dict) -> Answer:
    return Answer(bool(body.get("turn")), body.get("position"), body.get("waitS"),
                  body.get("for") if body.get("giveWay") else None, body.get("claim"), bool(body.get("resting")))


def try_lock(path: Path) -> int | None:
    """The lock taken without waiting, as an open descriptor, or None where another holds it."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BlockingIOError:
        os.close(fd)
        return None


def hold(client: TurnClient, lock: Path, until: float | None = None, said=None, waited_s: float | None = None) -> int | None:
    """The occupant's turn waited for, with the answer held open, then the lock taken; its descriptor, or None
    where `until` passed first. The ticket stands by a request that has waited `waited_s` already. Each
    answer that is not yet a turn is handed to `said`."""
    while True:
        left = HOLD_OPEN_S if until is None else max(0.0, until - time.monotonic())
        asked_at = time.monotonic()
        answered = client.ask(wait_s=left, waited_s=waited_s)
        waited_s = None
        if answered is None or answered.turn:
            fd = try_lock(lock)
            if fd is not None:
                return fd
        elif said is not None:
            said(answered)
        if until is not None and time.monotonic() >= until:
            client.give_back()
            return None
        # An answer that came back early with no turn, or a lock somebody took in the moment between, is
        # not asked again at once.
        if answered is None or answered.turn or time.monotonic() - asked_at < min(left, HOLD_OPEN_S) - 0.05:
            time.sleep(AGAIN_S)


class GivingTurn:
    """A turn that gives way, held by a process that can let go of the card in the middle of its work
    (the arbiter's docs/node-arbiter.md, 「Giving way」). `take` waits for the turn and the lock as `hold` does, then keeps one ask
    after the ticket held open on a thread of its own, which the arbiter answers the instant the turn is to
    give way; `asked_for` names the occupant it is to let go for once there is one, and `let_go` lets the
    lock and the ticket go. Where no arbiter answers, the lock is taken as it comes and nobody ever asks
    for it."""

    def __init__(self, client: TurnClient, lock: Path) -> None:
        self.client = client
        self.lock = lock
        self.fd: int | None = None
        self._asked: str | None = None
        self._stop = threading.Event()

    def take(self, said=None) -> None:
        self.fd = hold(self.client, self.lock, said=said)
        self._asked = None
        # Each turn is watched by a thread of its own that ends with it: one still holding its ask open as
        # the turn is let go hears its ticket is gone and says nothing to the next turn.
        self._stop = threading.Event()
        if self.client.ticket is not None:
            threading.Thread(target=self._watching, args=(self.client.ticket, self._stop), daemon=True).start()

    def _watching(self, ticket: str, stop: threading.Event) -> None:
        while not stop.is_set() and self._asked is None:
            try:
                self.check(ticket, stop)
            except OSError:
                # An arbiter that does not answer is asked again after a pause rather than at once.
                stop.wait(AGAIN_S)

    def check(self, ticket: str | None = None, stop: threading.Event | None = None, wait_s: float = HOLD_OPEN_S) -> None:
        """The ticket asked after once, its answer held open until the turn is to give way, `wait_s` at most."""
        ticket = ticket or self.client.ticket
        if ticket is None:
            return
        answered = self.client.watch(ticket, wait_s)
        if stop is not None and stop.is_set():
            return
        if answered is None or not answered.turn:
            # The arbiter no longer knows the turn — it started again — so the card is let go and asked
            # for afresh, where a turn that gives way can be told to again.
            self._asked = "a turn the arbiter lost"
        elif answered.give_way_for is not None:
            self._asked = answered.give_way_for

    def asked_for(self) -> str | None:
        return self._asked

    def let_go(self) -> None:
        self._stop.set()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.client.give_back()


def quiet(client: TurnClient, seconds: float, said=None, every_s: float = AGAIN_S,
          clock=time.monotonic, sleep=time.sleep) -> None:
    """Returns once the card has stood quiet for `seconds` on end — nobody using it and nobody waiting for a
    request, a resting holder being no use (the arbiter's docs/node-arbiter.md, 「Resting」) — and at once where no arbiter answers.
    `said` hears how long it has waited, every ten minutes."""
    began = clock()
    since = began
    told = began
    while True:
        state = client.state()
        if state is None:
            return
        now = clock()
        busy = state.get("busy")
        # An arbiter that keeps no rests says nothing of `busy`: then anybody holding or waiting is.
        if busy is None:
            busy = bool(state.get("lockHeldBy") or state.get("queue") or state.get("claim"))
        if busy:
            since = now
        elif now - since >= seconds:
            return
        if said is not None and now - told >= 600:
            told = now
            said(now - began)
        sleep(every_s)


def main() -> int:
    parser = argparse.ArgumentParser(description="hold a turn for the card and its lock around a command")
    parser.add_argument("--service", required=True)
    parser.add_argument("--lock", default=str(Path.home() / ".gpu.lock"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command goes after --")
    client = TurnClient(args.service)
    shown: list[int | None] = [None]

    def said(answered: Answer) -> None:
        if answered.position != shown[0]:
            shown[0] = answered.position
            print(f"turn: waiting for the card, {answered.position} in line, about {answered.wait_s:g} s", file=sys.stderr, flush=True)

    try:
        fd = hold(client, Path(args.lock), said=said)
    except PermissionError as refused:
        print(f"turn: {refused}", file=sys.stderr, flush=True)
        return 3
    assert fd is not None
    try:
        # The lock rides the command's own descriptor too, so it goes with the command's last process.
        return subprocess.run(command, pass_fds=(fd,)).returncode
    finally:
        os.close(fd)
        client.give_back()


if __name__ == "__main__":
    sys.exit(main())
