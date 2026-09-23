"""The server's HTTP contract against a stand-in agent: python3 -m unittest laya-server/test_server.py"""

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

from server import Decider, handler_for  # noqa: E402

TOKEN = "test-token"


class StandIn:
    device = "cuda:0"
    temperature = [1.0, 1.0, 1.0]
    temperature_by_options = {}

    def __init__(self):
        self.asked = []

    def predict(self, state, questions):
        self.asked.append((state, questions))
        if "overflow" in questions:
            raise ValueError("question 'overflow' options exceed head_max_len=192")
        return {"model": "laya-rl-agent", "answers": {qid: {"type": "noul", "noul": 0.9, "confidence": 0.9}
                                                       for qid in questions}}


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.agent = StandIn()
        decider = Decider(self.agent, "convaiinnovations/laya/multilingual", 1234, {"laya": "0.3.5"}, lambda: 700_000_000)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(decider, TOKEN))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

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

    def test_health_says_what_is_loaded(self):
        status, body = self.call("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "up")
        self.assertEqual(body["model"], "convaiinnovations/laya/multilingual")
        self.assertEqual(body["device"], "cuda:0")
        self.assertEqual(body["vramBytes"], 700_000_000)
        self.assertEqual(body["loadMs"], 1234)

    def test_every_call_needs_the_token(self):
        self.assertEqual(self.call("/health", token=None)[0], 401)
        self.assertEqual(self.call("/health", token="wrong")[0], 401)
        self.assertEqual(self.call("/decide", {"state": "x", "questions": {}}, token="wrong")[0], 401)
        self.assertEqual(self.agent.asked, [])

    def test_decide_hands_back_laya_answers_as_they_stand(self):
        status, body = self.call("/decide", {"state": "안녕", "questions": {"fold": {"type": "noul", "instructions": "접을까?"}}})
        self.assertEqual(status, 200)
        self.assertEqual(body["answers"]["fold"], {"type": "noul", "noul": 0.9, "confidence": 0.9})
        self.assertIn("ms", body)
        self.assertEqual(self.agent.asked[0][0], "안녕")

    def test_malformed_requests_are_refused_without_asking(self):
        cases = [
            b"not json",
            {"questions": {"a": {"type": "noul", "instructions": "x"}}},
            {"state": "x", "questions": {}},
            {"state": "x", "questions": {"a": {"type": "guess", "instructions": "x"}}},
            {"state": "x", "questions": {"a": {"type": "noul"}}},
            {"state": "x", "questions": {"a": {"type": "choice", "instructions": "x", "criteria": ["one"]}}},
            {"state": "x", "questions": {f"q{i}": {"type": "noul", "instructions": "x"} for i in range(129)}},
        ]
        for case in cases:
            self.assertEqual(self.call("/decide", case)[0], 400, case)
        self.assertEqual(self.agent.asked, [])

    def test_laya_own_refusal_is_a_refusal(self):
        status, body = self.call("/decide", {"state": "x", "questions": {"overflow": {"type": "noul", "instructions": "x"}}})
        self.assertEqual(status, 400)
        self.assertIn("head_max_len", body["error"])

    def test_unknown_paths(self):
        self.assertEqual(self.call("/nothing")[0], 404)
        self.assertEqual(self.call("/health", {"state": "x"})[0], 404)


if __name__ == "__main__":
    unittest.main()
