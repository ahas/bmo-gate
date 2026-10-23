"""The front's contract against a stand-in Laya engine, run by tests/python.rs. The front is served on a socket
that listens before it starts, so no call waits on it, and every wait on what another thread does goes through the
shared waits, on the clock they are handed."""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import uvicorn

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "runtime", "front"))
sys.path.insert(0, os.path.join(HERE, "..", "support"))

from front import build_app  # noqa: E402
from waits import Waits  # noqa: E402

KEY = "front-key-7f3a9c"
UPSTREAM_KEY = "engine-key-2b8e41"
MCP_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
}
QUESTIONS = {"q": {"type": "noul", "instructions": "Is this message a request to change a schedule?"}}
ANSWER = {"answers": {"q": {"type": "noul", "noul": 0.93, "confidence": 0.93}}, "ms": 18.2}
HEALTH = {"state": "up", "model": "room-rules=checkpoints/room-rules/r/step-000044", "device": "cuda",
          "gates": {"room-rules": {"model": "checkpoints/room-rules/r/step-000044", "onCard": True}}}


class StandInEngine:
    """What the front sees of the Laya engine: its keyed health and its decisions. It records what it
    was asked and answers as the test sets it to."""

    def __init__(self):
        self.healthy = True
        self.refusal: tuple[int, str] | None = None
        self.asked: list[dict] = []
        self.auth: list[str] = []
        # A decision held until the test lets it go, and whether the front had hung up by then; or, with
        # `until_hung_up`, held until the front hangs up.
        self.hold: threading.Event | None = None
        self.until_hung_up = False
        self.hung_up: list[bool] = []
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                stand_in.auth.append(self.headers.get("authorization", ""))
                if self.path != "/health":
                    self.reply(404, {"error": "no such path"})
                elif stand_in.healthy:
                    self.reply(200, HEALTH)
                else:
                    self.reply(503, {"error": "down"})

            def do_POST(self):
                stand_in.auth.append(self.headers.get("authorization", ""))
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                stand_in.asked.append(body)
                if stand_in.until_hung_up:
                    self.connection.settimeout(5)
                    try:
                        stand_in.hung_up.append(self.connection.recv(1) == b"")
                    except TimeoutError:
                        stand_in.hung_up.append(False)
                    return
                if stand_in.hold is not None:
                    stand_in.hold.wait(5)
                    try:
                        stand_in.hung_up.append(self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b"")
                    except BlockingIOError:
                        stand_in.hung_up.append(False)
                    return
                if stand_in.refusal is not None:
                    self.reply(stand_in.refusal[0], {"error": stand_in.refusal[1]})
                else:
                    self.reply(200, ANSWER)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# Short enough that a held decision costs the suite nothing.
DECIDE_TIMEOUT_S = 0.3


