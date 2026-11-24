import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Scope } from "effect";
import { expect, it } from "vitest";

import { createDaemonBridgePort } from "./daemon-bridge";

it("relays opaque frames and closes the socket with its owning scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-bridge-"));
  const socketPath = join(dir, "daemon.sock");
  const connection = Promise.withResolvers<net.Socket>();
  const received = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  const server = net.createServer((socket) => {
    connection.resolve(socket);
    socket.once("data", (chunk) => received.resolve(chunk.toString()));
    socket.once("close", () => closed.resolve());
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const scope = await Effect.runPromise(Scope.make());

  try {
    const port = await Effect.runPromise(
      createDaemonBridgePort(socketPath, { onData: () => {}, onClosed: () => {} }).pipe(Scope.provide(scope)),
    );
    await Effect.runPromise(port.connect);
    await Effect.runPromise(port.send("opaque frame"));

    expect(await received.promise).toBe("opaque frame");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await closed.promise;
    expect((await connection.promise).destroyed).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it("interrupts a pending connection when its owning scope closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-bridge-"));
  const scope = await Effect.runPromise(Scope.make());

  try {
    const port = await Effect.runPromise(
      createDaemonBridgePort(join(dir, "missing.sock"), {
        onData: () => {},
        onClosed: () => {},
      }).pipe(Scope.provide(scope)),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));

    const exit = await Effect.runPromiseExit(port.connect);

    expect(Exit.hasInterrupts(exit)).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  }
});
