"""The tunnel's ProxyCommand on the service's node (docs/llm-server.md, 「The door」).

The node's network lets only HTTPS out, so ssh reaches the operations machine through this: it opens a WebSocket to the
URL it is given, with the service key from the environment as its bearer, and pipes its standard input
and output through it until either side ends. The key is never printed.
"""

import os
import sys
import threading

from websockets.sync.client import connect


def pipe(url: str, key: str) -> int:
    with connect(url, additional_headers={"Authorization": f"Bearer {key}"}, max_size=None, open_timeout=20) as ws:
        def upward() -> None:
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    ws.close()
                    return
                ws.send(chunk)

        threading.Thread(target=upward, daemon=True).start()
        for message in ws:
            os.write(1, message if isinstance(message, bytes) else message.encode())
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: ws-dial.py <wss-url>", file=sys.stderr)
        return 2
    key = os.environ.get("LLM_KEY", "")
    if key == "":
        print("ws-dial: LLM_KEY is not set", file=sys.stderr)
        return 2
    try:
        return pipe(sys.argv[1], key)
    except Exception as error:  # the reason, never the key
        print(f"ws-dial: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
