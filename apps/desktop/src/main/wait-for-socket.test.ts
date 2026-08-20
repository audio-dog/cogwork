import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      const controller = new AbortController();
      try {
        expect(await waitForDaemonListening(join(dir, "live.sock"), controller.signal)).toBe(true);
      } finally {
        controller.abort();
        await close(server);
      }
    }));

  it("resolves once a server binds the socket after the wait begins", () =>
    withTempDir(async (dir) => {
      const socketPath = join(dir, "late.sock");
      const controller = new AbortController();
      const waiting = waitForDaemonListening(socketPath, controller.signal);

      const server = await listen(socketPath);
      try {
        expect(await waiting).toBe(true);
      } finally {
        controller.abort();
        await close(server);
      }
    }));

  it("resolves false when aborted before the socket appears", () =>
    withTempDir(async (dir) => {
      const controller = new AbortController();
      const waiting = waitForDaemonListening(join(dir, "never.sock"), controller.signal);
      controller.abort();
      expect(await waiting).toBe(false);
    }));
});
