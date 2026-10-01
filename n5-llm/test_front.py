"""The head's front's contract against a stand-in engine it starts and stops itself, and a card holder
with a stand-in rpc-server:
uv run --no-project --with httpx --with starlette --with uvicorn python3 -m unittest n5-llm/test_front.py"""

from __future__ import annotations

import asyncio
import fcntl
import http.client
import json
import os
import socket
import struct
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

from card import Card
from front import BorrowedCards, Engine, SlotStore, build_app, held_tokens

KEY = "front-key-5c1d8e"

# The engine as the front sees it: a health that answers once it stands, completions, whole or
# streamed, held as long as the request asks, and the one slot, whose tokens are a prompt's characters
# and whose file is llama.cpp's head over a stand-in state. Every start and every load is written down;
# a card without room is an exit with the engine's own out-of-memory line.
STAND_IN = r"""
import json, os, struct, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port, starts, mode, slots, loads = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
slot = []
def render(asked):
    return "".join(f"<{m['role']}>{m['content']}" for m in asked.get("messages", [])) + "<assistant>"
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
    def answer(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        global slot
        asked = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/apply-template":
            return self.answer({"prompt": render(asked)})
        if self.path == "/tokenize":
            return self.answer({"tokens": [ord(c) for c in asked["content"]]})
        if self.path == "/completion":
            slot = asked["prompt"]
            return self.answer({"content": ""})
        if self.path == "/slots/0?action=save":
            with open(os.path.join(slots, asked["filename"]), "wb") as f:
                f.write(struct.pack("<III", 0x67677371, 2, len(slot) + 4)
                        + struct.pack(f"<iII{len(slot)}iI", -1, 1, len(slot), *slot, 0) + b"state")
            return self.answer({"n_saved": len(slot), "n_written": 4 * len(slot) + 32, "timings": {"save_ms": 1.0}})
        if self.path == "/slots/0?action=restore":
            with open(os.path.join(slots, asked["filename"]), "rb") as f:
                head = f.read()
            count = struct.unpack("<I", head[20:24])[0]
            slot = list(struct.unpack(f"<{count}i", head[24:24 + 4 * count]))
            with open(loads, "a") as f:
                f.write(asked["filename"] + "\n")
            return self.answer({"n_restored": count, "n_read": len(head), "timings": {"restore_ms": 1.0}})
        # An answer leaves its prompt and two tokens of its own in the slot.
        slot = [ord(c) for c in (asked["prompt"] if "prompt" in asked else render(asked))] + [7, 7]
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


# The rpc-server as a borrowed card's holder sees it: a port that accepts once it stands.
RPC_STAND_IN = r"""
import socket, sys
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(sys.argv[1])))
server.listen()
while True:
    server.accept()
"""


class BorrowedCard:
    """card.py's holder serving on the loopback in a thread of its own, with a stand-in rpc-server."""

    def __init__(self, root: Path) -> None:
        self.lock = root / "card.lock"
        self.pieces = root / "pieces"
        self.pieces.mkdir()
        self.port = free_port()
        self.rpc_port = free_port()
        self.card = Card(KEY, "127.0.0.1", self.lock, [sys.executable, "-c", RPC_STAND_IN, str(self.rpc_port)], self.pieces,
                         lock_wait_s=0.2, start_wait_s=10, rpc_port=self.rpc_port)
        self.loop = asyncio.new_event_loop()
        self.server = self.loop.run_until_complete(asyncio.start_server(self.card.serve, "127.0.0.1", self.port))
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def rpc_stands(self) -> bool:
        try:
            socket.create_connection(("127.0.0.1", self.rpc_port), timeout=0.5).close()
            return True
        except OSError:
            return False

    def close(self) -> None:
        # A hold the front let go of at its shutdown is wound down, its rpc-server with it, before the
        # loop goes.
        deadline = time.monotonic() + 10
        while self.card.held and time.monotonic() < deadline:
            time.sleep(0.02)
        self.loop.call_soon_threadsafe(self.server.close)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)


class FrontTest(unittest.TestCase):
    mode = "ok"
    idle_s = 0.0
    borrows = False

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="n5-front-"))
        self.lock = self.dir / "gpu.lock"
        self.starts = self.dir / "starts"
        self.starts.write_text("")
        self.slots = self.dir / "slots"
        self.slots.mkdir()
        self.loads = self.dir / "loads"
        self.loads.write_text("")
        engine_port = free_port()
        upstream = f"http://127.0.0.1:{engine_port}"
        argv = [sys.executable, "-c", STAND_IN, str(engine_port), str(self.starts), self.mode, str(self.slots), str(self.loads)]
        self.card = BorrowedCard(self.dir) if self.borrows else None
        cards = BorrowedCards(["127.0.0.1"], KEY, hold_wait_s=5, port=self.card.port) if self.card else None
        self.engine = Engine(argv, self.lock, f"{upstream}/health", lock_wait_s=0.2, start_wait_s=10,
                             slots=SlotStore(self.slots, upstream, drop=cards.drop if cards else None), cards=cards, idle_s=self.idle_s)
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
        if self.card is not None:
            self.card.close()

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

    def lock_is_free(self, lock: Path | None = None) -> bool:
        fd = os.open(lock or self.lock, os.O_RDWR | os.O_CREAT)
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


def rendered(messages: list[dict]) -> list[int]:
    return [ord(c) for c in "".join(f"<{m['role']}>{m['content']}" for m in messages) + "<assistant>"]


