"""The server's HTTP contract against stand-in checkpoints: run by tests/python.rs"""

from __future__ import annotations

import fcntl
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "laya-server"))
sys.path.insert(0, os.path.join(HERE, "..", "support"))

from server import CardFull, CardLock, Decider, ForwardFailed, Room, guard_forward, handler_for, read_checkpoints, read_token  # noqa: E402
from waits import Waits  # noqa: E402

TOKEN = "test-token"


class StandIn:
    """A checkpoint as the Decider handles one, with the card moves recorded instead of made."""

    def __init__(self, gate, moves, full=0):
        self.gate = gate
        # Decisions that run out of card before one fits, and a hold a decision waits on.
        self.tight = 0
        self.hold = None
        self.holding = threading.Event()
        self.source = f"checkpoints/{gate}/run/step-000001"
        self.load_ms = 1000
        self.on_card = False
        self.moves = moves
        self.full = full
        self.asked = []

    def put_on_card(self):
        if self.full > 0:
            self.full -= 1
            raise RuntimeError("CUDA out of memory. Tried to allocate 1.2 GiB")
        self.moves.append(("on", self.gate))
        self.on_card = True

    def take_off_card(self):
        if self.on_card:
            self.moves.append(("off", self.gate))
        self.on_card = False

    def settle(self):
        pass

    def predict(self, state, questions):
        if self.hold is not None:
            self.holding.set()
            self.hold.wait(5)
        if self.tight > 0:
            self.tight -= 1
            raise CardFull("OutOfMemoryError: CUDA out of memory. Tried to allocate 520 MiB")
        self.asked.append((state, questions))
        if "overflow" in questions:
            raise ValueError("question 'overflow' options exceed head_max_len=192")
        return {"model": "laya-rl-agent", "answers": {qid: {"type": "noul", "noul": 0.9, "confidence": 0.9}
                                                       for qid in questions}}

    def described(self):
        return {"model": self.source, "where": "card" if self.on_card else "pinned", "loadMs": self.load_ms}


def noul(gate, state="\uc548\ub155", qid="fold"):
    return {"gate": gate, "state": state, "questions": {qid: {"type": "noul", "instructions": "\uc811\uc744\uae4c?"}}}


