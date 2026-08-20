import { expect, it, vi } from "vitest";

const isDaemonListeningMock = vi.hoisted(() => vi.fn<(socketPath: string) => Promise<boolean>>());

vi.mock("./socket-probe", () => ({
  isDaemonListening: isDaemonListeningMock,
}));

import { waitForDaemonListening } from "./wait-for-socket";

it("gives abort precedence over a successful in-flight probe", async () => {
  const controller = new AbortController();
  const probe = Promise.withResolvers<boolean>();
  isDaemonListeningMock.mockReturnValueOnce(probe.promise);

  const waiting = waitForDaemonListening("/tmp/live.sock", controller.signal);
  controller.abort();
  probe.resolve(true);

  await expect(waiting).resolves.toBe(false);
});
