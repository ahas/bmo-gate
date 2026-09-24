"""The Laya service's front (docs/llm-server.md): one process on the loopback, the only port that leaves
the machine. It carries BMO's own /decide call through to the Laya engine unchanged, answers the same
decisions as an OpenAI-compatible API and over MCP, and checks the service key on everything but the
bare health.

Run: LLM_KEY and LAYA_TOKEN come from the unit's environment file; python front.py
"""

from __future__ import annotations

import hmac
import json
import os
import time
import uuid
from typing import Any

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

HOST = "127.0.0.1"
PORT = int(os.environ.get("LLM_PORT", "8010"))
UPSTREAM = os.environ.get("LAYA_UPSTREAM", "http://127.0.0.1:7431")

# The one path that answers without the key: whether the service stands, and nothing else.
OPEN_PATHS = frozenset({"/health"})

# A decision of the most questions one call carries takes a fraction of a second. This only keeps a
# call the engine holds without answering from being held for ever.
DECIDE_TIMEOUT_S = 30.0
HEALTH_TIMEOUT_S = 5.0
MAX_BODY_BYTES = 1 << 20


def bearer(headers: Any) -> bytes:
    for name, value in headers:
        if name == b"authorization":
            return value
    return b""


class KeyGate:
    """Every request but the open path carries the service key as a bearer token. A refusal is a bare
    401 that repeats nothing of what was sent."""

    def __init__(self, app: ASGIApp, key: str) -> None:
        self.app = app
        self.expected = b"Bearer " + key.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in OPEN_PATHS or hmac.compare_digest(bearer(scope["headers"]), self.expected):
            await self.app(scope, receive, send)
            return
        await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)


