"""The Laya decision server: one loaded Laya checkpoint behind two HTTP calls.

GET /health answers what is loaded and where; POST /decide takes {"state", "questions"} and
answers with Laya's own answer for each question. Every call carries the bearer token kept in
the token file. docs/laya-server.md is the whole account of it.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional

# Set before torch or transformers is first imported, whoever imports this module: USE_TF is the
# model card's cure for a load that hangs.
os.environ.setdefault("USE_TF", "0")

HUB_REPO = "convaiinnovations/laya"
HUB_SUBFOLDER = "multilingual"
QUESTION_TYPES = ("choice", "score", "noul")
MAX_BODY_BYTES = 1 << 20
MAX_QUESTIONS = 128
WARM_STATE = "내일 배포 일정을 다시 잡아 주세요."
WARM_QUESTIONS = {"warm": {"type": "noul", "instructions": "이 메시지는 일정 변경 요청인가?"}}


class Refused(Exception):
    """A request the server will not answer, with the reason it says back."""


def read_token(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        raise SystemExit(f"laya-server: the token file {path} is empty")
    return token


def check_request(body: Any) -> tuple[Any, Dict[str, Dict[str, Any]]]:
    """The state and questions of a /decide body, or Refused saying what is wrong with it."""
    if not isinstance(body, dict):
        raise Refused("the body is not an object")
    state = body.get("state")
    questions = body.get("questions")
    if not isinstance(state, (str, dict, list)) or state in ("", {}, []):
        raise Refused("state must be a non-empty string, object or list")
    if not isinstance(questions, dict) or not questions:
        raise Refused("questions must be a non-empty object")
    if len(questions) > MAX_QUESTIONS:
        raise Refused(f"at most {MAX_QUESTIONS} questions per call")
    for qid, question in questions.items():
        if not isinstance(question, dict):
            raise Refused(f"question {qid} is not an object")
        if question.get("type") not in QUESTION_TYPES:
            raise Refused(f"question {qid} has no type among {', '.join(QUESTION_TYPES)}")
        if not isinstance(question.get("instructions"), str) or not question["instructions"].strip():
            raise Refused(f"question {qid} has no instructions")
        criteria = question.get("criteria")
        if question["type"] == "choice" and not (isinstance(criteria, (dict, list)) and len(criteria) >= 2):
            raise Refused(f"question {qid} is a choice with fewer than two options")
        if question["type"] == "score" and not (isinstance(criteria, list) and len(criteria) >= 2):
            raise Refused(f"question {qid} is a score with fewer than two levels")
    return state, questions


class Decider:
    """The loaded checkpoint and what /health says about it. One forward pass at a time."""

    def __init__(self, agent: Any, source: str, load_ms: int, versions: Dict[str, str],
                 vram: Callable[[], Optional[int]]):
        self.agent = agent
        self.source = source
        self.load_ms = load_ms
        self.versions = versions
        self.vram = vram
        self.lock = threading.Lock()

    def decide(self, state: Any, questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        started = time.perf_counter()
        with self.lock:
            try:
                result = self.agent.predict(state, questions)
            except ValueError as error:
                # Laya's own refusal of a question it cannot lay out (options past its head budget).
                raise Refused(str(error)) from error
        return {**result, "ms": round((time.perf_counter() - started) * 1000, 2)}

    def health(self) -> Dict[str, Any]:
        device = str(getattr(self.agent, "device", "unknown"))
        return {
            "state": "up",
            "model": self.source,
            "device": device,
            "vramBytes": self.vram(),
            "loadMs": self.load_ms,
            "versions": self.versions,
            "temperature": getattr(self.agent, "temperature", None),
            "temperatureByOptions": getattr(self.agent, "temperature_by_options", None),
        }


def handler_for(decider: Decider, token: str):
    expected = f"Bearer {token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "bmo-laya"

        def log_message(self, fmt: str, *args: Any) -> None:
            # A line per call without a body: what was asked of which path and how it ended.
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def answer(self, status: int, payload: Dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorised(self) -> bool:
            given = (self.headers.get("Authorization") or "").encode()
            if hmac.compare_digest(given, expected):
                return True
            self.answer(HTTPStatus.UNAUTHORIZED, {"error": "unauthorised"})
            return False

        def do_GET(self) -> None:
            if not self.authorised():
                return
            if self.path != "/health":
                self.answer(HTTPStatus.NOT_FOUND, {"error": "no such path"})
                return
            self.answer(HTTPStatus.OK, decider.health())

        def do_POST(self) -> None:
            if not self.authorised():
                return
            if self.path != "/decide":
                self.answer(HTTPStatus.NOT_FOUND, {"error": "no such path"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise Refused(f"the body must be 1 to {MAX_BODY_BYTES} bytes")
                try:
                    body = json.loads(self.rfile.read(length))
                except json.JSONDecodeError as error:
                    raise Refused("the body is not JSON") from error
                state, questions = check_request(body)
                self.answer(HTTPStatus.OK, decider.decide(state, questions))
            except Refused as error:
                self.answer(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - the process stays up for the next call
                sys.stderr.write(f"decide failed: {type(error).__name__}: {str(error)[:300]}\n")
                self.answer(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": type(error).__name__})

    return Handler


def load_decider() -> Decider:
    import laya
    import torch
    import transformers

    checkpoint = os.environ.get("LAYA_CHECKPOINT", "").strip()
    started = time.perf_counter()
    if checkpoint:
        agent = laya.load(checkpoint, device="cuda")
        source = checkpoint
    else:
        agent = laya.load(HUB_REPO, device="cuda", subfolder=HUB_SUBFOLDER)
        source = f"{HUB_REPO}/{HUB_SUBFOLDER}"
    load_ms = round((time.perf_counter() - started) * 1000)
    # One decision before the port opens: a server that answers /health can also decide, and a
    # checkpoint that cannot run a forward pass stops the unit instead of failing every call.
    agent.predict(WARM_STATE, WARM_QUESTIONS)

    def vram() -> Optional[int]:
        return int(torch.cuda.memory_reserved()) if torch.cuda.is_available() else None

    versions = {"laya": laya.__version__, "torch": torch.__version__, "transformers": transformers.__version__}
    return Decider(agent, source, load_ms, versions, vram)


def main() -> None:
    token_path = os.environ.get("LAYA_TOKEN_FILE") or os.path.expanduser("~/.config/bmo-laya/token")
    host = os.environ.get("LAYA_HOST", "0.0.0.0")
    port = int(os.environ.get("LAYA_PORT", "7431"))
    token = read_token(token_path)
    decider = load_decider()
    sys.stderr.write(f"laya-server: {decider.source} on {decider.health()['device']} in {decider.load_ms} ms\n")
    ThreadingHTTPServer((host, port), handler_for(decider, token)).serve_forever()


if __name__ == "__main__":
    main()
