import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { waitForDaemonListening } from "./wait-for-socket";

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ready-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const listen = async (socketPath: string): Promise<net.Server> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
};

const close = (server: net.Server): Promise<void> =>
  new Promise<void>((resolve) => server.close(() => resolve()));

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

  it("stops waiting when the caller's timeout expires", () =>
    withTempDir(async (dir) => {
      const result = await Effect.runPromise(
        waitForDaemonListening(join(dir, "never.sock")).pipe(Effect.timeoutOption(0)),
      );

      expect(result._tag).toBe("None");
    }));
});
