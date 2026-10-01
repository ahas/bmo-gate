"""A card the text model's engine borrows over the network (docs/n5-llm.md, 「The cards it borrows」).
One process on the node's address on the inner network, which holds nothing while nobody asks. The
head's front opens one connection and asks for the card with the service key; this takes the node's
card lock where the node has one, starts llama.cpp's rpc-server on the card and says READY, and keeps
both for as long as that connection stays open. When it closes, however it closes, the rpc-server is
stopped, which empties the card, and the lock is let go.

Run: LLM_KEY and CARD_ADDRESS come from the unit's settings file; python card.py
"""

from __future__ import annotations

import asyncio
import fcntl
import hmac
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path

HOME = Path.home()
# The ports the head reaches on the inner network: this process's, and the rpc-server's while a hold
# stands.
HOLD_PORT = 50051
RPC_PORT = 50052
RPC_BIN = Path(os.environ.get("N5_LLM_RPC", str(HOME / "n5-llm/build/llama.cpp/build/bin/ggml-rpc-server")))
# The tensors the head has sent before are read from here rather than over the network again.
RPC_CACHE = Path(os.environ.get("N5_LLM_RPC_CACHE", str(HOME / "n5-llm/rpc-cache")))
# This card's pieces of the head's saved slot states (docs/n5-llm.md, 「The slot's state between
# engines」).
PIECES = Path(os.environ.get("N5_LLM_SLOT_DIR", str(HOME / "n5-llm/slots")))
# A node whose card is taken in turns by one lock names it; a node whose card is shared some other
# way names none, and the hold takes the card as it is.
LOCK_WAIT_S = float(os.environ.get("N5_LLM_LOCK_WAIT_S", "60"))
START_WAIT_S = 30.0
STOP_WAIT_S = 10.0
ASK_WAIT_S = 10.0
POLL_S = 0.05


