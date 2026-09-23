"""The front's contract against a stand-in vLLM:
uv run --no-project --with mcp --with httpx --with starlette --with uvicorn python3 -m unittest llm-server/test_front.py"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import uvicorn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from front import build_app  # noqa: E402

KEY = "front-key-7f3a9c"
UPSTREAM_KEY = "vllm-key-2b8e41"
MODEL = "qwen3.5-4b"
MCP_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
}


class StandInVllm:
    """What the front sees of vLLM: its health, its one-model catalogue and its completions. It
    records what it was asked and answers as the test sets it to."""

    def __init__(self):
        self.healthy = True
        self.completion_status = 200
        self.answer = "파란색"
        self.asked: list[dict] = []
        self.auth: list[str] = []
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, content_type="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                stand_in.auth.append(self.headers.get("authorization", ""))
                if self.path == "/health":
                    self.reply(200 if stand_in.healthy else 503, b"", "text/plain")
                elif self.path == "/v1/models":
                    self.reply(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "max_model_len": 32768}]})
                else:
                    self.reply(404, {"error": "no such path"})

            def do_POST(self):
                stand_in.auth.append(self.headers.get("authorization", ""))
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                stand_in.asked.append(body)
                if stand_in.completion_status != 200:
                    self.reply(stand_in.completion_status, {"error": {"message": "the upstream's own words, never to be passed on"}})
                elif body.get("stream"):
                    chunks = b"".join(f"data: {json.dumps({'choices': [{'delta': {'content': part}}]})}\n\n".encode()
                                      for part in ("파", "란색"))
                    self.reply(200, chunks + b"data: [DONE]\n\n", "text/event-stream")
                else:
                    self.reply(200, {"choices": [{"message": {"role": "assistant", "content": stand_in.answer}}]})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class FrontTest(unittest.TestCase):
    def setUp(self):
        self.vllm = StandInVllm()
        port = free_port()
        config = uvicorn.Config(build_app(KEY, self.vllm.url, UPSTREAM_KEY), host="127.0.0.1", port=port,
                                log_level="warning", access_log=False)
        self.front = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.front.run, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.front.started:
            if time.monotonic() > deadline:
                self.fail("the front did not start")
            time.sleep(0.02)
        self.url = f"http://127.0.0.1:{port}"
        self.bodies: list[str] = []

    def tearDown(self):
        self.front.should_exit = True
        self.thread.join(5)
        self.vllm.close()
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
                status, text, kind = response.status, response.read().decode(), response.headers.get("content-type", "")
        except urllib.error.HTTPError as error:
            status, text, kind = error.code, error.read().decode(), error.headers.get("content-type", "")
        self.bodies.append(text)
        return status, text, kind

    def mcp(self, method, params=None, key=KEY):
        status, text, _ = self.call("/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                                    key=key, headers=MCP_HEADERS)
        return status, (json.loads(text) if text else None)

    def query(self, arguments):
        return self.mcp("tools/call", {"name": "llm_query", "arguments": arguments})

    def test_health_is_open_and_says_whether_vllm_stands(self):
        self.assertEqual(self.call("/health", key=None)[0], 200)
        self.vllm.healthy = False
        self.assertEqual(self.call("/health", key=None)[0], 503)

    def test_health_is_down_when_vllm_is_not_there(self):
        self.vllm.close()
        self.assertEqual(self.call("/health", key=None)[0], 503)
        self.vllm = StandInVllm()

    def test_everything_else_needs_the_key(self):
        for path, body in (("/v1/models", None), ("/v1/chat/completions", {"model": MODEL, "messages": []}), ("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})):
            for key in (None, "wrong"):
                status, text, _ = self.call(path, body, key=key)
                self.assertEqual(status, 401, path)
                self.assertNotIn("wrong", text)
        self.assertEqual(self.vllm.asked, [])

    def test_the_model_list_is_passed_through(self):
        status, text, _ = self.call("/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["data"][0], {"id": MODEL, "object": "model", "max_model_len": 32768})
        self.assertEqual(self.vllm.auth[-1], f"Bearer {UPSTREAM_KEY}")

    def test_completions_are_passed_through_and_stream_when_asked(self):
        body = {"model": MODEL, "messages": [{"role": "user", "content": "하늘?"}], "chat_template_kwargs": {"enable_thinking": True}}
        status, text, _ = self.call("/v1/chat/completions", body)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["choices"][0]["message"]["content"], "파란색")
        self.assertEqual(self.vllm.asked[-1]["chat_template_kwargs"], {"enable_thinking": True})

        status, text, kind = self.call("/v1/chat/completions", {**body, "stream": True})
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", kind)
        self.assertTrue(text.rstrip().endswith("data: [DONE]"))

    def test_the_handshake_offers_llm_query_alone(self):
        status, answer = self.mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                 "clientInfo": {"name": "check", "version": "1"}})
        self.assertEqual(status, 200)
        self.assertEqual(answer["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", answer["result"]["capabilities"])

        status, answer = self.mcp("tools/list")
        self.assertEqual(status, 200)
        tools = answer["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["llm_query"])
        schema = tools[0]["inputSchema"]
        self.assertEqual(set(schema["properties"]), {"prompt", "system", "max_tokens"})
        self.assertEqual(schema["required"], ["prompt"])

    def test_a_bare_tool_call_is_answered_with_thinking_off(self):
        status, answer = self.query({"system": "한 단어로 답해", "prompt": "하늘의 색은?", "max_tokens": 16})
        self.assertEqual(status, 200)
        self.assertEqual(answer["id"], 1)
        self.assertFalse(answer["result"]["isError"])
        self.assertEqual(answer["result"]["content"], [{"type": "text", "text": "파란색"}])

        sent = self.vllm.asked[-1]
        self.assertEqual(sent["model"], MODEL)
        self.assertEqual(sent["max_tokens"], 16)
        self.assertEqual(sent["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(sent["messages"], [{"role": "system", "content": "한 단어로 답해"}, {"role": "user", "content": "하늘의 색은?"}])
        self.assertEqual(self.vllm.auth[-1], f"Bearer {UPSTREAM_KEY}")

    def test_a_request_too_large_says_400_bad_request(self):
        self.vllm.completion_status = 400
        _, answer = self.query({"prompt": "너무 긴 글"})
        self.assertTrue(answer["result"]["isError"])
        text = answer["result"]["content"][0]["text"]
        self.assertIn("400 Bad Request", text)
        self.assertNotIn("the upstream's own words", text)

    def test_any_other_failure_carries_no_upstream_body(self):
        self.vllm.completion_status = 500
        _, answer = self.query({"prompt": "무엇이든"})
        self.assertTrue(answer["result"]["isError"])
        text = answer["result"]["content"][0]["text"]
        self.assertNotIn("the upstream's own words", text)
        self.assertNotIn("400 Bad Request", text)

    def test_an_empty_answer_is_an_error(self):
        self.vllm.answer = "  "
        _, answer = self.query({"prompt": "무엇이든"})
        self.assertTrue(answer["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