class EngineRefused(Exception):
    """The engine's own refusal of a decision, with its status and its reason."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def build_app(key: str, upstream: str = UPSTREAM, upstream_key: str | None = None) -> ASGIApp:
    """The whole front as one ASGI app, so a test serves exactly what the unit serves."""
    upstream_auth = {"authorization": f"Bearer {upstream_key or key}"}
    expected = f"Bearer {key}".encode()
    client = httpx.AsyncClient(base_url=upstream, timeout=httpx.Timeout(DECIDE_TIMEOUT_S, connect=HEALTH_TIMEOUT_S))

    async def engine(method: str, path: str, body: bytes | None = None) -> httpx.Response | None:
        """The engine's answer, or None where it did not give one: stopped, restarting or still loading."""
        try:
            return await client.request(method, path, content=body, headers={**upstream_auth, "content-type": "application/json"},
                                        timeout=HEALTH_TIMEOUT_S if path == "/health" else DECIDE_TIMEOUT_S)
        except httpx.HTTPError:
            return None

    async def decide(gate: str, state: Any, questions: Any) -> dict[str, Any]:
        answered = await engine("POST", "/decide", json.dumps({"gate": gate, "state": state, "questions": questions}).encode())
        if answered is None:
            raise EngineRefused(503, "laya is not answering")
        try:
            said = answered.json()
        except ValueError:
            said = None
        if answered.status_code != 200:
            reason = said.get("error") if isinstance(said, dict) and isinstance(said.get("error"), str) else "laya refused the call"
            raise EngineRefused(answered.status_code, reason)
        if not isinstance(said, dict):
            raise EngineRefused(502, "laya's answer could not be read")
        return said

    async def gates() -> dict[str, str]:
        """The gates the engine serves, each with the checkpoint that answers it."""
        answered = await engine("GET", "/health")
        if answered is None or answered.status_code != 200:
            raise EngineRefused(503, "laya is not answering")
        served = answered.json().get("gates") or {}
        return {gate: described.get("model", "") for gate, described in served.items()}

    server = MCPServer("bmo-laya", log_level="WARNING")

    @server.tool(
        description="Ask Laya one decision: the gate's own checkpoint answers each named question about the state "
                    "with its probabilities, chosen option and confidence. Questions are {id: {type: noul|choice|score, "
                    "instructions, criteria}}. laya_gates lists the gates.",
        structured_output=False,
    )
    async def laya_decide(gate: str, state: str | dict[str, Any] | list[Any], questions: dict[str, dict[str, Any]]) -> str:
        try:
            return json.dumps(await decide(gate, state, questions), ensure_ascii=False)
        except EngineRefused as refusal:
            raise ToolError(f"{refusal.status}: {refusal.reason}") from None

    @server.tool(description="The gates Laya serves here, each with the checkpoint that answers it.", structured_output=False)
    async def laya_gates() -> str:
        try:
            return json.dumps(await gates(), ensure_ascii=False)
        except EngineRefused as refusal:
            raise ToolError(f"{refusal.status}: {refusal.reason}") from None

    @server.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> Response:
        answered = await engine("GET", "/health")
        if answered is None or answered.status_code != 200:
            return JSONResponse({"status": "down"}, status_code=503)
        # The key holder is given the engine's own health; anybody else only whether it stands.
        if hmac.compare_digest(bearer(request.scope["headers"]), expected):
            return Response(answered.content, status_code=200, media_type="application/json")
        return JSONResponse({"status": "ok"})

    @server.custom_route("/decide", methods=["POST"])
    async def decide_through(request: Request) -> Response:
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            return JSONResponse({"error": f"the body must be 1 to {MAX_BODY_BYTES} bytes"}, status_code=400)
        answered = await engine("POST", "/decide", body)
        if answered is None:
            return JSONResponse({"error": "laya is not answering"}, status_code=503)
        return Response(answered.content, status_code=answered.status_code, media_type="application/json")

    @server.custom_route("/v1/models", methods=["GET"])
    async def models(request: Request) -> Response:
        try:
            served = await gates()
        except EngineRefused as refusal:
            return openai_error(refusal.status, refusal.reason)
        return JSONResponse({"object": "list", "data": [
            {"id": gate, "object": "model", "created": 0, "owned_by": "laya", "checkpoint": checkpoint}
            for gate, checkpoint in served.items()
        ]})

    @server.custom_route("/v1/chat/completions", methods=["POST"])
    async def completions(request: Request) -> Response:
        try:
            body = json.loads(await request.body())
        except ValueError:
            return openai_error(400, "the body is not JSON")
        if not isinstance(body, dict):
            return openai_error(400, "the body is not an object")
        if body.get("stream"):
            return openai_error(400, "streaming is not offered: a decision is one answer made at once")
        gate = body.get("model")
        state = last_user_text(body.get("messages"))
        if not isinstance(gate, str) or gate == "":
            return openai_error(400, "model must name the gate asking")
        if state is None:
            return openai_error(400, "the last user message is the state, and there is none")
        if not isinstance(body.get("questions"), dict) or not body["questions"]:
            return openai_error(400, "questions must name the questions to decide, as /decide takes them")
        try:
            said = await decide(gate, state, body["questions"])
        except EngineRefused as refusal:
            return openai_error(refusal.status, refusal.reason)
        return JSONResponse({
            "id": f"laya-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": gate,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": json.dumps(said, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    app = server.streamable_http_app(json_response=True, stateless_http=True, host=HOST)
    return KeyGate(app, key)


def last_user_text(messages: Any) -> str | None:
    """The state a chat call carries: its last user message, as text."""
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
        return content if isinstance(content, str) and content.strip() else None
    return None


def openai_error(status: int, message: str) -> JSONResponse:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return JSONResponse({"error": {"message": message, "type": kind, "code": status}}, status_code=status)


def main() -> None:
    key = os.environ.get("LLM_KEY", "")
    if key == "":
        raise SystemExit("LLM_KEY is not set; the unit reads it from its environment file")

    # No access log: a line per request would carry nothing useful and is where a header could leak.
    uvicorn.run(build_app(key, UPSTREAM, os.environ.get("LAYA_TOKEN")), host=HOST, port=PORT,
                log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