class ServerTest(unittest.TestCase):
    def serve(self, gates, card_models=1, full=None, **lock):
        if getattr(self, "server", None) is not None:
            self.tearDown()
        self.moves = []
        self.gates = {gate: StandIn(gate, self.moves, (full or {}).get(gate, 0)) for gate in gates}
        self.decider = decider = Decider(self.gates, card_models, "cuda", {"laya": "0.3.5"}, lambda: 700_000_000, **lock)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(decider, TOKEN))
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def setUp(self):
        self.serve(["output-decide", "library-knowledge"])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, path, body=None, token=TOKEN):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        request = urllib.request.Request(self.url + path, data=data, method="GET" if data is None else "POST")
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_health_says_which_checkpoint_serves_which_gate(self):
        status, body = self.call("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "up")
        self.assertEqual(body["model"], "output-decide=checkpoints/output-decide/run/step-000001, "
                                        "library-knowledge=checkpoints/library-knowledge/run/step-000001")
        self.assertEqual(body["gates"]["library-knowledge"]["model"], "checkpoints/library-knowledge/run/step-000001")
        self.assertEqual(body["gates"]["output-decide"]["where"], "pinned")
        self.assertEqual(body["device"], "cuda")
        self.assertEqual(body["vramBytes"], 700_000_000)
        self.assertEqual(body["loadMs"], 2000)
        self.assertEqual(body["cardModels"], 1)

    def test_every_call_needs_the_token(self):
        self.assertEqual(self.call("/health", token=None)[0], 401)
        self.assertEqual(self.call("/health", token="wrong")[0], 401)
        self.assertEqual(self.call("/decide", noul("output-decide"), token="wrong")[0], 401)
        self.assertEqual(self.gates["output-decide"].asked, [])

    def test_decide_asks_the_gate_own_checkpoint(self):
        status, body = self.call("/decide", noul("library-knowledge", "\uc11c\uace0"))
        self.assertEqual(status, 200)
        self.assertEqual(body["answers"]["fold"], {"type": "noul", "noul": 0.9, "confidence": 0.9})
        self.assertIn("ms", body)
        self.assertEqual(self.gates["library-knowledge"].asked[0][0], "\uc11c\uace0")
        self.assertEqual(self.gates["output-decide"].asked, [])

    def test_a_gate_nobody_serves_is_refused_without_asking(self):
        status, body = self.call("/decide", noul("people-search"))
        self.assertEqual(status, 404)
        self.assertIn("people-search", body["error"])
        self.assertEqual(self.moves, [])

    def test_the_least_recently_asked_checkpoint_leaves_the_card(self):
        self.serve(["output-decide", "library-knowledge", "room-rules"], card_models=2)
        for gate in ["output-decide", "library-knowledge", "output-decide", "room-rules", "output-decide"]:
            self.assertEqual(self.call("/decide", noul(gate))[0], 200)
        self.assertEqual(self.moves, [("on", "output-decide"), ("on", "library-knowledge"),
                                      ("off", "library-knowledge"), ("on", "room-rules")])

    def test_a_full_card_is_cleared_once_before_giving_up(self):
        self.serve(["output-decide", "library-knowledge"], card_models=2, full={"library-knowledge": 1})
        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)
        self.assertEqual(self.call("/decide", noul("library-knowledge"))[0], 200)
        self.assertEqual(self.moves, [("on", "output-decide"), ("off", "output-decide"), ("on", "library-knowledge")])

        self.serve(["output-decide"], full={"output-decide": 2})
        status, body = self.call("/decide", noul("output-decide"))
        self.assertEqual(status, 503)
        self.assertIn("no room", body["error"])
        self.assertEqual(self.gates["output-decide"].asked, [])
        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)

    def test_a_decision_that_runs_out_of_card_is_lent_the_room_and_the_card_keeps_its_number(self):
        self.serve(["output-decide", "library-knowledge", "room-rules"], card_models=3)
        for gate in ["output-decide", "library-knowledge", "room-rules"]:
            self.assertEqual(self.call("/decide", noul(gate))[0], 200)
        self.gates["room-rules"].tight = 2
        self.assertEqual(self.call("/decide", noul("room-rules"))[0], 200)
        self.assertEqual(self.moves[3:], [("off", "output-decide"), ("off", "library-knowledge")])
        self.assertEqual(len(self.gates["room-rules"].asked), 2)
        health = self.call("/health")[1]
        self.assertEqual((health["cardModels"], health["roomMade"]), (3, 1))

        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)
        self.assertEqual(self.moves[5:], [("on", "output-decide")])

    def test_a_decision_that_does_not_fit_alone_is_no_room(self):
        self.gates["output-decide"].tight = 1
        status, body = self.call("/decide", noul("output-decide"))
        self.assertEqual(status, 503)
        self.assertIn("no room", body["error"])
        self.assertEqual(self.gates["output-decide"].asked, [])
        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)

    def lock_file(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        return os.path.join(folder.name, ".gpu.lock")

    def other_service_holds(self, path):
        """The lock as another service on the card holds it, let go when the test ends."""
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        return fd

    class Held:
        """The card arbiter's client as a node keeping a hold queue answers it: on hold for as many asks as
        `holds` says, then the turn; whether a turn carries on, as `keeps` says; whether it rests, as `rests`
        says, and for whom it is to give way once it rests (`wanted`); and the answers a watched ticket
        gets, in turn (`watched`)."""

        def __init__(self, holds: int, keeps: bool = False, claim=None, rests: bool = False):
            self.holds = holds
            self.keeps = keeps
            self.claim = claim
            self.rests = rests
            self.wanted = None
            self.watched: list = []
            self.asked: list = []
            self.kept: list = []
            self.rested = 0
            self.returned = 0
            self.given_back = 0
            self.ticket = None

        def ask(self, wait_s=0.0, waited_s=None, rest=False):
            if rest:
                self.returned += 1
                self.ticket = "back"
                return SimpleNamespace(turn=False, position=1, wait_s=1.0, claim=None)
            self.asked.append(waited_s)
            self.ticket = "turn"
            if self.holds > 0:
                self.holds -= 1
                return SimpleNamespace(turn=False, position=2, wait_s=7.4, claim=self.claim)
            return SimpleNamespace(turn=True)

        def keep(self, next_waited_s):
            self.kept.append(next_waited_s)
            return self.keeps

        def rest(self):
            self.rested += 1
            return SimpleNamespace(turn=True, resting=self.rests, give_way_for=self.wanted if self.rests else None)

        def watch(self, ticket, wait_s=20.0):
            return self.watched.pop(0)

        def give_back(self):
            self.given_back += 1
            self.ticket = None

    def test_a_call_waits_for_its_turn_inside_the_call_however_many_asks_it_takes(self):
        turn = self.Held(holds=40)
        self.serve(["output-decide"], card_lock=CardLock(self.lock_file(), turn, sleep=lambda seconds: None))
        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)
        self.assertEqual(len(turn.asked), 41)
        # The first ask stands the ticket by the call's arrival; the asks after it keep the same ticket.
        self.assertIsNotNone(turn.asked[0])
        self.assertEqual(set(turn.asked[1:]), {None})
        self.assertEqual(turn.given_back, 1)

    def test_a_card_a_claim_stands_on_is_answered_503_at_once_with_no_time_to_come_back(self):
        turn = self.Held(holds=1_000_000, claim="a-trainer")
        self.serve(["output-decide"], card_lock=CardLock(self.lock_file(), turn))
        request = urllib.request.Request(self.url + "/decide", data=json.dumps(noul("output-decide")).encode(), method="POST")
        request.add_header("Authorization", f"Bearer {TOKEN}")
        with self.assertRaises(urllib.error.HTTPError) as taken:
            urllib.request.urlopen(request)
        self.assertEqual((taken.exception.code, taken.exception.headers["Retry-After"]), (503, None))
        self.assertIn("a-trainer", json.load(taken.exception)["error"])
        self.assertEqual((len(turn.asked), turn.given_back, self.gates["output-decide"].asked), (1, 1, []))
        self.assertEqual(self.call("/health")[1]["cardLock"]["takenRefused"], 1)

    def test_a_lock_another_service_holds_is_waited_out_inside_the_call(self):
        path = self.lock_file()
        other = self.other_service_holds(path)
        # The other service lets go while the engine waits between two asks for the lock.
        self.serve(["output-decide"], card_lock=CardLock(path, sleep=lambda seconds: fcntl.flock(other, fcntl.LOCK_UN)))
        self.assertEqual(self.call("/decide", noul("output-decide"))[0], 200)
        self.assertEqual(self.moves, [("on", "output-decide"), ("off", "output-decide")])

    def test_the_card_is_let_go_when_the_last_call_in_hand_ends(self):
        path = self.lock_file()
        self.serve(["output-decide", "library-knowledge"], card_models=2, card_lock=CardLock(path))
        first = self.gates["output-decide"]
        first.hold = threading.Event()
        ahead = threading.Thread(target=self.call, args=("/decide", noul("output-decide")))
        ahead.start()
        self.assertTrue(first.holding.wait(5))
        behind = threading.Thread(target=self.call, args=("/decide", noul("library-knowledge")))
        behind.start()
        Waits().until(lambda: self.decider.in_hand >= 2, "the second call to be counted")

        # The first decision ends with the second waiting its turn, so the card is kept for it.
        first.hold.set()
        ahead.join(5)
        behind.join(5)
        self.assertEqual(self.moves, [("on", "output-decide"), ("on", "library-knowledge"),
                                      ("off", "output-decide"), ("off", "library-knowledge")])
        health = self.call("/health")[1]
        self.assertFalse(health["cardLock"]["held"])
        self.assertEqual({gate["where"] for gate in health["gates"].values()}, {"pinned"})
        fcntl.flock(self.other_service_holds(path), fcntl.LOCK_UN)

    def test_a_call_whose_caller_left_before_its_turn_is_dropped_unasked(self):
        first = self.gates["output-decide"]
        first.hold = threading.Event()
        ahead = threading.Thread(target=self.call, args=("/decide", noul("output-decide")))
        ahead.start()
        self.assertTrue(first.holding.wait(5))
        body = json.dumps(noul("library-knowledge")).encode()
        with socket.create_connection(self.server.server_address) as gone:
            gone.sendall(b"POST /decide HTTP/1.1\r\nHost: laya\r\nAuthorization: Bearer " + TOKEN.encode()
                         + b"\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode()
                         + b"\r\n\r\n" + body)
        first.hold.set()
        ahead.join(5)
        Waits().until(lambda: self.call("/health")[1]["droppedCalls"] >= 1, "the call whose caller left to be dropped")
        self.assertEqual(len(first.asked), 1)
        self.assertEqual(self.gates["library-knowledge"].asked, [])

    def test_malformed_requests_are_refused_without_asking(self):
        question = {"a": {"type": "noul", "instructions": "x"}}
        cases = [
            b"not json",
            {"state": "x", "questions": question},
            {"gate": "Output Decide", "state": "x", "questions": question},
            {"gate": "output-decide", "questions": question},
            {"gate": "output-decide", "state": "x", "questions": {}},
            {"gate": "output-decide", "state": "x", "questions": {"a": {"type": "guess", "instructions": "x"}}},
            {"gate": "output-decide", "state": "x", "questions": {"a": {"type": "noul"}}},
            {"gate": "output-decide", "state": "x", "questions": {"a": {"type": "choice", "instructions": "x", "criteria": ["one"]}}},
            {"gate": "output-decide", "state": "x", "questions": {f"q{i}": {"type": "noul", "instructions": "x"} for i in range(129)}},
        ]
        for case in cases:
            self.assertEqual(self.call("/decide", case)[0], 400, case)
        self.assertEqual(self.gates["output-decide"].asked, [])
        self.assertEqual(self.moves, [])

    def test_laya_own_refusal_is_a_refusal(self):
        status, body = self.call("/decide", noul("output-decide", qid="overflow"))
        self.assertEqual(status, 400)
        self.assertIn("head_max_len", body["error"])

    def test_unknown_paths(self):
        self.assertEqual(self.call("/nothing")[0], 404)
        self.assertEqual(self.call("/health", {"state": "x"})[0], 404)


