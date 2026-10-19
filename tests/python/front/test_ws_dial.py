"""The tunnel's ProxyCommand, driven as ssh drives it: bytes in on stdin, bytes out on stdout, through
a stand-in of the door that asks for the bearer and echoes what it is sent.

Run run by tests/python.rs.
"""

import os
import subprocess
import sys
import threading
import unittest
from http import HTTPStatus

from websockets.sync.server import serve

HERE = os.path.dirname(os.path.abspath(__file__))
DIAL = os.path.join(HERE, "..", "..", "..", "runtime", "front", "ws-dial.py")
KEY = "k" * 64


class WsDialTest(unittest.TestCase):
    def setUp(self) -> None:
        self.seen_bearer: list[str | None] = []

        def process_request(connection, request):
            bearer = request.headers.get("Authorization")
            self.seen_bearer.append(bearer)
            if bearer != f"Bearer {KEY}":
                return connection.respond(HTTPStatus.UNAUTHORIZED, "unauthorized\n")
            return None

        def echo(websocket):
            for message in websocket:
                websocket.send(message)

        self.server = serve(echo, "127.0.0.1", 0, process_request=process_request)
        self.url = f"ws://127.0.0.1:{self.server.socket.getsockname()[1]}/"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()

    def dial(self, key: str | None, stdin: bytes) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k != "LLM_KEY"}
        if key is not None:
            env["LLM_KEY"] = key
        return subprocess.run([sys.executable, DIAL, self.url], input=stdin, env=env, capture_output=True, timeout=20)

    def test_carries_bytes_both_ways_with_the_key_as_bearer(self) -> None:
        # Standing input is closed only once the echo is back, as ssh keeps it open while it talks: the end of
        # input closes the socket, and closing it with the bytes still under way would race the echo.
        line = b"SSH-2.0-check\r\n"
        env = {**{k: v for k, v in os.environ.items() if k != "LLM_KEY"}, "LLM_KEY": KEY}
        with subprocess.Popen([sys.executable, DIAL, self.url], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env) as dialed:
            dialed.stdin.write(line)
            dialed.stdin.flush()
            echoed = dialed.stdout.read(len(line))
            dialed.stdin.close()
            code = dialed.wait(timeout=20)
        self.assertEqual(code, 0)
        self.assertEqual(echoed, line)
        self.assertEqual(self.seen_bearer, [f"Bearer {KEY}"])

    def test_a_refused_door_ends_it_and_the_key_is_never_said(self) -> None:
        done = self.dial("w" * 64, b"hello")
        self.assertEqual(done.returncode, 1)
        self.assertNotIn(b"w" * 64, done.stderr + done.stdout)

    def test_no_key_is_refused_before_anything_is_opened(self) -> None:
        done = self.dial(None, b"")
        self.assertEqual(done.returncode, 2)
        self.assertEqual(self.seen_bearer, [])


if __name__ == "__main__":
    unittest.main()
