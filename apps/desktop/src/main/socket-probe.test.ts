import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { isDaemonListening } from "./socket-probe";

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "cf-probe-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("isDaemonListening", () => {
  it("returns true when a server is bound to the socket", () =>
    withTempDir(async (dir) => {
      const socketPath = join(dir, "live.sock");
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        expect(await Effect.runPromise(isDaemonListening(socketPath))).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));

  it("returns false when nothing is listening", () =>
    withTempDir(async (dir) => {
      expect(await Effect.runPromise(isDaemonListening(join(dir, "missing.sock")))).toBe(false);
    }));
});