class TheSlot(FrontTest):
    first = [{"role": "system", "content": "창고 규칙"}, {"role": "user", "content": "상자 12는?"}]

    def saved(self) -> list[list[int]]:
        return sorted([list(struct.unpack(f"<{len(held) // 4}i", held)) for held in map(held_tokens, self.slots.glob("*.bin"))])

    def loaded(self) -> list[str]:
        return self.loads.read_text().splitlines()

    def test_a_conversation_goes_on_from_its_saved_state_and_keeps_one_file(self) -> None:
        self.assertEqual(self.call("/v1/chat/completions", {"messages": self.first})[0], 200)
        self.assertEqual(self.saved(), [rendered(self.first)[:-3]])
        first_file = [file.name for file in self.slots.glob("*.bin")]

        after = [*self.first, {"role": "assistant", "content": "40개"}, {"role": "user", "content": "13은?"}]
        self.assertEqual(self.call("/v1/chat/completions", {"messages": after})[0], 200)
        self.assertEqual(self.loaded(), first_file)
        self.assertEqual(self.saved(), [rendered(after)[:-3]])
        health = self.health()
        self.assertEqual((health["engine"], health["slots"]["files"], health["slots"]["last_restore"]["tokens"]),
                         ("stopped", 1, len(rendered(self.first)) - 3))

    def test_a_prompt_that_parts_from_every_file_starts_empty(self) -> None:
        other = [self.first[0], {"role": "user", "content": "창고 5는?"}]
        self.call("/v1/chat/completions", {"messages": self.first})
        self.call("/v1/chat/completions", {"messages": other})
        self.assertEqual(self.loaded(), [])
        self.assertEqual(self.saved(), sorted([rendered(self.first)[:-3], rendered(other)[:-3]]))


class TheIdleMinute(FrontTest):
    idle_s = 0.4

    def test_a_request_within_it_is_answered_on_the_same_engine_and_after_it_the_engine_goes(self) -> None:
        self.assertEqual(self.call("/v1/chat/completions", {"messages": [{"role": "user", "content": "하나"}]})[0], 200)
        self.assertEqual(self.health()["engine"], "idle")
        self.assertFalse(self.lock_is_free())
        self.assertEqual(self.call("/v1/chat/completions", {"messages": [{"role": "user", "content": "둘"}]})[0], 200)
        self.assertEqual(self.started(), 1)
        self.until(lambda: self.health()["engine"] == "stopped")
        self.assertTrue(self.lock_is_free())
        self.assertEqual(len(list(self.slots.glob("*.bin"))), 1)


class TheBorrowedCard(FrontTest):
    borrows = True

    def test_is_held_with_its_rpc_server_while_a_request_is_in_hand_and_let_go_after(self) -> None:
        going = threading.Thread(target=self.call, args=("/v1/completions", {"prompt": "x", "delay": 0.5}))
        going.start()
        self.until(lambda: self.health()["engine"] == "running")
        self.assertEqual(self.health()["cards_held"], 1)
        self.assertTrue(self.card.rpc_stands())
        self.assertFalse(self.lock_is_free(self.card.lock))
        going.join()
        self.until(lambda: not self.card.card.held)
        self.assertFalse(self.card.rpc_stands())
        self.assertTrue(self.lock_is_free(self.card.lock))
        self.assertTrue(self.lock_is_free())

    def test_whose_lock_is_held_elsewhere_is_a_busy_card_and_the_engine_never_starts(self) -> None:
        fd = os.open(self.card.lock, os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            status, body = self.call("/v1/chat/completions", {"messages": []})
        finally:
            os.close(fd)
        self.assertEqual(status, 503)
        self.assertIn("the card on 127.0.0.1", json.loads(body)["error"]["message"])
        self.assertEqual(self.started(), 0)
        self.assertTrue(self.lock_is_free())

    def test_drops_the_pieces_of_the_files_a_save_removes(self) -> None:
        first = [{"role": "user", "content": "상자 12는?"}]
        self.call("/v1/chat/completions", {"messages": first})
        [saved] = [file.name for file in self.slots.glob("*.bin")]
        for number in (0, 1):
            (self.card.pieces / f"{saved}.{number}").write_bytes(b"piece")
        (self.card.pieces / "other.bin.0").write_bytes(b"piece")
        self.call("/v1/chat/completions", {"messages": [*first, {"role": "assistant", "content": "40개"}, {"role": "user", "content": "13은?"}]})
        self.assertEqual(sorted(piece.name for piece in self.card.pieces.iterdir()), ["other.bin.0"])

    def test_refuses_a_hold_without_the_key(self) -> None:
        with socket.create_connection(("127.0.0.1", self.card.port), timeout=5) as connection:
            connection.sendall(b"HOLD wrong\n")
            self.assertEqual(connection.makefile().readline().strip(), "REFUSED")
        self.assertFalse(self.card.rpc_stands())


class ACardWithoutRoom(FrontTest):
    mode = "oom"

    def test_is_a_busy_card_and_the_lock_is_let_go(self) -> None:
        status, body = self.call("/v1/chat/completions", {"messages": []})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"]["message"], "card busy: a card had no room for its part of the model")
        health = self.health()
        self.assertEqual((health["engine"], health["in_hand"], health["lock_held"]), ("stopped", 0, False))
        self.assertTrue(self.lock_is_free())


if __name__ == "__main__":
    unittest.main()
