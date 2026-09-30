"""The text model's front on n5 (docs/n5-llm.md): one process on the loopback, the only port that
leaves the machine. It keeps the model file locked in RAM for as long as it runs, starts the engine
under the card lock when a request arrives, loads into it the saved slot state the request's prompt
goes on from, passes the request to it, and saves the slot's state, stops the engine and lets go of
the lock the moment the last request in hand ends.

Run: LLM_KEY comes from the unit's settings file; python front.py
"""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import fcntl
import hashlib
import hmac
import json
import mmap
import os
import signal
import struct
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import httpx
import uvicorn
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send

HOST = "127.0.0.1"
PORT = int(os.environ.get("N5_LLM_PORT", "8020"))
ENGINE_PORT = int(os.environ.get("N5_LLM_ENGINE_PORT", "8021"))
HOME = Path.home()
MODEL = Path(os.environ.get("N5_LLM_MODEL", str(HOME / "n5-llm/models/RVN-IQ3_XXS-multilingual-mtp.gguf")))
ENGINE_BIN = Path(os.environ.get("N5_LLM_ENGINE", str(HOME / "n5-llm/build/llama.cpp/build/bin/llama-server")))
GPU_LOCK = Path(os.environ.get("N5_LLM_GPU_LOCK", "/home/labuser/.gpu.lock"))
CONTEXT = int(os.environ.get("N5_LLM_CONTEXT", "1048576"))
# The context the model was trained to; past it the RoPE positions are stretched with YaRN by the ratio.
TRAINED_CONTEXT = 262144
# The KV store is kept in host memory, where the full context's fits in this type beside everything
# else a node holds (docs/n5-llm.md, 「The KV store in host memory」).
KV_TYPE = os.environ.get("N5_LLM_KV_TYPE", "q4_0")
MTP = os.environ.get("N5_LLM_MTP", "on") != "off"
DRAFT_TOKENS = int(os.environ.get("N5_LLM_DRAFT_TOKENS", "2"))
# The FFN weights of this many of the model's last main blocks stay in host memory and are computed by
# the CPU. The served file fits the card whole, so none do; a file that does not fit raises it until
# the card keeps room for a request.
CPU_FFN_BLOCKS = int(os.environ.get("N5_LLM_CPU_FFN_BLOCKS", "0"))
THREADS = int(os.environ.get("N5_LLM_THREADS", "8"))
# The model's main blocks, numbered from 0; its MTP block comes after them and stays on the card.
MAIN_BLOCKS = 64
# Where the engine saves its slot and restores it from (docs/n5-llm.md, 「The slot's state between
# engines」). The installer makes it.
SLOT_DIR = Path(os.environ.get("N5_LLM_SLOT_DIR", str(HOME / "n5-llm/slots")))

# Another service's single use of the card is seconds; past this the card is taken for longer than a
# caller should be kept waiting on it.
LOCK_WAIT_S = float(os.environ.get("N5_LLM_LOCK_WAIT_S", "60"))
# The engine reaches its health in about nine seconds, most of it allocating the KV store of the whole
# context; this only bounds a start that hangs.
START_WAIT_S = float(os.environ.get("N5_LLM_START_WAIT_S", "120"))
STOP_WAIT_S = 10.0
# Taking the slot back to its last prompt costs one token where the engine's checkpoint is there; past
# this it is computing a prompt it does not hold, and is hung up on rather than holding up the stop.
REWIND_WAIT_S = float(os.environ.get("N5_LLM_REWIND_WAIT_S", "10"))
# A save of the whole context's state is about 18 GiB; this only bounds one that hangs.
SLOT_WAIT_S = 600.0
POLL_S = 0.05
LOG_TAIL_BYTES = 8192

OPEN_PATHS = frozenset({"/health"})
PASSED_PATHS = frozenset({"/v1/chat/completions", "/v1/completions"})