class GuardedForwardTest(unittest.TestCase):
    """The forward pass a checkpoint runs, as Laya's own fallback to the CPU sees it."""

    class Model:
        def __init__(self, failure=None):
            self.failure = failure

        def forward(self, x):
            if self.failure is not None:
                raise self.failure
            return x * 2

    def decide_as_laya(self, model):
        # Laya catches a RuntimeError out of the forward pass and decides on the CPU instead.
        try:
            return model.forward(3)
        except RuntimeError:
            return "cpu"

    def test_a_pass_that_works_is_untouched(self):
        model = self.Model()
        guard_forward(model)
        self.assertEqual(self.decide_as_laya(model), 6)

    def test_a_card_that_runs_out_never_reaches_the_cpu(self):
        model = self.Model(RuntimeError("CUDA out of memory. Tried to allocate 520.00 MiB"))
        guard_forward(model)
        with self.assertRaises(CardFull) as raised:
            self.decide_as_laya(model)
        self.assertIsNone(raised.exception.__context__)

    def test_any_other_failure_of_the_pass_never_reaches_the_cpu(self):
        model = self.Model(RuntimeError("CUDA error: an illegal memory access was encountered"))
        guard_forward(model)
        with self.assertRaises(ForwardFailed):
            self.decide_as_laya(model)

    class Ids:
        """Input ids as a pass lays them out: questions by padded length."""

        def __init__(self, questions, length):
            self.shape = (questions, length)

        def __mul__(self, other):
            return self

    def test_every_pass_is_measured_and_one_counted_short_fails_before_it_runs_while_room_can_be_made(self):
        taken = {"bytes": 4_000}
        room = Room(free=lambda: 10_000, peak=(lambda: 0, lambda began: taken["bytes"]))
        model = self.Model()
        guard_forward(model, room)
        model.forward(self.Ids(4, 100))
        taken["bytes"] = 6_000
        model.forward(self.Ids(8, 100))
        # A smaller pass is counted at the smallest step at least its size, never scaled from a small one.
        self.assertEqual(room.need(300), 4_000.0)
        self.assertEqual(room.need(700), 6_000.0)
        # Past the largest step, its take scaled by the cells: 2,000 cells at 6,000 for 800 outrun 10,000.
        self.assertEqual(room.need(2_000), 15_000.0)
        model.failure = AssertionError("the pass ran")
        room.ahead = True
        with self.assertRaises(CardFull):
            model.forward(self.Ids(2, 1000))
        room.ahead = False
        with self.assertRaises(AssertionError):
            model.forward(self.Ids(2, 1000))
        model.failure = None
        room.ahead = True
        model.forward(self.Ids(2, 400))
        self.assertIsNone(Room().need(100))


