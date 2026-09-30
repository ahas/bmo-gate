import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import type { Server, ServerWebSocket, Socket } from "bun";

// The tunnel door on main-host (docs/llm-server.md, 「The door」). The nodes' network lets only HTTPS
// out, so a tunnel's SSH reaches main-host inside a WebSocket that NPM hands here; this takes one only
// when its bearer is the key of a service named in the door's list, and pipes it to main-host's own
// SSH. The list and the keys are read from their files for each connection and never kept, logged or
// answered with.

/** Where NPM forwards the tunnel's name to, and what the bridge pipes to. */
export const BRIDGE_PORT = 18022;
export const SSH_TARGET = { hostname: "127.0.0.1", port: 22 } as const;

export interface BridgeOptions {
  port?: number;
  hostname?: string;
  /** The door's list: one key file's path to a line. */
  doorListPath: string;
  target?: { hostname: string; port: number };
}

interface Pipe {
  socket: Socket<undefined> | null;
  // What arrived from the WebSocket before the TCP connection stood.
  held: Uint8Array[];
  closed: boolean;
}

/** The service key as the bridge reads it: a 0600 file, or nothing at all. */
export function readServiceKey(path: string): string | null {
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) {
      return null;
    }
    const key = readFileSync(path, "utf8").trim();
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

/** The keys of every service the door's list names, each read as a key file is; a list that is
 * missing names none. */
export function readDoorKeys(listPath: string): string[] {
  let listed: string[];
  try {
    listed = readFileSync(listPath, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch {
    return [];
  }
  return listed.map(readServiceKey).filter((key): key is string => key !== null);
}

/** Whether a request's bearer is the key, compared in constant time. */
export function bearerMatches(header: string | null, key: string | null): boolean {
  if (header === null || key === null || !header.startsWith("Bearer ")) {
    return false;
  }
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(key);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function bytes(message: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
  return typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message as ArrayBuffer);
}

export function startBridge(options: BridgeOptions): Server<Pipe> {
  const target = options.target ?? SSH_TARGET;

  return Bun.serve<Pipe>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? BRIDGE_PORT,
    fetch(request, server) {
      // A refusal says nothing about why, and repeats nothing of the request.
      const bearer = request.headers.get("authorization");
      if (!readDoorKeys(options.doorListPath).some((key) => bearerMatches(bearer, key))) {
        return new Response("unauthorized\n", { status: 401 });
      }
      if (server.upgrade(request, { data: { socket: null, held: [], closed: false } })) {
        return undefined;
      }
      return new Response("upgrade required\n", { status: 426 });
    },
    websocket: {
      async open(ws: ServerWebSocket<Pipe>) {
        try {
          const socket = await Bun.connect({
            hostname: target.hostname,
            port: target.port,
            socket: {
              data(_socket, chunk) {
                ws.sendBinary(chunk);
              },
              close() {
                ws.close();
              },
              error() {
                ws.close();
              },
            },
          });
          if (ws.data.closed) {
            socket.end();
            return;
          }
          ws.data.socket = socket;
          for (const chunk of ws.data.held.splice(0)) {
            socket.write(chunk);
          }
        } catch {
          ws.close();
        }
      },
      message(ws: ServerWebSocket<Pipe>, message) {
        const chunk = bytes(message);
        if (ws.data.socket === null) {
          ws.data.held.push(chunk);
        } else {
          ws.data.socket.write(chunk);
        }
      },
      close(ws: ServerWebSocket<Pipe>) {
        ws.data.closed = true;
        ws.data.socket?.end();
      },
    },
  });
}