def say(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def engine_argv() -> list[str]:
    """The engine as the unit runs it (docs/n5-llm.md, 「The engine」)."""
    argv = [
        str(ENGINE_BIN), "-m", str(MODEL), "--host", "127.0.0.1", "--port", str(ENGINE_PORT),
        "-ngl", "99", "-fa", "on", "--fit", "off", "-c", str(CONTEXT), "-ctk", KV_TYPE, "-ctv", KV_TYPE,
        "--no-kv-offload", "-np", "1", "--no-warmup", "-t", str(THREADS), "--slot-save-path", f"{SLOT_DIR}/",
    ]
    if CONTEXT > TRAINED_CONTEXT:
        argv += ["--rope-scaling", "yarn", "--rope-scale", f"{CONTEXT / TRAINED_CONTEXT:g}",
                 "--yarn-orig-ctx", str(TRAINED_CONTEXT)]
    if CPU_FFN_BLOCKS > 0:
        blocks = "|".join(str(block) for block in range(MAIN_BLOCKS - CPU_FFN_BLOCKS, MAIN_BLOCKS))
        argv += ["-ot", f"blk\\.({blocks})\\.ffn_(up|gate|down)\\.weight=CPU"]
    if MTP:
        argv += ["--spec-type", "draft-mtp", "--spec-draft-n-max", str(DRAFT_TOKENS)]
    return argv


class LockedFile:
    """The model file mapped and every page of it locked in RAM, for as long as the process runs. The
    engine maps the same file, so its start reads these pages rather than the disk."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.size = path.stat().st_size
        self.locked = 0
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        libc.mmap.restype = ctypes.c_void_p
        libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
        libc.mlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        fd = os.open(path, os.O_RDONLY)
        try:
            address = libc.mmap(None, self.size, mmap.PROT_READ, mmap.MAP_SHARED, fd, 0)
        finally:
            os.close(fd)
        if address in (None, ctypes.c_void_p(-1).value):
            raise OSError(ctypes.get_errno(), f"mmap of {path} failed")
        if libc.mlock(ctypes.c_void_p(address), ctypes.c_size_t(self.size)) != 0:
            errno = ctypes.get_errno()
            raise OSError(errno, f"mlock of {self.size} bytes failed: {os.strerror(errno)} (the memlock limit, docs/n5-llm.md)")
        self.locked = self.size


# A slot file as llama.cpp writes it: its magic, its version and the count of the 32-bit words the
# server packs the slot's tokens in, then those words (a null token, the packing's version, the token
# count and the tokens), and after them the state, which is the engine's alone to read.
STATE_MAGIC = 0x67677371
TOKENS_PACKING = 1
# How many of a prompt's last tokens the saved state leaves off: the opening of the generation prompt,
# which a conversation's next request renders its own way.
LEFT_OFF_TOKENS = 3
SAVING = "saving.bin"
JSON = {"content-type": "application/json"}


def pack(tokens: list[int]) -> bytes:
    """Token ids as the bytes they are compared in, so one sequence beginning another is one bytes
    value beginning the other."""
    return struct.pack(f"<{len(tokens)}i", *tokens)


def held_tokens(path: Path) -> bytes | None:
    """The tokens a slot file holds, read from its head alone; None for a file that is not one."""
    try:
        with path.open("rb") as file:
            magic, _version, words = struct.unpack("<III", file.read(12))
            if magic != STATE_MAGIC or words < 3:
                return None
            null, packing, count = struct.unpack("<iII", file.read(12))
            if null != -1 or packing != TOKENS_PACKING or count > words - 3:
                return None
            tokens = file.read(4 * count)
    except (OSError, struct.error):
        return None
    return tokens if len(tokens) == 4 * count else None


@dataclass
class SlotStore:
    """The slot's state between engines (docs/n5-llm.md, 「The slot's state between engines」): the
    tokens the engine makes of a request's prompt, the saved state that prompt goes on from loaded
    after a start, and the slot taken back to its last prompt and saved before a stop. A failure is
    logged and passed over, so the request is answered as if there were no file."""

    folder: Path
    upstream: str
    rewind_wait_s: float = REWIND_WAIT_S
    last_save: dict[str, Any] | None = None
    last_restore: dict[str, Any] | None = None

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.upstream, timeout=timeout)

    def _files(self) -> list[Path]:
        return [file for file in sorted(self.folder.glob("*.bin")) if file.name != SAVING]

    async def prompt(self, path: str, body: bytes) -> bytes | None:
        """The tokens the engine makes of a request's prompt, rendered through its chat template for a
        chat request. None where the request carries no one prompt."""
        try:
            asked = json.loads(body)
            async with self._client(30.0) as client:
                if path == "/v1/chat/completions":
                    rendered = (await client.post("/apply-template", content=body, headers=JSON)).raise_for_status().json()["prompt"]
                elif isinstance(asked.get("prompt"), str):
                    rendered = asked["prompt"]
                elif isinstance(asked.get("prompt"), list) and all(isinstance(token, int) for token in asked["prompt"]):
                    return pack(asked["prompt"])
                else:
                    return None
                tokenised = await client.post("/tokenize", json={"content": rendered, "add_special": True})
                return pack(tokenised.raise_for_status().json()["tokens"])
        except Exception as fault:
            say(f"slot: the prompt's tokens were not had: {type(fault).__name__}")
            return None

    async def restore(self, prompt: bytes) -> None:
        """Loads the longest file the prompt carries whole at its start and goes on past."""
        chosen, chosen_tokens = None, b""
        for file in self._files():
            tokens = held_tokens(file)
            if tokens and len(chosen_tokens) < len(tokens) < len(prompt) and prompt.startswith(tokens):
                chosen, chosen_tokens = file, tokens
        if chosen is None:
            return
        try:
            async with self._client(SLOT_WAIT_S) as client:
                done = (await client.post("/slots/0?action=restore", json={"filename": chosen.name})).raise_for_status().json()
            self.last_restore = {"tokens": done["n_restored"], "bytes": done["n_read"], "ms": round(done["timings"]["restore_ms"])}
            say(f"slot loaded: {self.last_restore['tokens']} tokens, {self.last_restore['bytes']} bytes in {self.last_restore['ms']} ms")
        except Exception as fault:
            say(f"slot: loading {chosen.name} failed: {type(fault).__name__}: {fault}")

    async def save(self, prompt: bytes | None) -> None:
        """Takes the slot back to the prompt without its last tokens, saves it, names the file by the
        tokens it holds and removes the files it goes on from."""
        try:
            if prompt is not None and len(prompt) > 4 * LEFT_OFF_TOKENS:
                await self._rewind(prompt[:-4 * LEFT_OFF_TOKENS])
            saving = self.folder / SAVING
            async with self._client(SLOT_WAIT_S) as client:
                done = (await client.post("/slots/0?action=save", json={"filename": SAVING})).raise_for_status().json()
            tokens = held_tokens(saving)
            if not tokens:
                saving.unlink(missing_ok=True)
                return
            for file in self._files():
                earlier = held_tokens(file)
                if earlier is not None and tokens.startswith(earlier):
                    file.unlink(missing_ok=True)
            saving.rename(self.folder / f"{hashlib.sha256(tokens).hexdigest()[:16]}.bin")
            self.last_save = {"tokens": done["n_saved"], "bytes": done["n_written"], "ms": round(done["timings"]["save_ms"])}
            say(f"slot saved: {self.last_save['tokens']} tokens, {self.last_save['bytes']} bytes in {self.last_save['ms']} ms")
        except Exception as fault:
            say(f"slot: saving failed: {type(fault).__name__}: {fault}")

    async def _rewind(self, tokens: bytes) -> None:
        """The slot taken back to these tokens by sending them with nothing to generate. Where that
        costs more than the checkpoint's one token, the engine is hung up on and keeps what it had
        computed by then."""
        ids = list(struct.unpack(f"<{len(tokens) // 4}i", tokens))
        try:
            async with self._client(self.rewind_wait_s) as client:
                (await client.post("/completion", json={"prompt": ids, "n_predict": 0, "cache_prompt": True})).raise_for_status()
        except httpx.TimeoutException:
            say(f"slot: going back took longer than {self.rewind_wait_s:g} s; the slot is saved as it stands")

    def health(self) -> dict[str, Any]:
        # A save may remove a file between the listing and its size.
        sizes = [file.stat().st_size for file in self._files() if file.exists()]
        return {"files": len(sizes), "bytes": sum(sizes),
                "last_save": self.last_save, "last_restore": self.last_restore}


@dataclass
class CardBusy(Exception):
    reason: str


@dataclass
class Engine:
    """The engine process and the card lock, held from the first request in hand to the end of the
    last."""

    argv: list[str]
    lock_path: Path
    health_url: str
    lock_wait_s: float = LOCK_WAIT_S
    start_wait_s: float = START_WAIT_S
    slots: SlotStore | None = None
    users: int = 0
    state: str = "stopped"
    last_start_ms: float | None = None
    last_stop_ms: float | None = None
    proc: asyncio.subprocess.Process | None = None
    lock_fd: int | None = None
    draining: asyncio.Task[None] | None = None
    log_tail: bytes = b""
    # The tokens of the last request to come in, which is the last the one slot answers.
    prompt: bytes | None = None
    mutex: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def enter(self, asked: tuple[str, bytes] | None = None) -> None:
        """One more request in hand, given as its path and body; the engine running once this returns,
        with the saved state its prompt goes on from loaded where it has just started."""
        async with self.mutex:
            self.users += 1
            try:
                fresh = self.proc is None
                if fresh:
                    await self._start()
                if self.slots is not None and asked is not None:
                    self.prompt = await self.slots.prompt(*asked)
                    if fresh and self.prompt is not None:
                        await self.slots.restore(self.prompt)
            except BaseException:
                with anyio.CancelScope(shield=True):
                    self.users -= 1
                    if self.users == 0 and self.proc is not None:
                        await self._stop()
                raise

    async def leave(self) -> None:
        """One request fewer; when it was the last, the slot's state saved, the engine stopped and the
        lock let go. A caller that went away cancels the request's task, so this runs shielded from
        that cancellation and always reaches its end."""
        with anyio.CancelScope(shield=True):
            async with self.mutex:
                self.users -= 1
                if self.users == 0 and self.proc is not None:
                    if self.slots is not None:
                        self.state = "saving the slot"
                        await self.slots.save(self.prompt)
                    self.prompt = None
                    await self._stop()

    async def _take_lock(self) -> None:
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o666)
        deadline = time.monotonic() + self.lock_wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.lock_fd = fd
                return
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise CardBusy("the card lock stayed held by another service")
                await asyncio.sleep(POLL_S)

    def _let_go(self) -> None:
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    async def _start(self) -> None:
        began = time.monotonic()
        self.state = "waiting for the card lock"
        try:
            await self._take_lock()
        except BaseException:
            self.state = "stopped"
            raise
        self.state = "starting"
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE, start_new_session=True)
            self._read_log()
            await self._wait_healthy()
        except BaseException:
            with anyio.CancelScope(shield=True):
                await self._stop()
            raise
        self.state = "running"
        self.last_start_ms = (time.monotonic() - began) * 1000
        say(f"engine started in {self.last_start_ms:.0f} ms")

    async def _wait_healthy(self) -> None:
        assert self.proc is not None
        deadline = time.monotonic() + self.start_wait_s
        async with httpx.AsyncClient(timeout=1.0) as client:
            while True:
                if self.proc.returncode is not None:
                    if self.draining is not None:
                        await self.draining
                    said = self.log_tail.decode(errors="replace")
                    if "out of memory" in said:
                        raise CardBusy("the card had no room for the model")
                    tail = said.strip().splitlines()[-3:]
                    raise RuntimeError(f"the engine exited with {self.proc.returncode}: {' | '.join(tail)}")
                try:
                    if (await client.get(self.health_url)).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("the engine did not come up in time")
                await asyncio.sleep(POLL_S)

    def _read_log(self) -> None:
        """The engine's log read for as long as it runs, so a full pipe never stalls it, and only its
        last few kilobytes kept, for saying why a start failed. Nothing of it reaches the journal."""
        stream = self.proc.stderr if self.proc is not None else None
        self.log_tail = b""

        async def read() -> None:
            while stream is not None and (chunk := await stream.read(65536)):
                self.log_tail = (self.log_tail + chunk)[-LOG_TAIL_BYTES:]

        self.draining = asyncio.get_running_loop().create_task(read())

    async def _stop(self) -> None:
        began = time.monotonic()
        self.state = "stopping"
        proc, self.proc = self.proc, None
        if proc is not None and proc.returncode is None:
            proc.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), STOP_WAIT_S)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        self._let_go()
        self.state = "stopped"
        self.last_stop_ms = (time.monotonic() - began) * 1000
        if proc is not None:
            say(f"engine stopped in {self.last_stop_ms:.0f} ms")

    def health(self) -> dict[str, Any]:
        return {
            "engine": self.state,
            "in_hand": self.users,
            "lock_held": self.lock_fd is not None,
            "last_start_ms": self.last_start_ms,
            "last_stop_ms": self.last_stop_ms,
            "slots": self.slots.health() if self.slots is not None else None,
        }


class KeyGate:
    """Every request but the open path carries the service key as a bearer token. A refusal is a bare
    401 that repeats nothing of what was sent."""

    def __init__(self, app: ASGIApp, key: str) -> None:
        self.app = app
        self.expected = f"Bearer {key}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in OPEN_PATHS:
            await self.app(scope, receive, send)
            return
        given = next((value for name, value in scope["headers"] if name == b"authorization"), b"")
        if hmac.compare_digest(given, self.expected):
            await self.app(scope, receive, send)
            return
        await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)


class Relay(StreamingResponse):
    """A streamed answer that ends its request however the stream ends: whole, cut off by the caller,
    or never begun because the caller had already gone."""

    def __init__(self, content: AsyncIterator[bytes], ending: Callable[[], Awaitable[None]], **options: Any) -> None:
        super().__init__(content, **options)
        self.ending = ending

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.ending()


def error(status: int, message: str, kind: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": kind, "code": status}}, status_code=status)


def build_app(key: str, engine: Engine, upstream: str, model: Path, locked: LockedFile | None,
              settings: dict[str, Any]) -> ASGIApp:
    """The whole front as one ASGI app, so a test serves exactly what the unit serves."""
    model_id = model.name.removesuffix(".gguf")
    expected = f"Bearer {key}".encode()
    client = httpx.AsyncClient(base_url=upstream, timeout=httpx.Timeout(None, connect=5.0))

    async def health(request: Request) -> Response:
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), expected):
            return JSONResponse({"status": "ok"})
        return JSONResponse({
            "status": "ok",
            "model": model.name,
            "model_bytes": locked.size if locked else None,
            "locked_bytes": locked.locked if locked else 0,
            **engine.health(),
            "settings": settings,
        })

    async def models(_: Request) -> Response:
        return JSONResponse({"object": "list", "data": [
            {"id": model_id, "object": "model", "created": int(model.stat().st_mtime) if model.exists() else 0, "owned_by": "n5"},
        ]})

    async def passed(request: Request) -> Response:
        body = await request.body()
        try:
            await engine.enter((request.url.path, body))
        except CardBusy as busy:
            return error(503, f"card busy: {busy.reason}", "card_busy")
        except (RuntimeError, OSError) as fault:
            say(f"engine failed to start: {fault}")
            return error(503, "the engine failed to start", "engine_unavailable")

        left = False

        async def leave(answer: httpx.Response | None) -> None:
            nonlocal left
            with anyio.CancelScope(shield=True):
                if answer is not None:
                    await answer.aclose()
                if not left:
                    left = True
                    await engine.leave()

        headers = {"content-type": request.headers.get("content-type", "application/json")}
        try:
            upstream_request = client.build_request(request.method, request.url.path, content=body, headers=headers)
            answer = await client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            await leave(None)
            return error(503, "the engine did not answer", "engine_unavailable")
        except BaseException:
            await leave(None)
            raise

        if not answer.headers.get("content-type", "").startswith("text/event-stream"):
            try:
                content = await read_while_connected(request, answer)
            finally:
                await leave(answer)
            if content is None:
                return Response(status_code=499)
            return Response(content, status_code=answer.status_code, media_type=answer.headers.get("content-type"))

        return Relay(answer.aiter_raw(), lambda: leave(answer), status_code=answer.status_code,
                     media_type="text/event-stream")

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    async with engine.mutex:
                        await engine._stop()
                    await client.aclose()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        request = Request(scope, receive)
        path = scope["path"]
        if path == "/health":
            response = await health(request)
        elif path == "/v1/models" and request.method == "GET":
            response = await models(request)
        elif path in PASSED_PATHS and request.method == "POST":
            response = await passed(request)
        else:
            response = error(404, "not found", "not_found")
        await response(scope, receive, send)

    return KeyGate(app, key)


async def read_while_connected(request: Request, answer: httpx.Response) -> bytes | None:
    """The engine's whole answer, or None where the caller went away first, in which case the engine
    is hung up on so it stops generating for nobody."""
    reading = asyncio.ensure_future(answer.aread())
    watching = asyncio.ensure_future(wait_disconnect(request))
    done, _ = await asyncio.wait({reading, watching}, return_when=asyncio.FIRST_COMPLETED)
    if reading in done:
        watching.cancel()
        return reading.result()
    reading.cancel()
    return None


async def wait_disconnect(request: Request) -> None:
    while not await request.is_disconnected():
        await asyncio.sleep(0.5)


def main() -> int:
    key = os.environ.get("LLM_KEY", "")
    if key == "":
        say("front: LLM_KEY is not set")
        return 2
    locked = LockedFile(MODEL)
    say(f"front: {locked.locked} bytes of {MODEL.name} locked in RAM")
    upstream = f"http://127.0.0.1:{ENGINE_PORT}"
    engine = Engine(engine_argv(), GPU_LOCK, f"{upstream}/health", slots=SlotStore(SLOT_DIR, upstream))
    settings = {"context": CONTEXT, "kv_cache": f"{KV_TYPE} in host memory", "mtp": MTP, "draft_tokens": DRAFT_TOKENS if MTP else 0,
                "cpu_ffn_blocks": CPU_FFN_BLOCKS, "threads": THREADS}
    app = build_app(key, engine, upstream, MODEL, locked, settings)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
