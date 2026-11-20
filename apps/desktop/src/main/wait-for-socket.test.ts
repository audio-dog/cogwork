import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { waitForDaemonListening } from "./wait-for-socket";

const withTempDir = async (run: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ready-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const listen = async (socketPath: string) => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
};

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("waitForDaemonListening", () => {
  it("resolves true when the socket is already listening", () =>
    withTempDir(async (dir) => {
      const server = await listen(join(dir, "live.sock"));
      try {
        expect(await Effect.runPromise(waitForDaemonListening(join(dir, "live.sock")))).toBe(true);
      } finally {
        await close(server);
      }
    }));

  it("resolves once a server binds the socket after the wait begins", () =>
    withTempDir(async (dir) => {
      const socketPath = join(dir, "late.sock");
      const [listening, server] = await Promise.all([
        Effect.runPromise(waitForDaemonListening(socketPath)),
        listen(socketPath),
      ]);
      try {
        expect(listening).toBe(true);
      } finally {
        await close(server);
      }
    }));

  it.effect("fails with a typed timeout when the socket never listens", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "cf-ready-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const waiting = yield* Effect.forkChild(waitForDaemonListening(join(dir, "never.sock")));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");

      const error = yield* Fiber.join(waiting).pipe(Effect.flip);

      assert.strictEqual(error._tag, "DaemonReachabilityError");
      assert.strictEqual(error.deadline, "10 seconds");
    }),
  );
});
