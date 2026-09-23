"""The house LLM service's front (docs/llm-server.md): one process on the loopback, the only port that
leaves the machine. It carries vLLM's OpenAI-compatible API through unchanged, speaks MCP over
Streamable HTTP with the one tool BMO's gates ask, and checks the service key on everything but its
health.

Run: LLM_KEY and VLLM_API_KEY come from the unit's environment file; python front.py
"""

from __future__ import annotations

import hmac
import os
from typing import Any

import httpx
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send

HOST = "127.0.0.1"
PORT = int(os.environ.get("LLM_PORT", "8010"))
UPSTREAM = os.environ.get("LLM_UPSTREAM", "http://127.0.0.1:8000")

# The paths that answer without the key: whether the service stands, and nothing else.
OPEN_PATHS = frozenset({"/health"})

# Headers that belong to one hop and never cross the front, and the ones the front sets itself.
HOP_HEADERS = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "host", "content-length", "authorization",
})

# How long a model call may take. The caller holds its own deadline and gives up first; this only
# keeps a request the caller walked away from from being held for ever.
QUERY_TIMEOUT_S = 600.0
HEALTH_TIMEOUT_S = 5.0
DEFAULT_ANSWER_TOKENS = 1024


class KeyGate:
    """Every request but the open paths carries the service key as a bearer token. A refusal is a
    bare 401 that repeats nothing of what was sent."""

    def __init__(self, app: ASGIApp, key: str) -> None:
        self.app = app
        self.key = key.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in OPEN_PATHS:
            await self.app(scope, receive, send)
            return

        given = b""
        for name, value in scope["headers"]:
            if name == b"authorization":
                given = value
                break

        if not hmac.compare_digest(given, b"Bearer " + self.key):
            await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
            return

        await self.app(scope, receive, send)


def carried(headers: httpx.Headers | Any) -> dict[str, str]:
    return {name: value for name, value in headers.items() if name.lower() not in HOP_HEADERS}


def build_app(key: str, upstream: str = UPSTREAM, upstream_key: str | None = None) -> ASGIApp:
    """The whole front as one ASGI app, so a test serves exactly what the unit serves."""
    upstream_auth = {"authorization": f"Bearer {upstream_key or key}"}
    client = httpx.AsyncClient(base_url=upstream, timeout=httpx.Timeout(QUERY_TIMEOUT_S, connect=HEALTH_TIMEOUT_S))
    served: list[str] = []

    async def served_model() -> str:
        # vLLM serves one model under one name; it is read from the catalogue once and kept.
        if not served:
            listing = await client.get("/v1/models", headers=upstream_auth, timeout=HEALTH_TIMEOUT_S)
            listing.raise_for_status()
            served.append(listing.json()["data"][0]["id"])
        return served[0]

    server = MCPServer("bmo-llm", log_level="WARNING")

    @server.tool(
        description="Ask the served model one question and get its answer as text. No model is named: the service serves one.",
        structured_output=False,
    )
    async def llm_query(prompt: str, system: str = "", max_tokens: int = DEFAULT_ANSWER_TOKENS) -> str:
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
        try:
            body = {
                "model": await served_model(),
                "messages": messages,
                "max_tokens": max_tokens,
                "stream": False,
                "chat_template_kwargs": {"enable_thinking": False},
            }
            answered = await client.post("/v1/chat/completions", json=body, headers=upstream_auth)
        except httpx.HTTPError as error:
            raise ToolError(f"the model did not answer ({type(error).__name__})") from None

        # A request too large for the model's context comes back as 400; that wording is what the
        # caller reads as "too large". Nothing of the upstream body is passed on.
        if answered.status_code == 400:
            raise ToolError("the model refused the request: 400 Bad Request")
        if answered.status_code != 200:
            raise ToolError(f"the model did not answer ({answered.status_code})")

        try:
            text = answered.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise ToolError("the model's answer could not be read") from None
        if not isinstance(text, str) or text.strip() == "":
            raise ToolError("the model answered nothing")

        return text

    @server.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> Response:
        try:
            standing = await client.get("/health", timeout=HEALTH_TIMEOUT_S)
        except httpx.HTTPError:
            return JSONResponse({"status": "down"}, status_code=503)
        return JSONResponse({"status": "ok"} if standing.status_code == 200 else {"status": "down"},
                            status_code=200 if standing.status_code == 200 else 503)

    async def passed_through(request: Request) -> Response:
        outgoing = client.build_request(
            request.method, request.url.path, params=request.query_params,
            headers={**carried(request.headers), **upstream_auth}, content=await request.body(),
        )
        try:
            answer = await client.send(outgoing, stream=True)
        except httpx.HTTPError:
            return JSONResponse({"error": "upstream unavailable"}, status_code=502)

        return StreamingResponse(answer.aiter_raw(), status_code=answer.status_code,
                                 headers=carried(answer.headers), background=BackgroundTask(answer.aclose))

    server.custom_route("/v1/models", methods=["GET"])(passed_through)
    server.custom_route("/v1/chat/completions", methods=["POST"])(passed_through)

    app = server.streamable_http_app(json_response=True, stateless_http=True, host=HOST)
    return KeyGate(app, key)


def main() -> None:
    key = os.environ.get("LLM_KEY", "")
    if key == "":
        raise SystemExit("LLM_KEY is not set; the unit reads it from its environment file")

    # No access log: a line per request would carry nothing useful and is where a header could leak.
    uvicorn.run(build_app(key, UPSTREAM, os.environ.get("VLLM_API_KEY")), host=HOST, port=PORT,
                log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
