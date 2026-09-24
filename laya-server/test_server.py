"""The server's HTTP contract against stand-in checkpoints: python3 -m unittest laya-server/test_server.py"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import Decider, handler_for, read_checkpoints, read_token  # noqa: E402

TOKEN = "test-token"


class StandIn:
    """A checkpoint as the Decider handles one, with the card moves recorded instead of made."""

    def __init__(self, gate, moves, full=0):
        self.gate = gate
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
        self.asked.append((state, questions))
        if "overflow" in questions:
            raise ValueError("question 'overflow' options exceed head_max_len=192")
        return {"model": "laya-rl-agent", "answers": {qid: {"type": "noul", "noul": 0.9, "confidence": 0.9}
                                                       for qid in questions}}

    def described(self):
        return {"model": self.source, "onCard": self.on_card, "loadMs": self.load_ms}


def noul(gate, state="안녕", qid="fold"):
    return {"gate": gate, "state": state, "questions": {qid: {"type": "noul", "instructions": "접을까?"}}}


class ServerTest(unittest.TestCase):
    def serve(self, gates, card_models=1, full=None):
        if getattr(self, "server", None) is not None:
            self.tearDown()
        self.moves = []
        self.gates = {gate: StandIn(gate, self.moves, (full or {}).get(gate, 0)) for gate in gates}
        decider = Decider(self.gates, card_models, "cuda", {"laya": "0.3.5"}, lambda: 700_000_000)
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
        self.assertFalse(body["gates"]["output-decide"]["onCard"])
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
        status, body = self.call("/decide", noul("library-knowledge", "서고"))
        self.assertEqual(status, 200)
        self.assertEqual(body["answers"]["fold"], {"type": "noul", "noul": 0.9, "confidence": 0.9})
        self.assertIn("ms", body)
        self.assertEqual(self.gates["library-knowledge"].asked[0][0], "서고")
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


if __name__ == "__main__":
    unittest.main()
