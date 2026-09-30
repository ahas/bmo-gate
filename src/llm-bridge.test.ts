import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bearerMatches, readDoorKeys, readServiceKey, startBridge } from "./llm-bridge";
import { scratchDir } from "./scratch";

import type { Server, TCPSocketListener } from "bun";

// The tunnel's door on main-host: a WebSocket is taken only with the key of a service in the door's
// list as its bearer, and then carries bytes both ways to the TCP target it stands in front of — here
// an echo in place of SSH.

const key = "a".repeat(64);
const otherKey = "c".repeat(64);
let bridge: Server<unknown> | null = null;
let echo: TCPSocketListener<undefined> | null = null;

afterEach(() => {
  bridge?.stop(true);
  echo?.stop(true);
  bridge = null;
  echo = null;
});

function keyFile(mode = 0o600, text = key): string {
  const path = join(scratchDir("bmo-llm-bridge-"), "service.key");
  writeFileSync(path, `${text}\n`);
  chmodSync(path, mode);
  return path;
}

function doorList(...keyPaths: string[]): string {
  const path = join(scratchDir("bmo-llm-bridge-"), "tunnel-door.keys");
  writeFileSync(path, keyPaths.map((one) => `${one}\n`).join(""));
  return path;
}

function stand(...keyPaths: string[]): string {
  echo = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, chunk) { socket.write(chunk); } } });
  bridge = startBridge({ hostname: "127.0.0.1", port: 0, doorListPath: doorList(...keyPaths), target: { hostname: "127.0.0.1", port: echo.port } }) as Server<unknown>;
  return `127.0.0.1:${bridge.port}`;
}

describe("the key the bridge asks for", () => {
  test("is read only from a 0600 file", () => {
    expect(readServiceKey(keyFile())).toBe(key);
    expect(readServiceKey(keyFile(0o644))).toBeNull();
    expect(readServiceKey("/nonexistent/n6.key")).toBeNull();
  });

  test("is any key the door's list names, and none where the list is missing", () => {
    expect(readDoorKeys(doorList(keyFile(), "/nonexistent/n5.key", keyFile(0o600, otherKey)))).toEqual([key, otherKey]);
    expect(readDoorKeys("/nonexistent/tunnel-door.keys")).toEqual([]);
  });

  test("is matched whole as a bearer", () => {
    expect(bearerMatches(`Bearer ${key}`, key)).toBe(true);
    expect(bearerMatches(`Bearer ${key.slice(1)}`, key)).toBe(false);
    expect(bearerMatches(key, key)).toBe(false);
    expect(bearerMatches(null, key)).toBe(false);
    expect(bearerMatches(`Bearer ${key}`, null)).toBe(false);
  });
});

describe("the bridge", () => {
  test("refuses without the key, with a wrong one, and where the key file is loose, saying nothing more", async () => {
    const at = stand(keyFile());

    const refusals: Record<string, string>[] = [{}, { authorization: `Bearer ${"b".repeat(64)}` }];
    for (const headers of refusals) {
      const answer = await fetch(`http://${at}/`, { headers });
      expect(answer.status).toBe(401);
      expect(await answer.text()).toBe("unauthorized\n");
    }

    bridge!.stop(true);
    echo!.stop(true);
    const loose = stand(keyFile(0o644));
    expect((await fetch(`http://${loose}/`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });

  test("asks for an upgrade from a request that has any listed service's key and is no WebSocket", async () => {
    const at = stand(keyFile(), keyFile(0o600, otherKey));
    expect((await fetch(`http://${at}/`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(426);
    expect((await fetch(`http://${at}/`, { headers: { authorization: `Bearer ${otherKey}` } })).status).toBe(426);
  });

  test("carries bytes both ways between the WebSocket and its target", async () => {
    const at = stand(keyFile());
    const socket = new WebSocket(`ws://${at}/`, { headers: { authorization: `Bearer ${key}` } } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const heard = new Promise<string>((resolve, reject) => {
      socket.onmessage = (event) => resolve(new TextDecoder().decode(event.data as ArrayBuffer));
      socket.onerror = () => reject(new Error("socket error"));
    });
    await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
    socket.send(new TextEncoder().encode("SSH-2.0-check\r\n"));

    expect(await heard).toBe("SSH-2.0-check\r\n");
    socket.close();
  });
});
