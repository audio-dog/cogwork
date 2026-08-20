import { beforeEach, describe, expect, it, vi } from "vitest";

const { waitMock, isDaemonListeningMock } = vi.hoisted(() => ({
  waitMock: vi.fn<(delay: number, options?: { signal?: AbortSignal }) => Promise<void>>(),
  isDaemonListeningMock: vi.fn<(socketPath: string) => Promise<boolean>>(),
}));

vi.mock("node:timers/promises", () => ({
  scheduler: { wait: waitMock },
}));

vi.mock("./socket-probe", () => ({
  isDaemonListening: isDaemonListeningMock,
}));

import { waitForDaemonListening } from "./wait-for-socket";

const deferred = <T>() => {
  const box: { resolve: (value: T) => void } = { resolve: () => {} };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T) => box.resolve(value) };
};

describe("waitForDaemonListening", () => {
  beforeEach(() => {
    isDaemonListeningMock.mockReset();
    waitMock.mockReset();
  });

  it("resolves true when the socket is already listening", async () => {
    const controller = new AbortController();
    isDaemonListeningMock.mockResolvedValueOnce(true);

    await expect(waitForDaemonListening("/tmp/live.sock", controller.signal)).resolves.toBe(true);
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("resolves once a probe succeeds after waiting", async () => {
    const controller = new AbortController();
    isDaemonListeningMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    waitMock.mockResolvedValueOnce();

    await expect(waitForDaemonListening("/tmp/late.sock", controller.signal)).resolves.toBe(true);
    expect(waitMock).toHaveBeenCalledOnce();
    expect(waitMock).toHaveBeenCalledWith(50, { signal: controller.signal });
  });

  it("resolves false when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForDaemonListening("/tmp/never.sock", controller.signal)).resolves.toBe(false);
    expect(isDaemonListeningMock).not.toHaveBeenCalled();
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("resolves false when aborted during a successful probe", async () => {
    const controller = new AbortController();
    const probe = deferred<boolean>();
    isDaemonListeningMock.mockReturnValueOnce(probe.promise);

    const waiting = waitForDaemonListening("/tmp/live.sock", controller.signal);
    controller.abort();
    probe.resolve(true);

    await expect(waiting).resolves.toBe(false);
    expect(waitMock).not.toHaveBeenCalled();
  });
});