class CheckpointsSettingTest(unittest.TestCase):
    def test_pairs_are_read_in_order_and_relative_to_the_server(self):
        named = read_checkpoints("output-decide=checkpoints/output-format/r/step-000152\n  library-knowledge=/abs/lk", "/srv")
        self.assertEqual(list(named.items()), [("output-decide", "/srv/checkpoints/output-format/r/step-000152"),
                                               ("library-knowledge", "/abs/lk")])
        self.assertEqual(read_checkpoints("", "/srv"), {})

    def test_a_pair_that_cannot_be_read_stops_the_server(self):
        for text in ["output-decide", "=dir", "Output=dir", "a=x a=y", "a="]:
            with self.assertRaises(SystemExit, msg=text):
                read_checkpoints(text, "/srv")


class TokenTest(unittest.TestCase):
    def test_the_token_comes_from_the_environment_or_the_server_stops(self):
        self.assertEqual(read_token({"LAYA_TOKEN": " k1 \n"}), "k1")
        for env in ({}, {"LAYA_TOKEN": "  "}):
            with self.assertRaises(SystemExit):
                read_token(env)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


GIB = 1 << 30


class BatchTest(unittest.TestCase):
    """The card holding a batch: worked out from the free memory and the calls in hand, filled while a card
    with no lock named is idle, and under a named lock kept from call to call only while the next stands
    first, let go the moment none is left."""

    def decider(self, gates, card_models=8, free=None, named=True, turn=None, **kwargs):
        self.moves = []
        self.clock = Clock()
        self.lock_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.lock_dir.cleanup)
        checkpoints = {}
        for gate in gates:
            checkpoints[gate] = StandIn(gate, self.moves)
            checkpoints[gate].card_bytes = GIB
        self.free = free
        on_card = lambda: sum(1 for one in checkpoints.values() if one.on_card)
        free_bytes = (lambda: None) if free is None else (lambda: self.free - on_card() * GIB)
        lock = CardLock(os.path.join(self.lock_dir.name, ".gpu.lock") if named else None, turn)
        return Decider(checkpoints, card_models, "cuda", {}, lambda: 0, lock,
                       free_bytes=free_bytes, room_bytes=2 * GIB, clock=self.clock, **kwargs)

    def test_the_batch_is_as_many_as_the_free_memory_takes_beside_the_decision_room(self):
        decider = self.decider(["a", "b", "c", "d", "e"], free=5 * GIB)
        self.assertEqual(decider.next_batch("c"), ["c", "a", "b"])
        decider.asked.update({"e": None, "d": None})
        self.assertEqual(decider.next_batch("c"), ["c", "d", "e"])
        decider.waiting["b"] = 1
        self.assertEqual(decider.next_batch("c"), ["c", "b", "d"])

    def test_the_count_alone_holds_where_the_free_memory_cannot_be_read(self):
        decider = self.decider(["a", "b", "c"], card_models=2)
        self.assertEqual(decider.next_batch("c"), ["c", "a"])

    def test_the_idle_card_is_filled_one_move_at_a_time_and_a_turn_finds_its_gates_there(self):
        decider = self.decider(["a", "b", "c"], named=False)
        decider.decide("a", "s", {"q": {}})
        self.assertEqual(self.moves, [("on", "a")])
        decider.tend()
        self.assertEqual(self.moves, [("on", "a")], "nothing is moved in the moment between two calls")
        self.clock.now = 0.5
        decider.tend()
        decider.tend()
        decider.tend()
        self.assertEqual(self.moves, [("on", "a"), ("on", "b"), ("on", "c")])
        self.assertEqual((decider.moves, decider.filled), (1, 2))
        decider.decide("c", "s", {"q": {}})
        decider.decide("b", "s", {"q": {}})
        self.assertEqual(len(self.moves), 3)

    def test_a_gate_outside_the_batch_takes_the_others_off_together(self):
        decider = self.decider(["a", "b", "c", "d"], free=4 * GIB, named=False)
        decider.decide("a", "s", {"q": {}})
        self.clock.now = 1.0
        decider.tend()
        decider.decide("b", "s", {"q": {}})
        self.assertEqual(set(decider.card), {"a", "b"})
        self.moves.clear()
        decider.decide("d", "s", {"q": {}})
        self.assertEqual(self.moves, [("off", "a"), ("on", "d")])
        self.assertEqual(set(decider.card), {"b", "d"})

    def call_in_hand(self, decider, arrived):
        """A call counted in hand, as one waiting behind the decision lock is."""
        with decider.in_hand_lock:
            decider.in_hand += 1
            decider.waiting["b"] = decider.waiting.get("b", 0) + 1
            decider.arrivals[-1] = arrived

    def test_a_call_ending_with_another_in_hand_keeps_the_card_while_the_queue_says_it_stands_first(self):
        turn = ServerTest.Held(holds=0, keeps=True)
        decider = self.decider(["a", "b"], turn=turn)
        self.clock.now = 4.0
        self.call_in_hand(decider, arrived=1.5)
        decider.decide("a", "s", {"q": {}})
        self.assertTrue(decider.card_lock.held)
        self.assertEqual(turn.kept, [2.5])
        self.assertEqual(self.moves, [("on", "a")])

    def test_a_call_ending_with_another_in_hand_lets_go_once_the_queue_says_another_stands_first(self):
        turn = ServerTest.Held(holds=0, keeps=False)
        decider = self.decider(["a", "b"], turn=turn)
        self.call_in_hand(decider, arrived=0.0)
        decider.decide("a", "s", {"q": {}})
        self.assertFalse(decider.card_lock.held)
        self.assertEqual((self.moves, turn.given_back), ([("on", "a"), ("off", "a")], 1))

    def test_a_card_found_held_with_no_call_in_hand_is_let_go_by_the_keeper(self):
        decider = self.decider(["a"])
        decider.card_lock.take()
        self.assertTrue(decider.card_lock.held)
        decider.tend()
        self.assertFalse(decider.card_lock.held)

    def test_the_card_is_let_go_the_moment_the_last_call_ends_where_the_arbiter_keeps_no_rests(self):
        for turn in (None, ServerTest.Held(holds=0, rests=False)):
            decider = self.decider(["a", "b"], turn=turn)
            decider.decide("a", "s", {"q": {}})
            self.assertFalse(decider.card_lock.held)
            self.assertEqual(self.moves, [("on", "a"), ("off", "a")])

    def resting(self, gates=("a", "b"), **turn):
        """A decider whose first call has ended, its card resting under the arbiter's word."""
        self.turn = ServerTest.Held(holds=0, rests=True, **turn)
        decider = self.decider(list(gates), turn=self.turn)
        decider.decide("a", "s", {"q": {}})
        return decider

    def test_the_last_call_rests_with_every_checkpoint_on_the_card_and_the_rest_go_on_once_quiet(self):
        decider = self.resting()
        self.assertTrue(decider.card_lock.held)
        self.assertTrue(decider.card_lock.resting)
        self.assertEqual((self.moves, self.turn.given_back), ([("on", "a")], 0))
        self.clock.now = 0.5
        decider.tend()
        self.assertEqual(self.moves, [("on", "a"), ("on", "b")])
        self.assertTrue(decider.health()["cardLock"]["resting"])

    def test_a_resting_card_gives_way_when_another_asks_and_comes_back_once_granted(self):
        decider = self.resting()
        self.turn.watched = [SimpleNamespace(turn=True, give_way_for="laya-train")]
        self.assertTrue(decider.watch_step())
        self.assertFalse(decider.card_lock.held)
        self.assertEqual(self.moves, [("on", "a"), ("off", "a")])
        self.assertEqual((self.turn.given_back, self.turn.returned, decider.card_lock.returning), (1, 1, True))
        self.assertEqual(decider.health()["gaveWay"], 1)

        self.turn.watched = [SimpleNamespace(turn=False, give_way_for=None)]
        decider.watch_step()
        self.assertFalse(decider.card_lock.held)
        self.turn.watched = [SimpleNamespace(turn=True, give_way_for=None)]
        decider.watch_step()
        self.assertTrue(decider.card_lock.held)
        self.assertTrue(decider.card_lock.resting)
        self.clock.now = 1.0
        decider.tend()
        decider.tend()
        self.assertEqual(self.moves[2:], [("on", "a"), ("on", "b")])

    def test_a_resting_turn_the_arbiter_lost_is_let_go_and_asked_back(self):
        decider = self.resting()
        self.turn.watched = [None]
        decider.watch_step()
        self.assertEqual((decider.card_lock.held, decider.card_lock.returning), (False, True))

    def test_a_resting_card_already_wanted_when_the_call_ends_gives_way_at_once(self):
        self.turn = ServerTest.Held(holds=0, rests=True)
        self.turn.wanted = "voice"
        decider = self.decider(["a"], turn=self.turn)
        decider.decide("a", "s", {"q": {}})
        self.assertFalse(decider.card_lock.held)
        self.assertEqual((self.moves, self.turn.returned), ([("on", "a"), ("off", "a")], 1))

    def test_a_call_while_resting_is_decided_where_the_card_stands_when_the_queue_keeps_it(self):
        decider = self.resting(keeps=True)
        self.clock.now = 3.0
        decider.decide("a", "s", {"q": {}})
        self.assertEqual(self.turn.kept, [0.0])
        self.assertEqual((self.moves, self.turn.given_back, len(self.turn.asked)), ([("on", "a")], 0, 1))
        self.assertTrue(decider.card_lock.resting)

    def test_a_call_while_resting_that_does_not_stand_first_gives_way_and_asks_in_line(self):
        decider = self.resting(keeps=False)
        decider.decide("b", "s", {"q": {}})
        self.assertEqual(self.turn.given_back, 1)
        self.assertEqual(len(self.turn.asked), 2)
        self.assertEqual(self.moves, [("on", "a"), ("off", "a"), ("on", "b")])
        self.assertTrue(decider.card_lock.resting)

    def test_a_call_while_the_card_waits_to_come_back_gives_that_ticket_back_and_stands_by_its_own(self):
        decider = self.resting()
        self.turn.watched = [SimpleNamespace(turn=True, give_way_for="laya-train")]
        decider.watch_step()
        decider.decide("b", "s", {"q": {}})
        self.assertEqual((self.turn.given_back, len(self.turn.asked), decider.card_lock.returning), (2, 2, False))
        self.assertTrue(decider.card_lock.resting)

    def test_a_call_refused_off_the_card_leaves_it_asked_back(self):
        decider = self.resting()
        self.turn.watched = [SimpleNamespace(turn=True, give_way_for="a-trainer")]
        decider.watch_step()
        self.turn.holds, self.turn.claim = 1, "a-trainer"
        with self.assertRaises(Exception):
            decider.decide("a", "s", {"q": {}})
        self.assertEqual((self.turn.returned, decider.card_lock.returning), (2, True))

    def test_a_decision_counted_short_has_room_made_before_its_pass_and_the_room_is_lent(self):
        decider = self.decider(["a", "b", "c"], card_models=3, named=False)
        for gate in ["b", "c", "a"]:
            decider.decide(gate, "s", {"q": {}})
        decider.checkpoints["a"].tight = 1
        decider.decide("a", "s", {"q": {}})
        self.assertEqual(self.moves[3:], [("off", "b")])
        self.assertEqual((decider.card_models, decider.room_made), (3, 1))
        self.assertFalse(decider.room.ahead)


if __name__ == "__main__":
    unittest.main()