class FrontTest(unittest.TestCase):
    def setUp(self):
        self.waits = Waits()
        self.engine = StandInEngine()
        self.serve(DECIDE_TIMEOUT_S)
        self.bodies: list[str] = []

    def serve(self, decide_timeout_s: float) -> None:
        # The socket listens before the front runs, so a call made at once waits in its queue until the front
        # takes it rather than finding nothing there.
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(64)
        port = self.socket.getsockname()[1]
        config = uvicorn.Config(build_app(KEY, self.engine.url, UPSTREAM_KEY, decide_timeout_s), log_level="warning",
                                access_log=False)
        self.front = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.front.run, kwargs={"sockets": [self.socket]}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{port}"

    def stop_front(self) -> None:
        self.front.should_exit = True
        self.thread.join(5)
        self.socket.close()

    def tearDown(self):
        self.stop_front()
        self.engine.close()
        # Whatever the front answered in the test, the key never came back in it.
        for body in self.bodies:
            self.assertNotIn(KEY, body)
            self.assertNotIn(UPSTREAM_KEY, body)

    def call(self, path, body=None, key=KEY, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method="GET" if data is None else "POST")
        for name, value in (headers or {"content-type": "application/json"}).items():
            request.add_header(name, value)
        if key is not None:
            request.add_header("Authorization", f"Bearer {key}")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, text = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            with error:
                status, text = error.code, error.read().decode()
        self.bodies.append(text)
        return status, (json.loads(text) if text else None)

    def mcp(self, method, params=None):
        return self.call("/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers=MCP_HEADERS)

    def chat(self, **extra):
        body = {"model": "room-rules", "messages": [{"role": "system", "content": "\ubb34\uc2dc"}, {"role": "user", "content": "\ub0b4\uc77c \ubc30\ud3ec\ud574\uc694"}],
                "questions": QUESTIONS, **extra}
        return self.call("/v1/chat/completions", body)

    def test_health_says_only_whether_the_engine_stands_without_the_key(self):
        self.assertEqual(self.call("/health", key=None), (200, {"status": "ok"}))
        self.assertEqual(self.call("/health", key="wrong"), (200, {"status": "ok"}))
        self.engine.healthy = False
        self.assertEqual(self.call("/health", key=None)[0], 503)
        self.assertEqual(self.engine.auth[-1], f"Bearer {UPSTREAM_KEY}")

    def test_health_given_the_key_is_the_engine_own(self):
        self.assertEqual(self.call("/health"), (200, HEALTH))

    def test_health_is_down_when_the_engine_is_not_there(self):
        self.engine.close()
        self.assertEqual(self.call("/health", key=None)[0], 503)
        self.assertEqual(self.call("/decide", {"gate": "room-rules", "state": "x", "questions": QUESTIONS})[0], 503)
        self.engine = StandInEngine()

    def test_everything_else_needs_the_key(self):
        for path, body in (("/decide", {"gate": "room-rules"}), ("/v1/models", None),
                           ("/v1/chat/completions", {"model": "room-rules"}), ("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})):
            for key in (None, "wrong"):
                status, said = self.call(path, body, key=key)
                self.assertEqual(status, 401, path)
                self.assertNotIn("wrong", json.dumps(said))
        self.assertEqual(self.engine.asked, [])

    def test_decide_is_passed_through_as_the_engine_answers(self):
        asked = {"gate": "room-rules", "state": {"message": "\ub0b4\uc77c \ubc30\ud3ec\ud574\uc694"}, "questions": QUESTIONS}
        self.assertEqual(self.call("/decide", asked), (200, ANSWER))
        self.assertEqual(self.engine.asked[-1], asked)
        self.assertEqual(self.engine.auth[-1], f"Bearer {UPSTREAM_KEY}")

        self.engine.refusal = (404, "no checkpoint here serves the gate sanitizer")
        self.assertEqual(self.call("/decide", {**asked, "gate": "sanitizer"}),
                         (404, {"error": "no checkpoint here serves the gate sanitizer"}))

    def test_a_decision_the_engine_holds_is_a_504_and_the_front_hangs_up(self):
        self.engine.hold = threading.Event()
        asked = {"gate": "room-rules", "state": "x", "questions": QUESTIONS}
        status, said = self.call("/decide", asked)
        self.assertEqual(status, 504)
        self.assertIn("did not answer within", said["error"])
        status, said = self.chat()
        self.assertEqual(status, 504)
        self.assertEqual(said["error"]["code"], 504)
        self.engine.hold.set()
        self.waits.until(lambda: len(self.engine.hung_up) >= 2, "the held decisions to end")
        self.assertEqual(self.engine.hung_up, [True, True])

    def test_a_caller_that_hangs_up_has_the_call_to_the_engine_closed_at_once(self):
        # A front that would wait thirty seconds, so only the caller's leaving can close the call.
        self.stop_front()
        self.serve(30.0)
        self.engine.until_hung_up = True
        body = json.dumps({"gate": "room-rules", "state": "x", "questions": QUESTIONS}).encode()
        caller = socket.create_connection(("127.0.0.1", int(self.url.rsplit(":", 1)[1])))
        caller.sendall(b"POST /decide HTTP/1.1\r\nHost: front\r\nContent-Type: application/json\r\n"
                       + f"Authorization: Bearer {KEY}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        self.waits.until(lambda: self.engine.asked, "the call to reach the engine")
        caller.close()
        self.waits.until(lambda: self.engine.hung_up, "the engine to hear the call end")
        self.assertEqual(self.engine.hung_up, [True])

    def test_the_models_are_the_gates_served(self):
        status, said = self.call("/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(said["data"], [{"id": "room-rules", "object": "model", "created": 0, "owned_by": "laya",
                                         "checkpoint": "checkpoints/room-rules/r/step-000044"}])

    def test_a_chat_completion_is_one_decision_of_the_gate_named_as_model(self):
        status, said = self.chat()
        self.assertEqual(status, 200)
        self.assertEqual(said["object"], "chat.completion")
        self.assertEqual(said["model"], "room-rules")
        self.assertEqual(json.loads(said["choices"][0]["message"]["content"]), ANSWER)
        self.assertEqual(self.engine.asked[-1], {"gate": "room-rules", "state": "\ub0b4\uc77c \ubc30\ud3ec\ud574\uc694", "questions": QUESTIONS})

    def test_a_chat_completion_the_front_cannot_read_is_refused_unasked(self):
        for extra, words in (({"stream": True}, "streaming"), ({"questions": {}}, "questions"),
                             ({"messages": [{"role": "system", "content": "x"}]}, "state"), ({"model": ""}, "gate")):
            status, said = self.chat(**extra)
            self.assertEqual(status, 400, extra)
            self.assertIn(words, said["error"]["message"])
        self.assertEqual(self.engine.asked, [])

    def test_a_chat_completion_keeps_the_engine_refusal(self):
        self.engine.refusal = (404, "no checkpoint here serves the gate room-rules")
        status, said = self.chat()
        self.assertEqual(status, 404)
        self.assertEqual(said["error"], {"message": "no checkpoint here serves the gate room-rules", "type": "invalid_request_error", "code": 404})

    def test_the_handshake_offers_the_two_laya_tools(self):
        status, said = self.mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                               "clientInfo": {"name": "check", "version": "1"}})
        self.assertEqual(status, 200)
        self.assertIn("tools", said["result"]["capabilities"])

        status, said = self.mcp("tools/list")
        tools = {tool["name"]: tool for tool in said["result"]["tools"]}
        self.assertEqual(set(tools), {"laya_decide", "laya_gates"})
        self.assertEqual(sorted(tools["laya_decide"]["inputSchema"]["required"]), ["gate", "questions", "state"])

    def test_a_bare_tool_call_decides(self):
        status, said = self.mcp("tools/call", {"name": "laya_decide", "arguments": {"gate": "room-rules", "state": "\ub0b4\uc77c \ubc30\ud3ec\ud574\uc694", "questions": QUESTIONS}})
        self.assertEqual(status, 200)
        self.assertFalse(said["result"]["isError"])
        self.assertEqual(json.loads(said["result"]["content"][0]["text"]), ANSWER)

        _, said = self.mcp("tools/call", {"name": "laya_gates", "arguments": {}})
        self.assertEqual(json.loads(said["result"]["content"][0]["text"]), {"room-rules": "checkpoints/room-rules/r/step-000044"})

    def test_a_refused_tool_call_is_an_error_carrying_the_status(self):
        self.engine.refusal = (400, "question q has no instructions")
        _, said = self.mcp("tools/call", {"name": "laya_decide", "arguments": {"gate": "room-rules", "state": "x", "questions": QUESTIONS}})
        self.assertTrue(said["result"]["isError"])
        self.assertIn("400: question q has no instructions", said["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
