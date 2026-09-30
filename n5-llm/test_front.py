"""The n5 front's contract against a stand-in engine it starts and stops itself:
uv run --no-project --with httpx --with starlette --with uvicorn python3 -m unittest n5-llm/test_front.py"""

from __future__ import annotations

import fcntl
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import uvicorn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from front import Engine, build_app

KEY = "front-key-5c1d8e"

# The engine as the front sees it: a health that answers once it stands, and completions, whole or
# streamed, held as long as the request asks. Every start is written down; a card without room is an
# exit with the engine's own out-of-memory line.
STAND_IN = r"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port, starts, mode = int(sys.argv[1]), sys.argv[2], sys.argv[3]
if mode == "oom":
    print("ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory", file=sys.stderr, flush=True)
    sys.exit(1)
with open(starts, "a") as f:
    f.write("start\n")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        data = b'{"status":"ok"}'
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        asked = json.loads(self.rfile.read(int(self.headers["content-length"])))
        time.sleep(asked.get("delay", 0))
        if asked.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for i in range(asked.get("chunks", 3)):
                self.wfile.write(("data: " + json.dumps({"i": i}) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(asked.get("gap", 0))
            self.wfile.write(b"data: [DONE]\n\n")
            return
        data = json.dumps({"path": self.path, "choices": [{"message": {"content": "ok"}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
"""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class FrontTest(unittest.TestCase):
    mode = "ok"

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="n5-front-"))
        self.lock = self.dir / "gpu.lock"
        self.starts = self.dir / "starts"
        self.starts.write_text("")
        engine_port = free_port()
        argv = [sys.executable, "-c", STAND_IN, str(engine_port), str(self.starts), self.mode]
        self.engine = Engine(argv, self.lock, f"http://127.0.0.1:{engine_port}/health", lock_wait_s=0.2, start_wait_s=10)
        model = self.dir / "model.gguf"
        model.write_bytes(b"GGUF")
        app = build_app(KEY, self.engine, f"http://127.0.0.1:{engine_port}", model, None, {"context": 4096})
        self.port = free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="error"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        self.until(lambda: self.server.started)

    def tearDown(self) -> None:
        self.server.should_exit = True
        self.thread.join(10)
        # The front's shutdown stops the engine; one it left standing is taken down here all the same.
        if self.engine.proc is not None and self.engine.proc.returncode is None:
            self.engine.proc.kill()

    def until(self, condition, seconds: float = 10.0) -> None:
        deadline = time.monotonic() + seconds
        while not condition():
            if time.monotonic() > deadline:
                self.fail("the condition did not come to hold")
            time.sleep(0.02)

    def call(self, path: str, body: dict | None = None, key: str | None = KEY) -> tuple[int, bytes]:
        headers = {"content-type": "application/json"}
        if key is not None:
            headers["authorization"] = f"Bearer {key}"
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as answer:
                return answer.status, answer.read()
        except urllib.error.HTTPError as refused:
            return refused.code, refused.read()

    def health(self) -> dict:
        return json.loads(self.call("/health")[1])

    def started(self) -> int:
        return len(self.starts.read_text().splitlines())

    def lock_is_free(self) -> bool:
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
        finally:
            os.close(fd)


class TheKey(FrontTest):
    def test_only_the_bare_health_answers_without_it(self) -> None:
        self.assertEqual(self.call("/health", key=None), (200, b'{"status":"ok"}'))
        self.assertEqual(self.call("/v1/models", key=None)[0], 401)
        self.assertEqual(self.call("/v1/chat/completions", {"messages": []}, key="wrong")[0], 401)
        self.assertEqual(self.started(), 0)

    def test_the_model_list_does_not_start_the_engine(self) -> None:
        status, body = self.call("/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual([model["id"] for model in json.loads(body)["data"]], ["model"])
        self.assertEqual(self.started(), 0)


class TheCard(FrontTest):
    def test_a_request_starts_the_engine_and_its_end_stops_it(self) -> None:
        self.assertTrue(self.lock_is_free())
        status, body = self.call("/v1/chat/completions", {"messages": [{"role": "user", "content": "안녕"}]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/v1/chat/completions")
        self.assertEqual(self.started(), 1)
        health = self.health()
        self.assertEqual((health["engine"], health["in_hand"], health["lock_held"]), ("stopped", 0, False))
        self.assertIsNotNone(health["last_start_ms"])
        self.assertTrue(self.lock_is_free())

    def test_the_lock_is_held_while_a_request_is_in_hand(self) -> None:
        going = threading.Thread(target=self.call, args=("/v1/completions", {"prompt": "x", "delay": 0.5}))
        going.start()
        self.until(lambda: self.health()["engine"] == "running")
        self.assertFalse(self.lock_is_free())
        going.join()
        self.assertTrue(self.lock_is_free())

    def test_overlapping_requests_share_one_engine_until_the_last_ends(self) -> None:
        answers: list[int] = []
        calls = [threading.Thread(target=lambda delay=delay: answers.append(
            self.call("/v1/chat/completions", {"messages": [], "delay": delay})[0])) for delay in (0.3, 0.6)]
        for one in calls:
            one.start()
        for one in calls:
            one.join()
        self.assertEqual(answers, [200, 200])
        self.assertEqual(self.started(), 1)
        self.assertEqual(self.health()["engine"], "stopped")

    def test_a_stream_is_passed_through_and_its_end_stops_the_engine(self) -> None:
        status, body = self.call("/v1/chat/completions", {"messages": [], "stream": True, "chunks": 3})
        self.assertEqual(status, 200)
        self.assertEqual(body.decode().count("data: "), 4)
        # The request ends once its last byte has gone, which is just after the caller has it.
        self.until(lambda: self.health()["engine"] == "stopped")
        self.assertTrue(self.lock_is_free())

    def test_a_caller_that_goes_mid_stream_stops_the_engine(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        body = json.dumps({"messages": [], "stream": True, "chunks": 200, "gap": 0.05})
        connection.request("POST", "/v1/chat/completions", body, {"authorization": f"Bearer {KEY}", "content-type": "application/json"})
        answer = connection.getresponse()
        self.assertEqual(answer.status, 200)
        answer.read1(64)
        connection.sock.shutdown(socket.SHUT_RDWR)
        connection.close()
        self.until(lambda: self.health()["engine"] == "stopped")
        self.assertTrue(self.lock_is_free())

    def test_a_lock_held_elsewhere_is_a_busy_card_after_the_wait(self) -> None:
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            status, body = self.call("/v1/chat/completions", {"messages": []})
        finally:
            os.close(fd)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"]["type"], "card_busy")
        self.assertEqual(self.started(), 0)
        self.assertEqual(self.health()["engine"], "stopped")


class ACardWithoutRoom(FrontTest):
    mode = "oom"

    def test_is_a_busy_card_and_the_lock_is_let_go(self) -> None:
        status, body = self.call("/v1/chat/completions", {"messages": []})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"]["message"], "card busy: the card had no room for the model")
        health = self.health()
        self.assertEqual((health["engine"], health["in_hand"], health["lock_held"]), ("stopped", 0, False))
        self.assertTrue(self.lock_is_free())


if __name__ == "__main__":
    unittest.main()
