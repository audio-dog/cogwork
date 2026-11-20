import type { Event } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const callbacks: { willQuit?: (event: Event) => void } = {};
  const app = {
    on: vi.fn((_event: "will-quit", handler: (event: Event) => void) => {
      callbacks.willQuit = handler;
    }),
    quit: vi.fn(),
  };
  return { app, callbacks };
});

vi.mock("electron", () => ({ app: electron.app }));

import { app } from "electron";

import { installShutdownBeforeQuit } from "./quit";

const makeApp = () => {
  const requestQuit = () => {
    const event: Event = { preventDefault: vi.fn(), defaultPrevented: false };
    const handler = electron.callbacks.willQuit;
    if (!handler) throw new Error("Quit handler was not installed");
    handler(event);
    return event;
  };
  return { app, requestQuit };
};

beforeEach(() => {
  electron.callbacks.willQuit = undefined;
  electron.app.on.mockClear();
  electron.app.quit.mockClear();
});

it("waits for one shutdown before permitting quit", async () => {
  const shutdown = Promise.withResolvers<void>();
  const dispose = vi.fn(() => shutdown.promise);
  const { app, requestQuit } = makeApp();
  installShutdownBeforeQuit(app, dispose);

  const first = requestQuit();
  const repeated = requestQuit();

  expect(first.preventDefault).toHaveBeenCalledOnce();
  expect(repeated.preventDefault).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();

  shutdown.resolve();
  await shutdown.promise;
  await Promise.resolve();

  expect(app.quit).toHaveBeenCalledOnce();

  const resumed = requestQuit();
  expect(resumed.preventDefault).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(app.quit).toHaveBeenCalledOnce();
});

it("resumes quit when shutdown fails", async () => {
  const dispose = vi.fn(() => Promise.reject(new Error("shutdown failed")));
  const { app, requestQuit } = makeApp();
  installShutdownBeforeQuit(app, dispose);

  const event = requestQuit();

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();

  await Promise.resolve();
  await Promise.resolve();

  expect(app.quit).toHaveBeenCalledOnce();
});