def say(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


@dataclass
class Refused(Exception):
    answer: str


class Card:
    """The card held for one connection at a time, and the slot pieces its rpc-server keeps."""

    def __init__(self, key: str, address: str, lock_path: Path | None, rpc_argv: list[str], pieces: Path,
                 lock_wait_s: float = LOCK_WAIT_S, start_wait_s: float = START_WAIT_S, rpc_port: int = RPC_PORT) -> None:
        self.key = key.encode()
        self.address = address
        self.lock_path = lock_path
        self.rpc_argv = rpc_argv
        self.pieces = pieces
        self.lock_wait_s = lock_wait_s
        self.start_wait_s = start_wait_s
        self.rpc_port = rpc_port
        self.held = False

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """`HOLD <key>` holds the card for as long as the connection stays open; `DROP <key> <file>…`
        removes the pieces of those slot files."""
        try:
            asked = await asyncio.wait_for(reader.readline(), ASK_WAIT_S)
        except (asyncio.TimeoutError, ConnectionError):
            writer.close()
            return
        verb, _, rest = asked.strip().partition(b" ")
        key, _, names = rest.partition(b" ")
        if not hmac.compare_digest(key, self.key) or verb not in (b"HOLD", b"DROP"):
            await self._answer(writer, "REFUSED")
            return
        if verb == b"DROP":
            await self._answer(writer, f"DROPPED {self.drop(names.decode(errors='replace').split())}")
            return
        if self.held:
            await self._answer(writer, "BUSY the card is already held")
            return
        self.held = True
        lock_fd: int | None = None
        proc: asyncio.subprocess.Process | None = None
        began = time.monotonic()
        try:
            lock_fd = await self._take_lock()
            proc = await self._start()
            writer.write(b"READY\n")
            await writer.drain()
            say(f"card held: ready in {(time.monotonic() - began) * 1000:.0f} ms")
            await self._until_let_go(reader, proc)
        except Refused as refused:
            await self._answer(writer, refused.answer)
        except (ConnectionError, OSError) as fault:
            say(f"card: the hold ended on {type(fault).__name__}: {fault}")
        finally:
            await self._stop(proc)
            if lock_fd is not None:
                os.close(lock_fd)
            self.held = False
            writer.close()
            say(f"card let go after {time.monotonic() - began:.1f} s")

    def drop(self, files: list[str]) -> int:
        """The pieces of the named slot files removed: each piece is its file's name, a dot and its
        number. A name that is not a plain file name is passed over."""
        prefixes = tuple(f"{name}." for name in files if not name.startswith(".") and "/" not in name)
        removed = 0
        for piece in list(self.pieces.iterdir()) if prefixes else []:
            if piece.name.startswith(prefixes):
                piece.unlink(missing_ok=True)
                removed += 1
        return removed

    async def _answer(self, writer: asyncio.StreamWriter, answer: str) -> None:
        try:
            writer.write(f"{answer}\n".encode())
            await writer.drain()
        except ConnectionError:
            pass
        writer.close()

    async def _take_lock(self) -> int | None:
        if self.lock_path is None:
            return None
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o666)
        deadline = time.monotonic() + self.lock_wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise Refused("BUSY the card lock stayed held by another service")
                await asyncio.sleep(POLL_S)

    async def _start(self) -> asyncio.subprocess.Process:
        proc = await asyncio.create_subprocess_exec(
            *self.rpc_argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + self.start_wait_s
        while True:
            if proc.returncode is not None:
                raise Refused(f"FAILED the rpc-server exited with {proc.returncode}")
            try:
                _, probe = await asyncio.open_connection(self.address, self.rpc_port)
                probe.close()
                return proc
            except OSError:
                pass
            if time.monotonic() >= deadline:
                await self._stop(proc)
                raise Refused("FAILED the rpc-server did not come up in time")
            await asyncio.sleep(POLL_S)

    async def _until_let_go(self, reader: asyncio.StreamReader, proc: asyncio.subprocess.Process) -> None:
        """Until the head closes its connection, or the rpc-server ends under it."""

        async def closed() -> None:
            while await reader.read(4096):
                pass

        watching = [asyncio.ensure_future(closed()), asyncio.ensure_future(proc.wait())]
        _, pending = await asyncio.wait(watching, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        if proc.returncode is not None:
            say(f"card: the rpc-server exited with {proc.returncode} while held")

    async def _stop(self, proc: asyncio.subprocess.Process | None) -> None:
        if proc is None or proc.returncode is not None:
            return
        proc.send_signal(signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), STOP_WAIT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()


def rpc_argv(address: str) -> list[str]:
    return [str(RPC_BIN), "-H", address, "-p", str(RPC_PORT), "-c"]


async def main_async(card: Card, address: str) -> None:
    server = await asyncio.start_server(card.serve, address, HOLD_PORT)
    say(f"card: waiting on {address}:{HOLD_PORT}")
    async with server:
        await server.serve_forever()


def main() -> int:
    key = os.environ.get("LLM_KEY", "")
    address = os.environ.get("CARD_ADDRESS", "")
    if key == "" or address == "":
        say("card: LLM_KEY and CARD_ADDRESS must be set")
        return 2
    lock = os.environ.get("CARD_LOCK", "")
    RPC_CACHE.mkdir(parents=True, exist_ok=True)
    PIECES.mkdir(parents=True, exist_ok=True)
    # llama.cpp keeps the rpc-server's tensor cache under LLAMA_CACHE, and the patched rpc-server writes
    # and reads its slot pieces under GGML_RPC_STATE_DIR.
    os.environ["LLAMA_CACHE"] = str(RPC_CACHE)
    os.environ["GGML_RPC_STATE_DIR"] = str(PIECES)
    card = Card(key, address, Path(lock) if lock else None, rpc_argv(address), PIECES)
    asyncio.run(main_async(card, address))
    return 0


if __name__ == "__main__":
    sys.exit(main())
